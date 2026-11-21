//! Metric v1 SELL and BUY routes on Robinhood through one pinned pool, or two pinned
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
        // A sell fixes the input and maximises output; a buy fixes the
        // output and minimises input. `amount` is the fixed side, `quoted`
        // the other.
        let (sell, buy, amount) = (order.sell.0, order.buy.0, order.amount.get());
        let exact_out = order.side == order::Side::Buy;
        if sell == buy || metric::exact_input(amount).is_none() {
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
                .best(context, sell, buy, amount, self.settlement, exact_out)
                .await?;
            Ok::<_, Error>(best.map(|(pool, quoted)| (vec![sell, buy], vec![pool], quoted)))
        };
        let two_pools = futures::future::try_join_all(mids.into_iter().map(|mid| async move {
            // ponytail: only the best pool of the hop quoted first is tried;
            // if no pool of the other hop fills its amount the pair gets no
            // two-pool route.
            let (first, second, quoted) = if exact_out {
                // The router swaps the last pool first; inside its callback
                // the first pool pays that pool directly.
                let Some((second, mid_in)) = self
                    .best(context, mid, buy, amount, self.settlement, true)
                    .await?
                else {
                    return Ok(None);
                };
                let Some((first, quoted)) =
                    self.best(context, sell, mid, mid_in, second, true).await?
                else {
                    return Ok(None);
                };
                (first, second, quoted)
            } else {
                // The router holds the intermediate token between its swaps.
                let Some((first, mid_out)) = self
                    .best(context, sell, mid, amount, metric::ROUTER, false)
                    .await?
                else {
                    return Ok(None);
                };
                let Some((second, quoted)) = self
                    .best(context, mid, buy, mid_out, self.settlement, false)
                    .await?
                else {
                    return Ok(None);
                };
                (first, second, quoted)
            };
            Ok::<_, Error>(Some((vec![sell, mid, buy], vec![first, second], quoted)))
        }));
        let (one_pool, two_pools) = futures::try_join!(one_pool, two_pools)?;
        let two_pools = two_pools.into_iter().flatten();
        let two_pools = if exact_out {
            two_pools.min_by_key(|route| route.2)
        } else {
            two_pools.max_by_key(|route| route.2)
        };
        // ponytail: the second pool's gas is not priced here, so a two-pool
        // route must beat the one-pool route by over 0.1% to replace it
        // (unless only it reaches a sell order's minimum); price the gas in
        // the order's tokens if that margin loses real orders.
        let scaled = |quoted: U256, by: u16| quoted.saturating_mul(U256::from(by));
        let (tokens, pools, quoted) = match (one_pool, two_pools) {
            (Some(one), Some(two))
                if if exact_out {
                    scaled(two.2, 1001) >= scaled(one.2, 1000)
                } else {
                    one.2 >= order.buy_limit && scaled(two.2, 1000) <= scaled(one.2, 1001)
                } =>
            {
                one
            }
            (one, two) => two.or(one).ok_or(Error::NotFound)?,
        };
        let gas = GAS_PER_POOL * pools.len() as u64;
        let bps = metrics::clamp_slippage_bps(
            metrics::Dex::Metric,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            2_000,
        );
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse)?
            .as_secs()
            + metric::DEADLINE_SECS;
        // `input` is what Settlement approves and is charged; `output` what
        // the router guarantees.
        let (input, output, calldata) = if exact_out {
            // Quotes never execute, so they carry no pad. A solve approves
            // and charges the padded cap, as the other exact-output lanes do:
            // the router pulls only what the pools take, the rest stays in
            // Settlement.
            let bps = if is_quote { 0 } else { bps };
            let max_in = quoted
                .checked_mul(U256::from(10_000 + u32::from(bps)))
                .ok_or(Error::InvalidResponse)?
                .div_ceil(U256::from(10_000u16));
            let data = metric::calldata_out_via(
                &tokens,
                &pools,
                max_in,
                amount,
                self.settlement,
                deadline,
            );
            (max_in, amount, data)
        } else {
            let bps = if is_quote {
                // As with direct V3, the advertised output equals the
                // calldata minimum the driver binds it to.
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
            let data =
                metric::calldata_via(&tokens, &pools, amount, min_out, self.settlement, deadline);
            (amount, min_out, data)
        };
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: metric::ROUTER,
                calldata: calldata.ok_or(Error::InvalidResponse)?,
            }],
            input: eth::Asset {
                token: order.sell,
                amount: input,
            },
            output: eth::Asset {
                token: order.buy,
                amount: output,
            },
            allowance: dex::Allowance {
                spender: metric::ROUTER,
                amount: dex::Amount::new(input),
            },
            gas: eth::Gas(U256::from(gas)),
        })
    }

    /// The best pinned `sell -> buy` pool for the whole `amount`, with what
    /// it quotes for the other side: the most output for an exact input, or
    /// the least input for an exact output. `None` when no pool fills it: a
    /// reverted quote means a paused pool, stale or refused feed, empty bins
    /// or extension rejection. Transport failures stay errors.
    async fn best(
        &self,
        context: BlockContext,
        sell: Address,
        buy: Address,
        amount: U256,
        recipient: Address,
        exact_out: bool,
    ) -> Result<Option<(Address, U256)>, Error> {
        // An intermediate amount can exceed the quoter's `int128`.
        let Some(exact) = metric::exact_input(amount) else {
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
                        if exact_out {
                            metric::quoteLiveExactOutSingleCall {
                                pool,
                                sender: metric::ROUTER,
                                recipient,
                                zeroForOne: zero_for_one,
                                amountOutDesired: exact,
                                priceLimitX64: metric::price_limit(zero_for_one),
                                extensionData: Bytes::new(),
                            }
                            .abi_encode()
                        } else {
                            metric::quoteLiveExactInSingleCall {
                                pool,
                                sender: metric::ROUTER,
                                recipient,
                                zeroForOne: zero_for_one,
                                amountIn: exact,
                                priceLimitX64: metric::price_limit(zero_for_one),
                                extensionData: Bytes::new(),
                            }
                            .abi_encode()
                        },
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
            // Both quoters return `(amountIn, amountOut)`.
            let amount_in = U256::from_be_slice(&quoted.returnData[..32]);
            let amount_out = U256::from_be_slice(&quoted.returnData[32..]);
            let (filled, other) = if exact_out {
                (amount_out, amount_in)
            } else {
                (amount_in, amount_out)
            };
            if filled > amount || other > U256::from(u128::MAX) {
                return Err(Error::InvalidResponse);
            }
            // A partial fill must never be advertised as the whole amount.
            // Ties keep the earlier, higher-volume pool.
            let better = |top: U256| if exact_out { other < top } else { other > top };
            if filled == amount && !other.is_zero() && best.is_none_or(|(_, top)| better(top)) {
                best = Some((pool, other));
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
            // (pool, sender, zeroForOne, exact amount, limit, extension data)
            let exact_out = selector == metric::quoteLiveExactOutSingleCall::SELECTOR;
            let (pool, sender, zero_for_one, exact, limit, extension) = if exact_out {
                let q = metric::quoteLiveExactOutSingleCall::abi_decode(data).unwrap();
                let exact = q.amountOutDesired;
                (q.pool, q.sender, q.zeroForOne, exact, q.priceLimitX64, q.extensionData)
            } else {
                let q = metric::quoteLiveExactInSingleCall::abi_decode(data).unwrap();
                (q.pool, q.sender, q.zeroForOne, q.amountIn, q.priceLimitX64, q.extensionData)
            };
            assert_eq!(sender, metric::ROUTER, "the pool sees the router");
            assert_eq!(limit, metric::price_limit(zero_for_one));
            assert!(extension.is_empty());
            let &(_, token0, token1) = &metric::POOLS[index(pool)];
            let (sell, buy) = if zero_for_one {
                (token0, token1)
            } else {
                (token1, token0)
            };
            let first = metric::route(sell, buy).unwrap().0 == pool;
            if mode == Mode::Revert || (mode == Mode::FirstReverts && first) {
                return CallResult {
                    success: false,
                    returnData: vec![0x08, 0xc3, 0x79, 0xa0].into(),
                };
            }
            let filled = exact - u128::from(mode == Mode::Partial);
            // Both quoters return `(amountIn, amountOut)`.
            let (amount_in, amount_out) = if exact_out {
                (need(pool, zero_for_one), filled)
            } else {
                (filled, out(pool, zero_for_one))
            };
            let mut bytes = U256::from(amount_in).to_be_bytes::<32>().to_vec();
            bytes.extend(U256::from(amount_out).to_be_bytes::<32>());
            ok(bytes)
        }
    }

    /// What the mock exact-output quoter charges: 0.5 token0 when selling
    /// token0, 2000 USDG-like units when selling token1, plus the pool's table
    /// index so earlier pools are cheaper.
    fn need(pool: Address, zero_for_one: bool) -> u128 {
        let base = if zero_for_one {
            5 * 10u128.pow(17)
        } else {
            2_000_000_000
        };
        base + index(pool) as u128
    }

    /// The exact-output quoter requests inside one recorded `eth_call`.
    fn quotes_out(params: &Value) -> Vec<metric::quoteLiveExactOutSingleCall> {
        let data = const_hex::decode(params[0]["data"].as_str().unwrap()).unwrap();
        aggregate3Call::abi_decode(&data)
            .unwrap()
            .calls
            .iter()
            .filter(|call| call.target == metric::QUOTER)
            .map(|call| metric::quoteLiveExactOutSingleCall::abi_decode(&call.callData).unwrap())
            .collect()
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
        // Buys: 1 USDG with WETH (one pool) and 0.0001 META with NVDA (two).
        for (sell, buy, amount) in [
            (WETH, metric::USDG, U256::from(1_000_000u64)),
            (nvda, meta, U256::from(10u64.pow(14))),
        ] {
            let mut order = order(sell, buy, amount);
            order.side = order::Side::Buy;
            let swap = metric
                .swap(&order, &dex::Slippage::one_percent(), true)
                .await
                .unwrap();
            assert_eq!(swap.output.amount, amount);
            assert!(!swap.input.amount.is_zero());
            eprintln!("buy {amount} of {buy} costs {} of {sell}", swap.input.amount);
            assert_eq!(
                metric::decode(&swap.calls[0].calldata, sell, buy, SETTLEMENT, now()),
                Some((swap.input.amount, amount))
            );
        }
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

        // Within 0.1% the one-pool route stays, unless it misses the order's
        // minimum. On SPCX -> USDG the
        // direct pool pays 2e9 - 1, through WETH pays 2e9 exactly.
        let direct = U256::from(out(metric::POOLS[1].0, true));
        let mut near = order(spcx, metric::USDG, input);
        let swap = solver.swap(&near, &dex::Slippage::one_percent(), true).await.unwrap();
        assert_eq!(swap.output.amount, direct);
        assert!(metric::exactInputSingleCall::abi_decode(&swap.calls[0].calldata).is_ok());
        near.buy_limit = direct + U256::from(1);
        let swap = solver.swap(&near, &dex::Slippage::one_percent(), true).await.unwrap();
        assert_eq!(swap.output.amount, U256::from(2_000_000_000u64));
        assert_eq!(
            metric::exactInputCall::abi_decode(&swap.calls[0].calldata)
                .unwrap()
                .params
                .tokens,
            [spcx, WETH, metric::USDG]
        );
    }

    #[tokio::test]
    async fn buys_an_exact_output_through_one_or_two_pools() {
        let (solver, calls) = solver(Mode::Live).await;
        let buy = |sell, buy, amount: u64| {
            let mut order = order(sell, buy, U256::from(amount));
            order.side = order::Side::Buy;
            order
        };
        // One pool: buy 1000 USDG with WETH. A quote carries no pad.
        let usdg = U256::from(1_000_000_000u64);
        let cost = need(metric::POOLS[0].0, true);
        let quote = solver
            .swap(&buy(WETH, metric::USDG, 1_000_000_000), &dex::Slippage::one_percent(), true)
            .await
            .unwrap();
        assert_eq!(
            (quote.input.amount, quote.output.amount),
            (U256::from(cost), usdg)
        );
        let p = metric::exactOutputSingleCall::abi_decode(&quote.calls[0].calldata)
            .unwrap()
            .params;
        assert_eq!(
            (p.pool, p.tokenIn, p.tokenOut, p.zeroForOne, p.recipient),
            (metric::POOLS[0].0, WETH, metric::USDG, true, SETTLEMENT)
        );
        assert_eq!((p.amountOut, p.amountInMaximum), (1_000_000_000, cost));
        let quoted = quotes_out(&calls.lock().unwrap()[0]);
        assert_eq!(quoted.len(), metric::pools(WETH, metric::USDG).count());
        assert!(
            quoted
                .iter()
                .all(|q| q.recipient == SETTLEMENT && q.amountOutDesired == 1_000_000_000)
        );
        // A solve approves and charges the padded cap; the output stays exact.
        let swap = solver
            .swap(&buy(WETH, metric::USDG, 1_000_000_000), &dex::Slippage::one_percent(), false)
            .await
            .unwrap();
        let cap = U256::from(cost * 101).div_ceil(U256::from(100));
        assert_eq!((swap.input.amount, swap.output.amount), (cap, usdg));
        assert_eq!(swap.allowance.amount.get(), cap);
        assert_eq!(
            metric::decode(&swap.calls[0].calldata, WETH, metric::USDG, SETTLEMENT, now()),
            Some((cap, usdg))
        );

        // Two pools: buy META with NVDA through USDG. The last pool is quoted
        // first and receives the first pool's output directly.
        calls.lock().unwrap().clear();
        let (nvda, meta) = (metric::POOLS[3].1, metric::POOLS[2].1);
        let (first, second) = (metric::POOLS[3].0, metric::POOLS[2].0);
        let quote = solver
            .swap(&buy(nvda, meta, 10u64.pow(18)), &dex::Slippage::one_percent(), true)
            .await
            .unwrap();
        let (mid, cost) = (need(second, false), need(first, true));
        assert_eq!(quote.input.amount, U256::from(cost));
        assert_eq!(quote.output.amount, U256::from(10u64.pow(18)));
        assert_eq!(quote.gas.0, U256::from(700_000));
        let p = metric::exactOutputCall::abi_decode(&quote.calls[0].calldata)
            .unwrap()
            .params;
        assert_eq!(p.tokens, [nvda, metric::USDG, meta]);
        assert_eq!(p.pools, [first, second]);
        assert_eq!(p.zeroForOneBitMap, U256::from(0b01));
        assert_eq!(
            (p.amountOut, p.amountInMaximum, p.recipient),
            (10u128.pow(18), cost, SETTLEMENT)
        );
        assert_eq!(
            metric::decode(&quote.calls[0].calldata, nvda, meta, SETTLEMENT, now()),
            Some((U256::from(cost), U256::from(10u64.pow(18))))
        );
        let calls = calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        let (last_hop, first_hop) = (quotes_out(&calls[0]), quotes_out(&calls[1]));
        assert!(
            last_hop
                .iter()
                .all(|q| q.recipient == SETTLEMENT && q.amountOutDesired == 10u128.pow(18))
        );
        assert!(
            first_hop
                .iter()
                .all(|q| q.recipient == second && q.amountOutDesired == mid && q.zeroForOne)
        );
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
            for (buy, side) in [
                (metric::USDG, order::Side::Sell),
                (metric::POOLS[2].1, order::Side::Sell),
                (metric::USDG, order::Side::Buy),
                (metric::POOLS[2].1, order::Side::Buy),
            ] {
                let (solver, _) = solver(mode).await;
                let mut order = order(WETH, buy, one);
                order.side = side;
                let err = solver
                    .swap(&order, &dex::Slippage::one_percent(), false)
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
        for unsupported in [
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
