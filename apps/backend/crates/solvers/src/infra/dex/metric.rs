//! Direct, single-pool Metric v1 SELL routes on Robinhood. Router, quoter,
//! pools and tokens are pinned in `shared::metric`; the Metric API never
//! participates in quoting or execution.
use {
    crate::{
        domain::{dex, eth, order},
        infra::metrics,
    },
    alloy::{
        primitives::{Address, Bytes, U256},
        sol_types::SolCall,
    },
    ethrpc::block_context::{BlockContext, Error as RpcError, ReadOnlyRpc},
    shared::metric,
    std::time::{SystemTime, UNIX_EPOCH},
};

/// Router, pool swap, oracle read and three extensions; no quoter estimate.
const GAS: u64 = 350_000;

pub struct Config {
    pub node_url: reqwest::Url,
    pub settlement: Address,
}

pub struct Metric {
    settlement: Address,
    rpc: ReadOnlyRpc,
}

impl Metric {
    pub fn try_new(config: Config) -> Result<Self, RpcError> {
        Ok(Self {
            rpc: ReadOnlyRpc::try_new(config.node_url, metric::CHAIN_ID, "ophis-metric/1.0")?,
            settlement: config.settlement,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        let (sell, buy, input) = (order.sell.0, order.buy.0, order.amount.get());
        if order.side != order::Side::Sell {
            return Err(Error::OrderNotSupported);
        }
        let (pool, zero_for_one) = metric::route(sell, buy).ok_or(Error::OrderNotSupported)?;
        let amount_in = metric::exact_input(input).ok_or(Error::OrderNotSupported)?;
        let context = self.rpc.snapshot().await?;
        // The pool sees the router as its caller; Settlement receives output.
        let quote = metric::quoteLiveExactInSingleCall {
            pool,
            sender: metric::ROUTER,
            recipient: self.settlement,
            zeroForOne: zero_for_one,
            amountIn: amount_in,
            priceLimitX64: metric::price_limit(zero_for_one),
            extensionData: Bytes::new(),
        };
        // Registration, pool immutables and price come from one canonical
        // block. The router never checks tokens against the pool, so a
        // pinned-table mismatch is an integrity failure, not missing liquidity.
        let (immutables, registered, quoted) = futures::try_join!(
            self.read(context, pool, metric::getImmutablesCall {}.abi_encode()),
            self.read(
                context,
                metric::FACTORY,
                metric::isPoolCall { pool }.abi_encode()
            ),
            self.quote(context, quote.abi_encode()),
        )?;
        let word = |i: usize| {
            immutables
                .get(i * 32..(i + 1) * 32)
                .filter(|word| word[..12] == [0; 12])
                .map(|word| Address::from_slice(&word[12..]))
        };
        let (token0, token1) = if zero_for_one {
            (sell, buy)
        } else {
            (buy, sell)
        };
        if immutables.len() % 32 != 0
            || [word(0), word(1), word(2)] != [Some(metric::FACTORY), Some(token0), Some(token1)]
            || registered != U256::from(1).to_be_bytes::<32>()
        {
            return Err(Error::InvalidResponse);
        }
        let (filled, quoted) = quoted.ok_or(Error::NotFound)?;
        if filled > input {
            return Err(Error::InvalidResponse);
        }
        // A partial fill must never be advertised as the full exact input.
        if filled < input || quoted.is_zero() {
            return Err(Error::NotFound);
        }
        if quoted > U256::from(u128::MAX) {
            return Err(Error::InvalidResponse);
        }
        let bps = metrics::clamp_slippage_bps(
            metrics::Dex::Metric,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            2_000,
        );
        let bps = if is_quote {
            // Quotes never execute; as with direct V3, the advertised output
            // equals the calldata minimum the driver binds it to.
            0
        } else {
            order.bounded_solve_slippage_bps(
                quoted,
                bps,
                eth::Gas(U256::from(GAS + dex::SIM_SETTLE_OVERHEAD_GAS)),
                0,
            )
        };
        let min_out = quoted
            .checked_mul(U256::from(10_000u16.saturating_sub(bps)))
            .ok_or(Error::InvalidResponse)?
            / U256::from(10_000u16);
        if min_out.is_zero() {
            return Err(Error::NotFound);
        }
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs()
            + metric::DEADLINE_SECS;
        let calldata = metric::calldata(sell, buy, input, min_out, self.settlement, deadline)
            .ok_or(Error::InvalidResponse)?;
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: metric::ROUTER,
                calldata,
            }],
            input: eth::Asset {
                token: order.sell,
                amount: input,
            },
            output: eth::Asset {
                token: order.buy,
                amount: min_out,
            },
            allowance: dex::Allowance {
                spender: metric::ROUTER,
                amount: dex::Amount::new(input),
            },
            gas: eth::Gas(U256::from(GAS)),
        })
    }

    async fn read(
        &self,
        context: BlockContext,
        to: Address,
        data: Vec<u8>,
    ) -> Result<Vec<u8>, Error> {
        Ok(self.rpc.call_at(context, to, data).await?)
    }

    /// `None` when the quoter reverts: paused pool, stale or refused feed,
    /// empty bins or extension rejection. Transport failures stay errors.
    async fn quote(
        &self,
        context: BlockContext,
        data: Vec<u8>,
    ) -> Result<Option<(U256, U256)>, Error> {
        let data = match self.rpc.call_at(context, metric::QUOTER, data).await {
            Ok(data) => data,
            Err(RpcError::Rpc(e)) if ethrpc::alloy::errors::is_revert_error_payload(&e) => {
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        };
        if data.len() != 64 {
            return Err(Error::InvalidResponse);
        }
        Ok(Some((
            U256::from_be_slice(&data[..32]),
            U256::from_be_slice(&data[32..]),
        )))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported Metric order")]
    OrderNotSupported,
    #[error("no Metric liquidity")]
    NotFound,
    #[error("invalid Metric response")]
    InvalidResponse,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::infra::dex::Error as DexError,
        alloy::primitives::address,
        axum::{Json, Router, routing::post},
        serde_json::{Value, json},
        std::sync::{Arc, Mutex},
    };

    const WETH: Address = address!("0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    const SETTLEMENT: Address = address!("886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD");

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Live,
        Revert,
        RevertInternalCode,
        RevertCodeOnly,
        RevertData,
        Partial,
        WrongToken,
        Unregistered,
        RpcDown,
    }

    /// A canonical-block RPC whose pool is WETH/USDG and whose quoter returns
    /// 2000 USDG per WETH or 0.5 WETH per 1000 USDG.
    async fn solver(mode: Mode) -> (Metric, Arc<Mutex<Vec<Value>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let server = Router::new().route(
            "/",
            post(move |Json(request): Json<Value>| {
                let seen = seen.clone();
                async move {
                    let error = |code: i64, message: &str| {
                        Json(json!({"jsonrpc":"2.0", "id":1, "error":{"code":code, "message":message}}))
                    };
                    let word = |a: Address| a.into_word().to_vec();
                    let result = match request["method"].as_str().unwrap() {
                        "eth_chainId" => json!("0x1237"),
                        "eth_getBlockByNumber" => {
                            json!({"number":"0x1", "hash":format!("0x{}", "11".repeat(32))})
                        }
                        "eth_call" => {
                            seen.lock().unwrap().push(request["params"].clone());
                            let data =
                                const_hex::decode(request["params"][0]["data"].as_str().unwrap())
                                    .unwrap();
                            let selector: [u8; 4] = data[..4].try_into().unwrap();
                            if selector == metric::getImmutablesCall::SELECTOR {
                                let token1 = if mode == Mode::WrongToken {
                                    Address::repeat_byte(9)
                                } else {
                                    metric::USDG
                                };
                                // Real getImmutables RPC response from the pinned pool, 2026-10-20.
                                let mut raw = const_hex::decode(include_str!("../../tests/fixtures/metric-immutables.hex").trim()).unwrap();
                                raw[64..96].copy_from_slice(&token1.into_word()[..]);
                                json!(const_hex::encode_prefixed(raw))
                            } else if selector == metric::isPoolCall::SELECTOR {
                                assert_eq!(data[4..], word(metric::POOLS[0].0)[..]);
                                let registered = u8::from(mode != Mode::Unregistered);
                                json!(const_hex::encode_prefixed(U256::from(registered).to_be_bytes::<32>()))
                            } else if mode == Mode::Revert {
                                return error(3, "execution reverted");
                            } else if mode == Mode::RevertInternalCode {
                                return error(-32_603, "execution reverted");
                            } else if mode == Mode::RevertCodeOnly {
                                return error(3, "call failed");
                            } else if mode == Mode::RevertData {
                                return Json(json!({"jsonrpc":"2.0", "id":1, "error":{
                                    "code":-32_603, "message":"transaction reverted", "data":"0x08c379a0"
                                }}));
                            } else if mode == Mode::RpcDown {
                                return error(-32_603, "internal error");
                            } else {
                                let q = metric::quoteLiveExactInSingleCall::abi_decode(&data)
                                    .unwrap();
                                let filled = q.amountIn - u128::from(mode == Mode::Partial);
                                let out = if q.zeroForOne { 2_000_000_000 } else { 5 * 10u128.pow(17) };
                                let mut bytes = U256::from(filled).to_be_bytes::<32>().to_vec();
                                bytes.extend(U256::from(out).to_be_bytes::<32>());
                                json!(const_hex::encode_prefixed(bytes))
                            }
                        }
                        other => panic!("unexpected RPC {other}"),
                    };
                    Json(json!({"jsonrpc":"2.0", "id":1, "result":result}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let solver = Metric::try_new(Config {
            node_url: url,
            settlement: SETTLEMENT,
        })
        .unwrap();
        (solver, calls)
    }

    fn order(sell: Address, buy: Address, amount: U256) -> dex::Order {
        dex::Order {
            sell: eth::TokenAddress(sell),
            buy: eth::TokenAddress(buy),
            side: order::Side::Sell,
            amount: dex::Amount::new(amount),
            buy_limit: Default::default(),
            solve_fee: Default::default(),
            owner: SETTLEMENT,
        }
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[tokio::test]
    #[ignore = "requires ROBINHOOD_RPC; read-only live protocol checks"]
    async fn live_propamm_routes() {
        let node_url: reqwest::Url = std::env::var("ROBINHOOD_RPC").unwrap().parse().unwrap();
        let metric = Metric::try_new(Config {
            node_url: node_url.clone(),
            settlement: SETTLEMENT,
        })
        .unwrap();
        let elfomo =
            crate::infra::dex::elfomo::Elfomo::try_new(crate::infra::dex::elfomo::Config {
                node_url,
                chain_id: 4663,
                settlement: SETTLEMENT,
            })
            .unwrap();
        // Authenticate every driver-pinned triple against independent onchain immutables.
        let context = metric.rpc.snapshot().await.unwrap();
        for &(pool, token0, token1) in metric::POOLS {
            let raw = metric
                .rpc
                .call_at(context, pool, metric::getImmutablesCall {}.abi_encode())
                .await
                .unwrap();
            assert_eq!(raw.len(), 24 * 32);
            for (i, expected) in [metric::FACTORY, token0, token1].iter().enumerate() {
                assert_eq!(
                    &raw[i * 32..(i + 1) * 32],
                    expected.into_word().as_slice(),
                    "pool {pool}"
                );
            }
            let registered = metric
                .rpc
                .call_at(
                    context,
                    metric::FACTORY,
                    metric::isPoolCall { pool }.abi_encode(),
                )
                .await
                .unwrap();
            assert_eq!(registered, U256::from(1).to_be_bytes::<32>());
        }
        eprintln!(
            "Verified all {} pinned Metric pool/token triples onchain",
            metric::POOLS.len()
        );
        for (sell, buy, input) in [
            (WETH, metric::USDG, U256::from(100_000_000_000_000u64)),
            (metric::USDG, WETH, U256::from(1_000_000u64)),
        ] {
            let order = order(sell, buy, input);
            let slippage = dex::Slippage::one_percent();
            for (router, swap) in [
                (
                    metric::ROUTER,
                    metric.swap(&order, &slippage, true).await.unwrap(),
                ),
                (
                    crate::infra::dex::elfomo::ROUTER,
                    elfomo.swap(&order, &slippage, true).await.unwrap(),
                ),
            ] {
                assert_eq!((swap.input.token.0, swap.input.amount), (sell, input));
                assert_eq!(swap.output.token.0, buy);
                assert!(!swap.output.amount.is_zero());
                assert_eq!(swap.calls.len(), 1);
                assert_eq!(swap.calls[0].to, router);
                assert_eq!(
                    (swap.allowance.spender, swap.allowance.amount.get()),
                    (router, input)
                );
            }
        }
    }

    #[tokio::test]
    async fn quotes_and_solves_pinned_pool_at_one_block() {
        let (solver, calls) = solver(Mode::Live).await;
        let one = U256::from(10u64.pow(18));
        let before = now();
        let quote = solver
            .swap(
                &order(WETH, metric::USDG, one),
                &dex::Slippage::one_percent(),
                true,
            )
            .await
            .unwrap();
        let after = now();
        assert_eq!(quote.output.amount, U256::from(2_000_000_000u64));
        assert_eq!(quote.calls.len(), 1);
        assert_eq!(quote.calls[0].to, metric::ROUTER);
        assert_eq!(
            (quote.allowance.spender, quote.allowance.amount.get()),
            (metric::ROUTER, one)
        );
        let p = metric::exactInputSingleCall::abi_decode(&quote.calls[0].calldata)
            .unwrap()
            .params;
        assert_eq!(
            (p.pool, p.tokenIn, p.tokenOut, p.zeroForOne, p.recipient),
            (metric::POOLS[0].0, WETH, metric::USDG, true, SETTLEMENT)
        );
        assert_eq!(
            (p.amountIn, p.amountOutMinimum),
            (10u128.pow(18), 2_000_000_000)
        );
        assert_eq!(p.priceLimitX64, 0);
        assert!(p.extensionData.is_empty());
        let deadline = u64::try_from(p.deadline).unwrap();
        assert!(
            (before + metric::DEADLINE_SECS..=after + metric::DEADLINE_SECS).contains(&deadline)
        );
        // Exactly what the driver accepts for this fulfillment.
        assert_eq!(
            metric::decode(
                &quote.calls[0].calldata,
                WETH,
                metric::USDG,
                SETTLEMENT,
                after
            ),
            Some((one, quote.output.amount))
        );

        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 3);
        for params in &calls {
            assert!(
                params[0].get("from").is_none(),
                "restricted providers need no from"
            );
            assert_eq!(params[1]["blockHash"], format!("0x{}", "11".repeat(32)));
            assert_eq!(params[1]["requireCanonical"], true);
        }
        let to = |a: Address| format!("{a:#x}");
        assert_eq!(
            calls
                .iter()
                .filter(|p| p[0]["to"] == to(metric::POOLS[0].0))
                .count(),
            1
        );
        assert_eq!(
            calls
                .iter()
                .filter(|p| p[0]["to"] == to(metric::FACTORY))
                .count(),
            1
        );
        let request = calls
            .iter()
            .find(|p| p[0]["to"] == to(metric::QUOTER))
            .unwrap();
        let q = metric::quoteLiveExactInSingleCall::abi_decode(
            &const_hex::decode(request[0]["data"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            (q.pool, q.sender, q.recipient, q.zeroForOne, q.amountIn),
            (
                metric::POOLS[0].0,
                metric::ROUTER,
                SETTLEMENT,
                true,
                10u128.pow(18)
            )
        );
        assert_eq!(q.priceLimitX64, 0);
        assert!(q.extensionData.is_empty());

        let usdg = U256::from(1_000_000_000u64);
        let swap = solver
            .swap(
                &order(metric::USDG, WETH, usdg),
                &dex::Slippage::one_percent(),
                false,
            )
            .await
            .unwrap();
        let p = metric::exactInputSingleCall::abi_decode(&swap.calls[0].calldata)
            .unwrap()
            .params;
        let minimum = 5 * 10u128.pow(17) / 100 * 99;
        assert_eq!(
            (
                p.tokenIn,
                p.tokenOut,
                p.zeroForOne,
                p.amountIn,
                p.amountOutMinimum
            ),
            (metric::USDG, WETH, false, 1_000_000_000, minimum)
        );
        assert_eq!(p.priceLimitX64, u128::MAX);
        assert_eq!(swap.output.amount, U256::from(minimum));
        assert_eq!(swap.allowance.amount.get(), usdg);
    }

    #[tokio::test]
    async fn liquidity_and_rpc_failures_are_distinct() {
        let one = U256::from(10u64.pow(18));
        for (mode, liquidity) in [
            (Mode::Revert, true),
            (Mode::RevertInternalCode, true),
            (Mode::RevertCodeOnly, true),
            (Mode::RevertData, true),
            (Mode::Partial, true),
            (Mode::WrongToken, false),
            (Mode::Unregistered, false),
            (Mode::RpcDown, false),
        ] {
            let (solver, _) = solver(mode).await;
            let err = solver
                .swap(
                    &order(WETH, metric::USDG, one),
                    &dex::Slippage::one_percent(),
                    false,
                )
                .await
                .unwrap_err();
            match mode {
                Mode::WrongToken | Mode::Unregistered => {
                    assert!(matches!(err, Error::InvalidResponse))
                }
                Mode::RpcDown => assert!(matches!(err, Error::Rpc(_))),
                _ => assert!(matches!(err, Error::NotFound)),
            }
            // Only real liquidity failures shrink partially fillable orders.
            assert_eq!(matches!(DexError::from(err), DexError::NotFound), liquidity);
        }
    }

    #[tokio::test]
    async fn unsupported_orders_never_reach_rpc() {
        let solver = Metric::try_new(Config {
            node_url: "http://127.0.0.1:9/".parse().unwrap(),
            settlement: SETTLEMENT,
        })
        .unwrap();
        let spcx = metric::POOLS[1].1;
        let too_large = U256::from(i128::MAX as u128) + U256::from(1);
        let mut buy = order(WETH, metric::USDG, U256::from(1));
        buy.side = order::Side::Buy;
        for unsupported in [
            buy,
            order(WETH, spcx, U256::from(1)),
            order(WETH, WETH, U256::from(1)),
            order(WETH, metric::USDG, U256::ZERO),
            order(WETH, metric::USDG, too_large),
        ] {
            let err = solver
                .swap(&unsupported, &dex::Slippage::one_percent(), true)
                .await
                .unwrap_err();
            assert!(matches!(err, Error::OrderNotSupported));
        }
    }
}
