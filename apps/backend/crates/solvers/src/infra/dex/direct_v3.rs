//! Direct, single-pool V3/Slipstream SELL routes. Factories, quoters and routers
//! are pinned in config; no aggregator responses participate in execution.
use {
    crate::{
        domain::{dex, eth, order},
        infra::metrics,
    },
    alloy::primitives::{Address, U256, U512, ruint::UintTryFrom},
    ethrpc::block_context::{BlockContext, Error as RpcError, ReadOnlyRpc},
    futures::{StreamExt, TryStreamExt, stream},
    moka::future::Cache,
    std::time::Duration,
};

pub struct Config {
    pub chain_id: u64,
    pub node_url: reqwest::Url,
    pub settlement: Address,
    pub factory: Address,
    pub quoter: Address,
    pub router: Address,
    pub tick_spacing: bool,
    pub legacy_router: bool,
    pub tiers: Vec<u32>,
    pub metric: metrics::Dex,
}

pub struct DirectV3 {
    config: Config,
    rpc: ReadOnlyRpc,
    pools: Cache<(Address, Address, u32), bool>,
}

impl DirectV3 {
    pub fn try_new(config: Config) -> Result<Self, RpcError> {
        Ok(Self {
            rpc: ReadOnlyRpc::try_new(
                config.node_url.clone(),
                config.chain_id,
                "ophis-direct-v3/1.0",
            )?,
            // Cache discovery only; every price is read at the current snapshot.
            // A newly created pool is discoverable within one minute.
            pools: Cache::builder()
                .max_capacity(1024)
                .time_to_live(Duration::from_secs(60))
                .build(),
            config,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        if order.side != order::Side::Sell
            || order.amount.get().is_zero()
            || order.sell == order.buy
            || order.sell.0.is_zero()
            || order.buy.0.is_zero()
        {
            return Err(Error::OrderNotSupported);
        }
        let c = &self.config;
        let context = self.rpc.snapshot().await?;
        // ponytail: bounded direct-pool search; the competing aggregator lane
        // covers multihop. No background pool scans or cached executable prices.
        let quotes: Vec<_> = stream::iter(c.tiers.iter().copied())
            .map(|tier| self.quote_tier(order, context, tier))
            .buffer_unordered(2)
            .try_collect()
            .await?;
        let (tier, quoted, gas) = quotes
            .into_iter()
            .flatten()
            .max_by_key(|&(tier, amount, _)| (amount, std::cmp::Reverse(tier)))
            .ok_or(Error::NotFound)?;
        let bps = metrics::clamp_slippage_bps(
            c.metric,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            2_000,
        );
        let bps = if is_quote {
            // Quote auctions never execute. Keep advertised output equal to
            // calldata minimum, as required by the driver's direct-route guard.
            // Executable solves recompute their slippage floor below.
            0
        } else {
            order.bounded_solve_slippage_bps(
                quoted,
                bps,
                eth::Gas(gas.saturating_add(U256::from(dex::SIM_SETTLE_OVERHEAD_GAS))),
                0,
            )
        };
        let min_out = U256::uint_try_from(
            U512::from(quoted) * U512::from(10_000u16 - bps) / U512::from(10_000u16),
        )
        .map_err(|_| Error::InvalidResponse)?;
        if min_out.is_zero() {
            return Err(Error::NotFound);
        }
        let data = swap_calldata(
            c.tick_spacing,
            c.legacy_router,
            order.sell.0,
            order.buy.0,
            tier,
            c.settlement,
            order.amount.get(),
            min_out,
        );
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: c.router,
                calldata: data,
            }],
            input: eth::Asset {
                token: order.sell,
                amount: order.amount.get(),
            },
            output: eth::Asset {
                token: order.buy,
                amount: if is_quote { quoted } else { min_out },
            },
            allowance: dex::Allowance {
                spender: c.router,
                amount: dex::Amount::new(order.amount.get()),
            },
            gas: eth::Gas(gas),
        })
    }

    async fn quote_tier(
        &self,
        order: &dex::Order,
        context: BlockContext,
        tier: u32,
    ) -> Result<Option<(u32, U256, U256)>, Error> {
        let c = &self.config;
        let key = (
            order.sell.0.min(order.buy.0),
            order.sell.0.max(order.buy.0),
            tier,
        );
        let exists = if let Some(exists) = self.pools.get(&key).await {
            exists
        } else {
            let lookup = encode(
                if c.tick_spacing {
                    [0x28, 0xaf, 0x8d, 0x0b]
                } else {
                    [0x16, 0x98, 0xee, 0x82]
                },
                &[word(order.sell.0), word(order.buy.0), U256::from(tier)],
            );
            let pool = self.rpc.call_at(context, c.factory, lookup).await?;
            if pool.len() != 32 || pool[..12].iter().any(|&v| v != 0) {
                return Err(Error::InvalidResponse);
            }
            let exists = !Address::from_slice(&pool[12..]).is_zero();
            self.pools.insert(key, exists).await;
            exists
        };
        if !exists {
            return Ok(None);
        }
        let quote = encode(
            if c.tick_spacing {
                [0x9e, 0x7d, 0xef, 0xe6]
            } else {
                [0xc6, 0xa5, 0x02, 0x6a]
            },
            &[
                word(order.sell.0),
                word(order.buy.0),
                order.amount.get(),
                U256::from(tier),
                U256::ZERO,
            ],
        );
        let data = match self.rpc.call_at(context, c.quoter, quote).await {
            Ok(data) => data,
            Err(RpcError::Rpc(e))
                if matches!(e.code, 3 | -32_000)
                    && e.message.to_ascii_lowercase().contains("revert") =>
            {
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        };
        if data.len() != 128 {
            return Err(Error::InvalidResponse);
        }
        let output = U256::from_be_slice(&data[..32]);
        let gas = U256::from_be_slice(&data[96..]).saturating_add(U256::from(180_000));
        Ok((!output.is_zero()).then_some((tier, output, gas)))
    }
}

fn word(a: Address) -> U256 {
    U256::from_be_slice(a.as_slice())
}
fn encode(selector: [u8; 4], words: &[U256]) -> Vec<u8> {
    let mut out = selector.to_vec();
    for w in words {
        out.extend_from_slice(&w.to_be_bytes::<32>());
    }
    out
}
fn swap_calldata(
    tick_spacing: bool,
    legacy_router: bool,
    sell: Address,
    buy: Address,
    tier: u32,
    recipient: Address,
    input: U256,
    output: U256,
) -> Vec<u8> {
    let mut words = vec![word(sell), word(buy), U256::from(tier), word(recipient)];
    if tick_spacing || legacy_router {
        words.push(U256::MAX);
    }
    words.extend([input, output, U256::ZERO]);
    encode(
        if tick_spacing {
            [0xa0, 0x26, 0x38, 0x3e]
        } else if legacy_router {
            [0x41, 0x4b, 0xf3, 0x89]
        } else {
            [0x04, 0xe4, 0x5a, 0xaf]
        },
        &words,
    )
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported direct V3 order")]
    OrderNotSupported,
    #[error("no direct V3 liquidity")]
    NotFound,
    #[error("invalid direct V3 response")]
    InvalidResponse,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::{sol, sol_types::SolCall};
    sol! {
        interface V3 { struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; } function exactInputSingle(Params p) external; }
        interface Legacy { struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; } function exactInputSingle(Params p) external; }
        interface CL { struct Params { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; } function exactInputSingle(Params p) external; }
    }

    #[tokio::test]
    async fn arc_routes_arbitrary_tokens_with_cached_discovery_and_fresh_prices() {
        use {
            axum::{Json, Router, routing::post},
            serde_json::{Value, json},
            std::sync::{
                Arc,
                atomic::{AtomicU64, Ordering},
            },
        };
        let discoveries = Arc::new(AtomicU64::new(0));
        let price = Arc::new(AtomicU64::new(100));
        let reads = discoveries.clone();
        let current_price = price.clone();
        let server = Router::new().route("/", post(move |Json(request): Json<Value>| {
            let reads = reads.clone();
            let current_price = current_price.clone();
            async move {
                let result = match request["method"].as_str().unwrap() {
                    "eth_chainId" => json!("0x13b2"),
                    "eth_getBlockByNumber" => json!({"number":"0x1", "hash":format!("0x{}", "11".repeat(32))}),
                    "eth_call" => {
                        assert_eq!(request["params"][1]["requireCanonical"], true);
                        let data = const_hex::decode(request["params"][0]["data"].as_str().unwrap()).unwrap();
                        if data[..4] == [0x16, 0x98, 0xee, 0x82] {
                            reads.fetch_add(1, Ordering::SeqCst);
                            let tier = U256::from_be_slice(&data[68..100]);
                            json!(const_hex::encode_prefixed(U256::from(if tier == U256::from(10000) {0} else {1}).to_be_bytes::<32>()))
                        } else {
                            assert_eq!(data[..4], [0xc6, 0xa5, 0x02, 0x6a]);
                            let tier = U256::from_be_slice(&data[100..132]);
                            if tier == U256::from(3000) {
                                return Json(json!({"jsonrpc":"2.0", "id":1, "error":{"code":3,"message":"execution reverted"}}));
                            }
                            let output = current_price.load(Ordering::SeqCst) + if tier == U256::from(500) {5} else {0};
                            json!(const_hex::encode_prefixed(&encode([0; 4], &[U256::from(output), U256::ZERO, U256::ZERO, U256::from(100_000)])[4..]))
                        }
                    }
                    other => panic!("unexpected RPC {other}"),
                };
                Json(json!({"jsonrpc":"2.0", "id":1, "result":result}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let settlement = Address::repeat_byte(7);
        let router = Address::repeat_byte(8);
        let solver = DirectV3::try_new(Config {
            chain_id: 5042,
            node_url: url,
            settlement,
            router,
            factory: Address::repeat_byte(9),
            quoter: Address::repeat_byte(10),
            tick_spacing: false,
            legacy_router: false,
            tiers: vec![100, 500, 3000, 10000],
            metric: metrics::Dex::UniswapV3,
        })
        .unwrap();
        let mut order = dex::Order {
            sell: eth::TokenAddress(Address::repeat_byte(1)),
            buy: eth::TokenAddress(Address::repeat_byte(2)),
            side: order::Side::Sell,
            amount: dex::Amount::new(U256::from(100)),
            buy_limit: Default::default(),
            solve_fee: Default::default(),
            owner: settlement,
        };
        let quote = solver
            .swap(&order, &dex::Slippage::one_percent(), true)
            .await
            .unwrap();
        assert_eq!(quote.output.amount, U256::from(105));
        assert_eq!(discoveries.load(Ordering::SeqCst), 4);
        price.store(200, Ordering::SeqCst);
        std::mem::swap(&mut order.sell, &mut order.buy);
        let swap = solver
            .swap(&order, &dex::Slippage::one_percent(), false)
            .await
            .unwrap();
        let p = V3::exactInputSingleCall::abi_decode(&swap.calls[0].calldata)
            .unwrap()
            .p;
        assert_eq!(
            (p.tokenIn, p.tokenOut, p.recipient, p.amountIn),
            (order.sell.0, order.buy.0, settlement, U256::from(100))
        );
        assert_eq!(p.fee, alloy::primitives::aliases::U24::from(500u32));
        assert_eq!(p.amountOutMinimum, U256::from(202));
        assert_eq!(swap.output.amount, p.amountOutMinimum);
        assert_eq!(swap.allowance.spender, router);
        assert_eq!(
            discoveries.load(Ordering::SeqCst),
            4,
            "reverse direction reuses discovery, never prices"
        );
        task.abort();
    }
    #[test]
    fn calldata_matches_all_router_abis() {
        let sell = Address::repeat_byte(1);
        let buy = Address::repeat_byte(2);
        let recipient = Address::repeat_byte(3);
        let amount = U256::from(100);
        let min = U256::from(99);
        let a = swap_calldata(false, false, sell, buy, 500, recipient, amount, min);
        let p = V3::exactInputSingleCall::abi_decode(&a).unwrap().p;
        assert_eq!(
            (
                p.tokenIn,
                p.tokenOut,
                p.recipient,
                p.amountIn,
                p.amountOutMinimum
            ),
            (sell, buy, recipient, amount, min)
        );
        let a = swap_calldata(false, true, sell, buy, 500, recipient, amount, min);
        let p = Legacy::exactInputSingleCall::abi_decode(&a).unwrap().p;
        assert_eq!(
            (
                p.tokenIn,
                p.tokenOut,
                p.recipient,
                p.deadline,
                p.amountIn,
                p.amountOutMinimum
            ),
            (sell, buy, recipient, U256::MAX, amount, min)
        );
        let a = swap_calldata(true, false, sell, buy, 10, recipient, amount, min);
        let p = CL::exactInputSingleCall::abi_decode(&a).unwrap().p;
        assert_eq!(
            (
                p.tokenIn,
                p.tokenOut,
                p.recipient,
                p.deadline,
                p.amountIn,
                p.amountOutMinimum
            ),
            (sell, buy, recipient, U256::MAX, amount, min)
        );
    }
}
