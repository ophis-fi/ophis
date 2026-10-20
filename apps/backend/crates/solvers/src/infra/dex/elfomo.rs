//! Direct ElfomoFi oracle-priced liquidity on Robinhood.

use {
    crate::domain::{dex, eth, order},
    alloy::{
        primitives::{Address, U256, U512, address, ruint::UintTryFrom},
        sol,
        sol_types::SolCall,
    },
    ethrpc::block_context::{Error as RpcError, ReadOnlyRpc},
};

sol! {
    interface IElfomo {
        function getAmountOut(address fromToken, address toToken, uint256 fromAmount)
            external view returns (uint256 toAmount);
        function swap(address fromToken, address toToken, int256 specifiedAmount,
            uint256 limitAmount, address receiver, uint256 partnerId) external;
    }
}

pub const ROUTER: Address = address!("f0f0F0F0FB0d738452EfD03A28e8be14C76d5f73");
const SETTLEMENT: Address = address!("886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD");
const SWAP_GAS: u64 = 350_000;

pub struct Config {
    pub node_url: reqwest::Url,
    pub chain_id: u64,
    pub settlement: Address,
}

pub struct Elfomo {
    rpc: ReadOnlyRpc,
}

impl Elfomo {
    pub fn try_new(config: Config) -> Result<Self, Error> {
        if config.chain_id != 4663 || config.settlement != SETTLEMENT {
            return Err(Error::InvalidConfig);
        }
        Ok(Self {
            rpc: ReadOnlyRpc::try_new(config.node_url, 4663, "ophis-elfomo/1.0")
                .map_err(RpcError::from)?,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        let amount = order.amount.get();
        if order.side != order::Side::Sell
            || amount.is_zero()
            || amount > (U256::MAX >> 1)
            || order.sell == order.buy
            || order.sell.0.is_zero()
            || order.buy.0.is_zero()
        {
            return Err(Error::OrderNotSupported);
        }
        let context = self.rpc.snapshot().await?;
        let data = match self
            .rpc
            .call_from_at(
                context,
                SETTLEMENT,
                ROUTER,
                IElfomo::getAmountOutCall {
                    fromToken: order.sell.0,
                    toToken: order.buy.0,
                    fromAmount: amount,
                }
                .abi_encode(),
            )
            .await
        {
            Ok(data) => data,
            Err(RpcError::Rpc(e)) if ethrpc::alloy::errors::is_revert_error_payload(&e) => {
                return Err(Error::NotFound);
            }
            Err(e) => return Err(e.into()),
        };
        if data.len() != 32 {
            return Err(Error::InvalidResponse);
        }
        let quoted = U256::from_be_slice(&data);
        let bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Elfomo,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            2_000,
        );
        let bps = if is_quote {
            0
        } else {
            order.bounded_solve_slippage_bps(
                quoted,
                bps,
                eth::Gas(U256::from(SWAP_GAS + dex::SIM_SETTLE_OVERHEAD_GAS)),
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
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: ROUTER,
                calldata: IElfomo::swapCall {
                    fromToken: order.sell.0,
                    toToken: order.buy.0,
                    specifiedAmount: alloy::primitives::I256::from_raw(amount),
                    limitAmount: min_out,
                    receiver: SETTLEMENT,
                    partnerId: U256::ZERO,
                }
                .abi_encode(),
            }],
            input: eth::Asset {
                token: order.sell,
                amount,
            },
            output: eth::Asset {
                token: order.buy,
                amount: min_out,
            },
            allowance: dex::Allowance {
                spender: ROUTER,
                amount: dex::Amount::new(amount),
            },
            gas: eth::Gas(U256::from(SWAP_GAS)),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported Elfomo chain or settlement")]
    InvalidConfig,
    #[error("unsupported Elfomo order")]
    OrderNotSupported,
    #[error("no executable Elfomo liquidity")]
    NotFound,
    #[error("invalid Elfomo response")]
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
        axum::{Json, Router, routing::post},
        serde_json::{Value, json},
    };

    const WETH: Address = address!("0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    const USDG: Address = shared::metric::USDG;

    fn order() -> dex::Order {
        dex::Order {
            sell: eth::TokenAddress(WETH),
            buy: eth::TokenAddress(USDG),
            side: order::Side::Sell,
            amount: dex::Amount::new(U256::from(10u64.pow(18))),
            buy_limit: Default::default(),
            solve_fee: Default::default(),
            owner: SETTLEMENT,
        }
    }

    async fn solver(reply: Value) -> (Elfomo, tokio::task::JoinHandle<()>) {
        let server = Router::new().route("/", post(move |Json(request): Json<Value>| {
            let reply = reply.clone();
            async move {
                let result = match request["method"].as_str().unwrap() {
                    "eth_chainId" => json!("0x1237"),
                    "eth_getBlockByNumber" => json!({"number":"0x1", "hash":format!("0x{}", "11".repeat(32))}),
                    "eth_call" => {
                        assert_eq!(request["params"][0]["from"], format!("{SETTLEMENT:#x}"));
                        assert_eq!(request["params"][0]["to"], format!("{ROUTER:#x}"));
                        assert_eq!(request["params"][1], json!({"blockHash":format!("0x{}", "11".repeat(32)), "requireCanonical":true}));
                        let data = const_hex::decode(request["params"][0]["data"].as_str().unwrap()).unwrap();
                        let call = IElfomo::getAmountOutCall::abi_decode(&data).unwrap();
                        assert_eq!((call.fromToken, call.toToken, call.fromAmount), (WETH, USDG, order().amount.get()));
                        return Json(reply);
                    }
                    other => panic!("unexpected RPC {other}"),
                };
                Json(json!({"jsonrpc":"2.0", "id":1, "result":result}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node_url = format!("http://{}/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        (
            Elfomo::try_new(Config {
                node_url,
                chain_id: 4663,
                settlement: SETTLEMENT,
            })
            .unwrap(),
            task,
        )
    }

    #[tokio::test]
    async fn quote_and_solve_bind_caller_block_and_exact_input() {
        let output = U256::from(2_000_000_000u64);
        let (solver, task) = solver(json!({"jsonrpc":"2.0", "id":1, "result":const_hex::encode_prefixed(output.to_be_bytes::<32>())})).await;
        for (is_quote, minimum) in [
            (true, output),
            (false, output * U256::from(99) / U256::from(100)),
        ] {
            let swap = solver
                .swap(&order(), &dex::Slippage::one_percent(), is_quote)
                .await
                .unwrap();
            assert_eq!(swap.calls.len(), 1);
            assert_eq!(swap.calls[0].to, ROUTER);
            let call = IElfomo::swapCall::abi_decode(&swap.calls[0].calldata).unwrap();
            assert_eq!(
                (
                    call.fromToken,
                    call.toToken,
                    call.specifiedAmount.into_raw(),
                    call.limitAmount,
                    call.receiver,
                    call.partnerId
                ),
                (
                    WETH,
                    USDG,
                    order().amount.get(),
                    minimum,
                    SETTLEMENT,
                    U256::ZERO
                )
            );
            assert_eq!(
                (swap.input.token.0, swap.input.amount),
                (WETH, order().amount.get())
            );
            assert_eq!((swap.output.token.0, swap.output.amount), (USDG, minimum));
            assert_eq!(
                (swap.allowance.spender, swap.allowance.amount.get()),
                (ROUTER, order().amount.get())
            );
        }
        let mut tight = order();
        tight.buy_limit = output;
        let swap = solver
            .swap(&tight, &dex::Slippage::one_percent(), false)
            .await
            .unwrap();
        assert_eq!(
            swap.output.amount, output,
            "signed limit removes quote slippage"
        );
        task.abort();
    }

    #[tokio::test]
    async fn invalid_outputs_and_liquidity_reverts_fail_closed_without_hiding_transport_errors() {
        for (reply, kind) in [
            (json!({"result":"0x"}), "invalid"),
            (
                json!({"result":const_hex::encode_prefixed([0u8; 33])}),
                "invalid",
            ),
            (
                json!({"result":const_hex::encode_prefixed([0u8; 32])}),
                "liquidity",
            ),
            (
                json!({"error":{"code":3,"message":"call failed"}}),
                "liquidity",
            ),
            (
                json!({"error":{"code":-32000,"message":"execution reverted"}}),
                "liquidity",
            ),
            (
                json!({"error":{"code":-32603,"message":"execution reverted"}}),
                "liquidity",
            ),
            (
                json!({"error":{"code":-32603,"message":"call failed","data":"0x08c379a0"}}),
                "rpc",
            ),
            (
                json!({"error":{"code":-32603,"message":"internal error"}}),
                "rpc",
            ),
            (
                json!({"error":{"code":429,"message":"rate limited"}}),
                "rpc",
            ),
        ] {
            let (solver, task) = solver(reply).await;
            let error = solver
                .swap(&order(), &dex::Slippage::one_percent(), false)
                .await
                .unwrap_err();
            assert!(
                match kind {
                    "invalid" => matches!(error, Error::InvalidResponse),
                    "liquidity" => matches!(error, Error::NotFound),
                    "rpc" => matches!(error, Error::Rpc(_)),
                    _ => unreachable!(),
                },
                "{error:?}"
            );
            task.abort();
        }
    }

    #[tokio::test]
    async fn unsupported_orders_are_rejected_before_rpc() {
        let solver = Elfomo::try_new(Config {
            node_url: "http://127.0.0.1:9/".parse().unwrap(),
            chain_id: 4663,
            settlement: SETTLEMENT,
        })
        .unwrap();
        for mutate in [
            |o: &mut dex::Order| o.side = order::Side::Buy,
            |o: &mut dex::Order| o.amount = dex::Amount::new(U256::ZERO),
            |o: &mut dex::Order| o.amount = dex::Amount::new(U256::from(1) << 255),
            |o: &mut dex::Order| o.buy = o.sell,
            |o: &mut dex::Order| o.sell = eth::TokenAddress(Address::ZERO),
            |o: &mut dex::Order| o.buy = eth::TokenAddress(Address::ZERO),
        ] {
            let mut input = order();
            mutate(&mut input);
            assert!(matches!(
                solver
                    .swap(&input, &dex::Slippage::one_percent(), false)
                    .await,
                Err(Error::OrderNotSupported)
            ));
        }
    }

    #[test]
    fn rejects_other_chains_and_settlements() {
        for (chain_id, settlement) in [(1, SETTLEMENT), (4663, Address::ZERO)] {
            assert!(matches!(
                Elfomo::try_new(Config {
                    node_url: "http://localhost:8545".parse().unwrap(),
                    chain_id,
                    settlement,
                }),
                Err(Error::InvalidConfig)
            ));
        }
    }
}
