//! Direct Arc Aero and hookless ERC20/ERC20 Uniswap v4 routes, no quote APIs.
use {
    crate::{
        domain::{dex, eth, order},
        infra::metrics,
    },
    alloy::{
        primitives::{Address, Bytes, U256, U512, ruint::UintTryFrom},
        sol_types::SolCall,
    },
    ethrpc::block_context::{BlockContext, Error as RpcError, ReadOnlyRpc},
    futures::{StreamExt, TryStreamExt, stream},
    shared::arc_routes as routes,
};

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Venue {
    Aero,
    UniswapV4,
}

pub struct Arc {
    rpc: ReadOnlyRpc,
    settlement: Address,
    venue: Venue,
}

impl Arc {
    pub fn try_new(url: reqwest::Url, settlement: Address, venue: Venue) -> Result<Self, RpcError> {
        Ok(Self {
            rpc: ReadOnlyRpc::try_new(url, 5042, "ophis-arc-direct/1.0")?,
            settlement,
            venue,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        let (sell, buy, input) = (order.sell.0, order.buy.0, order.amount.get());
        if order.side != order::Side::Sell || input.is_zero() || !routes::valid_pair(sell, buy) {
            return Err(Error::OrderNotSupported);
        }
        let context = self.rpc.snapshot().await?;
        let (quoted, gas, tier, router, metric) = match self.venue {
            Venue::Aero => {
                let pool = routes::aero_pool(sell, buy).ok_or(Error::NotFound)?;
                let call = routes::quoteExactInputCall {
                    pools: vec![pool],
                    tokenIn: sell,
                    amountIn: input,
                };
                let data = self
                    .call(context, routes::AERO_QUOTER, call.abi_encode())
                    .await?
                    .ok_or(Error::NotFound)?;
                let quote = routes::quoteExactInputCall::abi_decode_returns(&data)
                    .map_err(|_| Error::InvalidResponse)?;
                (
                    quote.amountOut,
                    U256::from(450_000),
                    (0, 0),
                    routes::AERO_ROUTER,
                    metrics::Dex::Aero,
                )
            }
            Venue::UniswapV4 => {
                let exact: u128 = input.try_into().map_err(|_| Error::OrderNotSupported)?;
                // ponytail: four canonical hookless fee/tick pairs; aggregator
                // routes cover custom fees, hooks and multihop liquidity.
                let quotes: Vec<_> = stream::iter(routes::V4_TIERS.iter().copied())
                    .map(|tier| async move {
                        let key =
                            routes::v4_key(sell, buy, tier).ok_or(Error::OrderNotSupported)?;
                        let call = routes::quoteExactInputSingleCall {
                            params: routes::QuoteParams {
                                poolKey: key,
                                zeroForOne: sell < buy,
                                exactAmount: exact,
                                hookData: Bytes::new(),
                            },
                        };
                        let Some(data) = self
                            .call(context, routes::V4_QUOTER, call.abi_encode())
                            .await?
                        else {
                            return Ok(None);
                        };
                        let quote = routes::quoteExactInputSingleCall::abi_decode_returns(&data)
                            .map_err(|_| Error::InvalidResponse)?;
                        Ok::<_, Error>((!quote.amountOut.is_zero()).then_some((
                            quote.amountOut,
                            quote.gasEstimate.saturating_add(U256::from(250_000)),
                            tier,
                        )))
                    })
                    .buffer_unordered(2)
                    .try_collect()
                    .await?;
                let (amount, gas, tier) = quotes
                    .into_iter()
                    .flatten()
                    .max_by_key(|(amount, _, tier)| (*amount, std::cmp::Reverse(*tier)))
                    .ok_or(Error::NotFound)?;
                (
                    amount,
                    gas,
                    tier,
                    routes::V4_ROUTER,
                    metrics::Dex::UniswapV4,
                )
            }
        };
        let configured = metrics::clamp_slippage_bps(
            metric,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            2_000,
        );
        let bps = if is_quote {
            0
        } else {
            order.bounded_solve_slippage_bps(
                quoted,
                configured,
                eth::Gas(gas.saturating_add(U256::from(dex::SIM_SETTLE_OVERHEAD_GAS))),
                0,
            )
        };
        let minimum = U256::uint_try_from(
            U512::from(quoted) * U512::from(10_000u16 - bps) / U512::from(10_000u16),
        )
        .map_err(|_| Error::InvalidResponse)?;
        if minimum.is_zero() {
            return Err(Error::NotFound);
        }
        let calls = match self.venue {
            Venue::Aero => vec![dex::Call {
                to: router,
                calldata: routes::aero_calldata(sell, buy, input, minimum, self.settlement)
                    .ok_or(Error::OrderNotSupported)?,
            }],
            Venue::UniswapV4 => vec![
                dex::Call {
                    to: sell,
                    calldata: routes::v4_funding(input),
                },
                dex::Call {
                    to: router,
                    calldata: routes::v4_calldata(sell, buy, tier, input, minimum)
                        .ok_or(Error::OrderNotSupported)?,
                },
            ],
        };
        Ok(dex::Swap {
            calls,
            input: eth::Asset {
                token: order.sell,
                amount: input,
            },
            output: eth::Asset {
                token: order.buy,
                amount: minimum,
            },
            allowance: dex::Allowance {
                spender: router,
                amount: dex::Amount::new(if matches!(self.venue, Venue::Aero) {
                    input
                } else {
                    U256::ZERO
                }),
            },
            gas: eth::Gas(gas),
        })
    }

    async fn call(
        &self,
        context: BlockContext,
        to: Address,
        data: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, Error> {
        match self.rpc.call_at(context, to, data).await {
            Ok(data) => Ok(Some(data)),
            Err(RpcError::Rpc(error))
                if matches!(error.code, 3 | -32_000)
                    && error.message.to_ascii_lowercase().contains("revert") =>
            {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported direct Arc order")]
    OrderNotSupported,
    #[error("no direct Arc liquidity")]
    NotFound,
    #[error("invalid direct Arc quote response")]
    InvalidResponse,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error(transparent)]
    Rpc(#[from] RpcError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use {
        alloy::sol_types::SolValue,
        axum::{Json, Router, routing::post},
        serde_json::{Value, json},
    };

    #[tokio::test]
    async fn arc_quotes_both_directions_and_selects_best_hookless_tier() {
        let server = Router::new().route(
            "/",
            post(|Json(request): Json<Value>| async move {
                let result = match request["method"].as_str().unwrap() {
                    "eth_chainId" => json!("0x13b2"),
                    "eth_getBlockByNumber" => {
                        json!({"number":"0x1","hash":format!("0x{}", "11".repeat(32))})
                    }
                    "eth_call" => {
                        assert_eq!(request["params"][1]["requireCanonical"], true);
                        let data =
                            const_hex::decode(request["params"][0]["data"].as_str().unwrap())
                                .unwrap();
                        let encoded = if data[..4] == routes::quoteExactInputCall::SELECTOR {
                            let quote = routes::quoteExactInputCall::abi_decode(&data).unwrap();
                            assert_eq!(quote.pools, [routes::AERO_POOLS[0].0]);
                            (U256::from(1000), Vec::<U256>::new(), Vec::<U256>::new())
                                .abi_encode_params()
                        } else {
                            let quote =
                                routes::quoteExactInputSingleCall::abi_decode(&data).unwrap();
                            assert!(quote.params.poolKey.hooks.is_zero());
                            assert!(quote.params.hookData.is_empty());
                            let best = quote.params.poolKey.fee
                                == alloy::primitives::aliases::U24::from(500);
                            (
                                U256::from(if best { 1000 } else { 900 }),
                                U256::from(100_000),
                            )
                                .abi_encode()
                        };
                        json!(const_hex::encode_prefixed(encoded))
                    }
                    other => panic!("unexpected RPC {other}"),
                };
                Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url: reqwest::Url = format!("http://{}/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let settlement = Address::repeat_byte(7);
        for venue in [Venue::Aero, Venue::UniswapV4] {
            let solver = Arc::try_new(url.clone(), settlement, venue).unwrap();
            for (sell, buy) in [(routes::USDC, routes::EURC), (routes::EURC, routes::USDC)] {
                let order = dex::Order {
                    sell: eth::TokenAddress(sell),
                    buy: eth::TokenAddress(buy),
                    side: order::Side::Sell,
                    amount: dex::Amount::new(U256::from(1000)),
                    buy_limit: Default::default(),
                    solve_fee: Default::default(),
                    owner: settlement,
                };
                for is_quote in [true, false] {
                    let swap = solver
                        .swap(&order, &dex::Slippage::one_percent(), is_quote)
                        .await
                        .unwrap();
                    let minimum = U256::from(if is_quote { 1000 } else { 990 });
                    assert_eq!(swap.output.amount, minimum);
                    assert_eq!(swap.input.amount, order.amount.get());
                    match venue {
                        Venue::Aero => {
                            assert_eq!(swap.calls.len(), 1);
                            assert_eq!(swap.allowance.amount.get(), order.amount.get());
                            assert_eq!(
                                swap.calls[0].calldata,
                                routes::aero_calldata(
                                    sell,
                                    buy,
                                    order.amount.get(),
                                    minimum,
                                    settlement
                                )
                                .unwrap()
                            );
                        }
                        Venue::UniswapV4 => {
                            assert_eq!(swap.calls.len(), 2);
                            assert!(swap.allowance.amount.get().is_zero());
                            assert_eq!(swap.calls[0].to, sell);
                            assert_eq!(
                                swap.calls[0].calldata,
                                routes::v4_funding(order.amount.get())
                            );
                            assert_eq!(swap.calls[1].to, routes::V4_ROUTER);
                            assert_eq!(
                                swap.calls[1].calldata,
                                routes::v4_calldata(
                                    sell,
                                    buy,
                                    (500, 10),
                                    order.amount.get(),
                                    minimum
                                )
                                .unwrap()
                            );
                        }
                    }
                }
                let buy_order = dex::Order {
                    side: order::Side::Buy,
                    ..order
                };
                assert!(matches!(
                    solver
                        .swap(&buy_order, &dex::Slippage::one_percent(), false)
                        .await,
                    Err(Error::OrderNotSupported)
                ));
            }
        }
        task.abort();
    }
}
