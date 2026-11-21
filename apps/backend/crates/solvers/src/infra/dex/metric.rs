//! Metric v1 SELL routes on Robinhood through one pinned pool, or two pinned
//! pools joined by USDG or WETH. Router, quoter, pools and tokens are pinned
//! in `shared::metric`; the Metric API never participates in quoting or
//! execution.
use {
    crate::{
        domain::{dex, eth, order},
        infra::metrics,
    },
    alloy::{
        primitives::{Address, Bytes, U256, address},
        sol,
        sol_types::SolCall,
    },
    ethrpc::block_context::{BlockContext, Error as RpcError, ReadOnlyRpc},
    shared::metric,
    std::time::{SystemTime, UNIX_EPOCH},
};

/// Per pool: router, pool swap, oracle read and three extensions; no quoter
/// estimate.
const GAS_PER_POOL: u64 = 350_000;
/// Tokens a two-pool route may pass through.
const MIDS: [Address; 2] = [metric::USDG, WETH];
const WETH: Address = address!("0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
/// Canonical Multicall3; one `eth_call` quotes every pinned pool of a hop.
const MULTICALL3: Address = address!("cA11bde05977b3631167028862bE2a173976CA11");

sol! {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct CallResult { bool success; bytes returnData; }
    function aggregate3(Call3[] calls) external payable returns (CallResult[] returnData);
}

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
        if order.side != order::Side::Sell || sell == buy || metric::exact_input(input).is_none() {
            return Err(Error::OrderNotSupported);
        }
        let pinned = |a, b| metric::pools(a, b).next().is_some();
        let direct = pinned(sell, buy);
        let mids: Vec<Address> = MIDS
            .into_iter()
            .filter(|&mid| mid != sell && mid != buy && pinned(sell, mid) && pinned(mid, buy))
            .collect();
        if !direct && mids.is_empty() {
            return Err(Error::OrderNotSupported);
        }
        // Every quote of one order reads the same canonical block.
        let context = self.rpc.snapshot().await?;
        let one_pool = async {
            if !direct {
                return Ok(None);
            }
            let best = self
                .best(context, sell, buy, input, self.settlement)
                .await?;
            Ok::<_, Error>(best.map(|(pool, out)| (vec![sell, buy], vec![pool], out)))
        };
        let two_pools = futures::future::try_join_all(mids.into_iter().map(|mid| async move {
            // The router holds the intermediate token between its two swaps.
            let Some((first, mid_out)) =
                self.best(context, sell, mid, input, metric::ROUTER).await?
            else {
                return Ok(None);
            };
            let second = self
                .best(context, mid, buy, mid_out, self.settlement)
                .await?;
            Ok::<_, Error>(second.map(|(pool, out)| (vec![sell, mid, buy], vec![first, pool], out)))
        }));
        let (one_pool, two_pools) = futures::try_join!(one_pool, two_pools)?;
        // On equal output the one-pool route wins: it costs less gas.
        let (tokens, pools, quoted) = two_pools
            .into_iter()
            .flatten()
            .fold(one_pool, |best, route| match best {
                Some(best) if best.2 >= route.2 => Some(best),
                _ => Some(route),
            })
            .ok_or(Error::NotFound)?;
        let gas = GAS_PER_POOL * pools.len() as u64;
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
                eth::Gas(U256::from(gas + dex::SIM_SETTLE_OVERHEAD_GAS)),
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
        let calldata =
            metric::calldata_via(&tokens, &pools, input, min_out, self.settlement, deadline)
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
            gas: eth::Gas(U256::from(gas)),
        })
    }

    /// The pinned `sell -> buy` pool paying the most for the whole `input`,
    /// with its output. `None` when no pool fills it: a reverted quote means a
    /// paused pool, stale or refused feed, empty bins or extension rejection.
    /// Transport failures stay errors.
    async fn best(
        &self,
        context: BlockContext,
        sell: Address,
        buy: Address,
        input: U256,
        recipient: Address,
    ) -> Result<Option<(Address, U256)>, Error> {
        // An intermediate amount can exceed the quoter's `int128`.
        let Some(amount_in) = metric::exact_input(input) else {
            return Ok(None);
        };
        let candidates: Vec<_> = metric::pools(sell, buy).collect();
        let call = |target, call_data: Vec<u8>| Call3 {
            target,
            allowFailure: true,
            callData: call_data.into(),
        };
        let calls = candidates
            .iter()
            .flat_map(|&(pool, zero_for_one)| {
                [
                    call(pool, metric::getImmutablesCall {}.abi_encode()),
                    call(metric::FACTORY, metric::isPoolCall { pool }.abi_encode()),
                    // The pool sees the router as its caller.
                    call(
                        metric::QUOTER,
                        metric::quoteLiveExactInSingleCall {
                            pool,
                            sender: metric::ROUTER,
                            recipient,
                            zeroForOne: zero_for_one,
                            amountIn: amount_in,
                            priceLimitX64: metric::price_limit(zero_for_one),
                            extensionData: Bytes::new(),
                        }
                        .abi_encode(),
                    ),
                ]
            })
            .collect();
        let raw = self
            .rpc
            .call_at(context, MULTICALL3, aggregate3Call { calls }.abi_encode())
            .await?;
        let results =
            aggregate3Call::abi_decode_returns(&raw).map_err(|_| Error::InvalidResponse)?;
        if results.len() != candidates.len() * 3 {
            return Err(Error::InvalidResponse);
        }
        let mut best = None;
        for (&(pool, zero_for_one), result) in candidates.iter().zip(results.chunks(3)) {
            let (immutables, registered, quoted) = (&result[0], &result[1], &result[2]);
            let word = |i: usize| {
                immutables
                    .returnData
                    .get(i * 32..(i + 1) * 32)
                    .filter(|word| word[..12] == [0; 12])
                    .map(|word| Address::from_slice(&word[12..]))
            };
            let (token0, token1) = if zero_for_one {
                (sell, buy)
            } else {
                (buy, sell)
            };
            // The router never checks tokens against the pool, so a
            // pinned-table mismatch is an integrity failure, not missing
            // liquidity.
            if !immutables.success
                || !registered.success
                || immutables.returnData.len() % 32 != 0
                || [word(0), word(1), word(2)]
                    != [Some(metric::FACTORY), Some(token0), Some(token1)]
                || registered.returnData[..] != U256::from(1).to_be_bytes::<32>()
            {
                return Err(Error::InvalidResponse);
            }
            if !quoted.success {
                continue;
            }
            if quoted.returnData.len() != 64 {
                return Err(Error::InvalidResponse);
            }
            let filled = U256::from_be_slice(&quoted.returnData[..32]);
            let out = U256::from_be_slice(&quoted.returnData[32..]);
            if filled > input || out > U256::from(u128::MAX) {
                return Err(Error::InvalidResponse);
            }
            // A partial fill must never be advertised as the full exact
            // input. Ties keep the earlier, higher-volume pool.
            if filled == input && !out.is_zero() && best.is_none_or(|(_, top)| out > top) {
                best = Some((pool, out));
            }
        }
        Ok(best)
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
        axum::{Json, Router, routing::post},
        serde_json::{Value, json},
        std::sync::{Arc, Mutex},
    };

    const SETTLEMENT: Address = address!("886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD");

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Live,
        /// The first pinned pool of every pair refuses the swap.
        FirstReverts,
        Revert,
        Partial,
        WrongToken,
        Unregistered,
        RpcDown,
    }

    fn index(pool: Address) -> usize {
        metric::POOLS.iter().position(|p| p.0 == pool).unwrap()
    }

    /// What the mock quoter pays: 2000 USDG-like units for selling token0,
    /// 0.5 token0 for selling token1, minus the pool's table index so earlier
    /// pools are better.
    fn out(pool: Address, zero_for_one: bool) -> u128 {
        let base = if zero_for_one {
            2_000_000_000
        } else {
            5 * 10u128.pow(17)
        };
        base - index(pool) as u128
    }

    /// A canonical-block RPC serving Multicall3 over the pinned pools. Returns
    /// the solver and every `eth_call` it made.
    async fn solver(mode: Mode) -> (Metric, Arc<Mutex<Vec<Value>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let server = Router::new().route(
            "/",
            post(move |Json(request): Json<Value>| {
                let seen = seen.clone();
                async move {
                    let result = match request["method"].as_str().unwrap() {
                        "eth_chainId" => json!("0x1237"),
                        "eth_getBlockByNumber" => {
                            json!({"number":"0x1", "hash":format!("0x{}", "11".repeat(32))})
                        }
                        "eth_call" => {
                            seen.lock().unwrap().push(request["params"].clone());
                            if mode == Mode::RpcDown {
                                return Json(json!({"jsonrpc":"2.0", "id":1, "error":{"code":-32_603, "message":"internal error"}}));
                            }
                            let call = &request["params"][0];
                            assert_eq!(call["to"], format!("{MULTICALL3:#x}"));
                            let data = const_hex::decode(call["data"].as_str().unwrap()).unwrap();
                            let results: Vec<CallResult> = aggregate3Call::abi_decode(&data)
                                .unwrap()
                                .calls
                                .iter()
                                .map(|inner| {
                                    assert!(inner.allowFailure);
                                    answer(mode, inner.target, &inner.callData)
                                })
                                .collect();
                            json!(const_hex::encode_prefixed(
                                aggregate3Call::abi_encode_returns(&results)
                            ))
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

    fn answer(mode: Mode, target: Address, data: &[u8]) -> CallResult {
        let ok = |bytes: Vec<u8>| CallResult {
            success: true,
            returnData: bytes.into(),
        };
        let selector: [u8; 4] = data[..4].try_into().unwrap();
        if selector == metric::getImmutablesCall::SELECTOR {
            let &(_, token0, token1) = &metric::POOLS[index(target)];
            let token1 = if mode == Mode::WrongToken {
                Address::repeat_byte(9)
            } else {
                token1
            };
            // Real getImmutables RPC response from the first pinned pool,
            // 2026-10-20, with this pool's tokens written in.
            let mut raw = const_hex::decode(
                include_str!("../../tests/fixtures/metric-immutables.hex").trim(),
            )
            .unwrap();
            raw[32..64].copy_from_slice(&token0.into_word()[..]);
            raw[64..96].copy_from_slice(&token1.into_word()[..]);
            ok(raw)
        } else if selector == metric::isPoolCall::SELECTOR {
            assert_eq!(target, metric::FACTORY);
            let registered = u8::from(mode != Mode::Unregistered);
            ok(U256::from(registered).to_be_bytes::<32>().to_vec())
        } else {
            assert_eq!(target, metric::QUOTER);
            let q = metric::quoteLiveExactInSingleCall::abi_decode(data).unwrap();
            assert_eq!(q.sender, metric::ROUTER, "the pool sees the router");
            assert_eq!(q.priceLimitX64, metric::price_limit(q.zeroForOne));
            assert!(q.extensionData.is_empty());
            let &(_, token0, token1) = &metric::POOLS[index(q.pool)];
            let (sell, buy) = if q.zeroForOne {
                (token0, token1)
            } else {
                (token1, token0)
            };
            let first = metric::route(sell, buy).unwrap().0 == q.pool;
            if mode == Mode::Revert || (mode == Mode::FirstReverts && first) {
                return CallResult {
                    success: false,
                    returnData: vec![0x08, 0xc3, 0x79, 0xa0].into(),
                };
            }
            let filled = q.amountIn - u128::from(mode == Mode::Partial);
            let mut bytes = U256::from(filled).to_be_bytes::<32>().to_vec();
            bytes.extend(U256::from(out(q.pool, q.zeroForOne)).to_be_bytes::<32>());
            ok(bytes)
        }
    }

    /// The quoter requests inside one recorded Multicall3 `eth_call`.
    fn quotes(params: &Value) -> Vec<metric::quoteLiveExactInSingleCall> {
        let data = const_hex::decode(params[0]["data"].as_str().unwrap()).unwrap();
        aggregate3Call::abi_decode(&data)
            .unwrap()
            .calls
            .iter()
            .filter(|call| call.target == metric::QUOTER)
            .map(|call| metric::quoteLiveExactInSingleCall::abi_decode(&call.callData).unwrap())
            .collect()
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
        // Authenticate every driver-pinned triple against independent onchain
        // immutables.
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
        // Two pools: 0.001 NVDA -> USDG -> META against the live quoter.
        let (nvda, meta) = (metric::POOLS[3].1, metric::POOLS[2].1);
        let swap = metric
            .swap(
                &order(nvda, meta, U256::from(10u64.pow(15))),
                &dex::Slippage::one_percent(),
                true,
            )
            .await
            .unwrap();
        let p = metric::exactInputCall::abi_decode(&swap.calls[0].calldata)
            .unwrap()
            .params;
        assert_eq!(p.tokens, [nvda, metric::USDG, meta]);
        eprintln!(
            "0.001 NVDA -> {} wei META through pools {:?}",
            swap.output.amount, p.pools
        );
        assert_eq!(
            metric::decode(&swap.calls[0].calldata, nvda, meta, SETTLEMENT, now()),
            Some((U256::from(10u64.pow(15)), swap.output.amount))
        );
    }

    #[tokio::test]
    async fn quotes_and_solves_best_pinned_pool_at_one_block() {
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
        assert_eq!(quote.gas.0, U256::from(350_000));
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

        // One Multicall3 read covers every pinned WETH/USDG pool.
        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        let params = &calls[0];
        assert!(
            params[0].get("from").is_none(),
            "restricted providers need no from"
        );
        assert_eq!(params[1]["blockHash"], format!("0x{}", "11".repeat(32)));
        assert_eq!(params[1]["requireCanonical"], true);
        let quoted = quotes(params);
        let pinned: Vec<_> = metric::pools(WETH, metric::USDG).collect();
        assert!(pinned.len() > 1);
        assert_eq!(quoted.len(), pinned.len());
        for (q, &(pool, zero_for_one)) in quoted.iter().zip(&pinned) {
            assert_eq!(
                (q.pool, q.recipient, q.zeroForOne, q.amountIn),
                (pool, SETTLEMENT, zero_for_one, 10u128.pow(18))
            );
        }

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
    async fn falls_back_to_the_next_pinned_pool() {
        let (solver, _) = solver(Mode::FirstReverts).await;
        let one = U256::from(10u64.pow(18));
        let quote = solver
            .swap(
                &order(WETH, metric::USDG, one),
                &dex::Slippage::one_percent(),
                true,
            )
            .await
            .unwrap();
        let (second, _) = metric::pools(WETH, metric::USDG).nth(1).unwrap();
        let p = metric::exactInputSingleCall::abi_decode(&quote.calls[0].calldata)
            .unwrap()
            .params;
        assert_eq!(p.pool, second);
        assert_eq!(quote.output.amount, U256::from(out(second, true)));
        assert!(
            metric::decode(
                &quote.calls[0].calldata,
                WETH,
                metric::USDG,
                SETTLEMENT,
                now()
            )
            .is_some()
        );
    }

    #[tokio::test]
    async fn routes_two_pools_through_an_intermediate_token() {
        let (solver, calls) = solver(Mode::Live).await;
        let (nvda, meta) = (metric::POOLS[3].1, metric::POOLS[2].1);
        let input = U256::from(10u64.pow(18));
        let quote = solver
            .swap(
                &order(nvda, meta, input),
                &dex::Slippage::one_percent(),
                true,
            )
            .await
            .unwrap();
        let (first, second) = (metric::POOLS[3].0, metric::POOLS[2].0);
        let mid = out(first, true);
        assert_eq!(quote.output.amount, U256::from(out(second, false)));
        assert_eq!(quote.gas.0, U256::from(700_000));
        assert_eq!(quote.calls.len(), 1);
        assert_eq!(quote.calls[0].to, metric::ROUTER);
        assert_eq!(
            (quote.allowance.spender, quote.allowance.amount.get()),
            (metric::ROUTER, input)
        );
        let p = metric::exactInputCall::abi_decode(&quote.calls[0].calldata)
            .unwrap()
            .params;
        assert_eq!(p.tokens, [nvda, metric::USDG, meta]);
        assert_eq!(p.pools, [first, second]);
        assert_eq!(p.zeroForOneBitMap, U256::from(0b01));
        assert_eq!(
            (p.amountIn, p.amountOutMinimum, p.recipient),
            (10u128.pow(18), out(second, false), SETTLEMENT)
        );
        assert_eq!(
            metric::decode(&quote.calls[0].calldata, nvda, meta, SETTLEMENT, now()),
            Some((input, quote.output.amount))
        );
        // The router holds the USDG between hops; Settlement receives META.
        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        let (leg1, leg2) = (quotes(&calls[0]), quotes(&calls[1]));
        assert!(
            leg1.iter()
                .all(|q| q.recipient == metric::ROUTER && q.amountIn == 10u128.pow(18))
        );
        assert!(
            leg2.iter()
                .all(|q| q.recipient == SETTLEMENT && q.amountIn == mid && !q.zeroForOne)
        );
        assert_eq!(calls[0][1], calls[1][1], "one canonical block");

        // A pair with direct pools still takes the better two-pool route:
        // SPCX -> USDG -> WETH pays ~0.5 WETH against the direct mock's 2e9
        // wei.
        let spcx = metric::POOLS[1].1;
        assert!(metric::route(spcx, WETH).is_some());
        let swap = solver
            .swap(
                &order(spcx, WETH, input),
                &dex::Slippage::one_percent(),
                true,
            )
            .await
            .unwrap();
        let p = metric::exactInputCall::abi_decode(&swap.calls[0].calldata)
            .unwrap()
            .params;
        assert_eq!(p.tokens, [spcx, metric::USDG, WETH]);
        assert_eq!(p.pools, [metric::POOLS[1].0, metric::POOLS[0].0]);
    }

    #[tokio::test]
    async fn liquidity_and_rpc_failures_are_distinct() {
        let one = U256::from(10u64.pow(18));
        for (mode, liquidity) in [
            (Mode::Revert, true),
            (Mode::Partial, true),
            (Mode::WrongToken, false),
            (Mode::Unregistered, false),
            (Mode::RpcDown, false),
        ] {
            for buy in [metric::USDG, metric::POOLS[2].1] {
                let (solver, _) = solver(mode).await;
                let err = solver
                    .swap(&order(WETH, buy, one), &dex::Slippage::one_percent(), false)
                    .await
                    .unwrap_err();
                match mode {
                    Mode::WrongToken | Mode::Unregistered => {
                        assert!(matches!(err, Error::InvalidResponse))
                    }
                    Mode::RpcDown => assert!(matches!(err, Error::Rpc(_))),
                    _ => assert!(matches!(err, Error::NotFound)),
                }
                // Only real liquidity failures shrink partially fillable
                // orders.
                assert_eq!(matches!(DexError::from(err), DexError::NotFound), liquidity);
            }
        }
    }

    #[tokio::test]
    async fn unsupported_orders_never_reach_rpc() {
        let solver = Metric::try_new(Config {
            node_url: "http://127.0.0.1:9/".parse().unwrap(),
            settlement: SETTLEMENT,
        })
        .unwrap();
        let unpinned = Address::repeat_byte(7);
        let too_large = U256::from(i128::MAX as u128) + U256::from(1);
        let mut buy = order(WETH, metric::USDG, U256::from(1));
        buy.side = order::Side::Buy;
        for unsupported in [
            buy,
            order(WETH, unpinned, U256::from(1)),
            order(unpinned, metric::USDG, U256::from(1)),
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
