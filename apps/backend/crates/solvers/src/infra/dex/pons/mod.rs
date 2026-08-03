//! Direct pons liquidity solver for Robinhood Chain.
//!
//! pons launches fixed-supply tokens into immutable Uniswap V3-style pools,
//! paired exclusively with Robinhood WETH. Discovery and authentication are
//! entirely onchain: a token must exist in either of the pinned pons launch
//! factories, and its pool must resolve through the pinned V3 factory at the
//! launch's snapshotted fee tier. Quotes come from the pinned Quoter V2 and
//! execution calldata targets only the pinned SwapRouter02 deployment.

use {
    crate::domain::{dex, eth, order},
    alloy::{
        primitives::{Address, Bytes, U160, U256, U512, Uint, ruint::UintTryFrom},
        providers::DynProvider,
        sol,
        sol_types::SolCall,
    },
    contracts::UniswapV3QuoterV2::IQuoterV2::{
        QuoteExactInputSingleParams, QuoteExactOutputSingleParams,
    },
};

sol! {
    struct LaunchedToken {
        address token;
        address deployer;
        address pairedToken;
        address positionManager;
        uint256 positionId;
        uint256 dexId;
        uint256 launchConfigId;
        uint256 restrictionsEndBlock;
        uint256 supply;
        bool isToken0;
        uint24 poolFee;
        bool exists;
        uint256 initialBuyAmount;
    }

    #[sol(rpc)]
    interface IPonsFactory {
        function getLaunchedToken(address token) external view returns (LaunchedToken launched);
    }

    #[sol(rpc)]
    interface IUniswapV3Factory {
        function getPool(address tokenA, address tokenB, uint24 fee)
            external view returns (address pool);
    }

    interface IPonsSwapRouter {
        struct ExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 amountIn;
            uint256 amountOutMinimum;
            uint160 sqrtPriceLimitX96;
        }

        function exactInputSingle(ExactInputSingleParams calldata params)
            external payable returns (uint256 amountOut);

        struct ExactOutputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 amountOut;
            uint256 amountInMaximum;
            uint160 sqrtPriceLimitX96;
        }

        function exactOutputSingle(ExactOutputSingleParams calldata params)
            external payable returns (uint256 amountIn);

        struct ExactInputParams {
            bytes path;
            address recipient;
            uint256 amountIn;
            uint256 amountOutMinimum;
        }

        function exactInput(ExactInputParams calldata params)
            external payable returns (uint256 amountOut);

        struct ExactOutputParams {
            bytes path;
            address recipient;
            uint256 amountOut;
            uint256 amountInMaximum;
        }

        function exactOutput(ExactOutputParams calldata params)
            external payable returns (uint256 amountIn);
    }
}

const MAX_SLIPPAGE_BPS: u16 = 2_000;
const SINGLE_HOP_GAS: u64 = 180_000;
const MULTI_HOP_GAS: u64 = 260_000;
type Fee = Uint<24, 1>;

#[derive(Clone, Copy)]
enum Route {
    Single { fee: Fee },
    Multi { sell_fee: Fee, buy_fee: Fee },
}

pub struct Config {
    pub provider: DynProvider,
    pub settlement: Address,
    pub weth: Address,
    pub factories: Vec<Address>,
    pub v3_factory: Address,
    pub router: Address,
    pub quoter: Address,
}

pub struct Pons {
    provider: DynProvider,
    settlement: Address,
    weth: Address,
    factories: Vec<Address>,
    v3_factory: Address,
    router: Address,
    quoter: contracts::UniswapV3QuoterV2::Instance,
}

impl Pons {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        if config.factories.is_empty() {
            return Err(CreationError::NoFactories);
        }
        if [
            config.settlement,
            config.weth,
            config.v3_factory,
            config.router,
            config.quoter,
        ]
        .contains(&Address::ZERO)
            || config.factories.contains(&Address::ZERO)
        {
            return Err(CreationError::ZeroAddress);
        }
        Ok(Self {
            quoter: contracts::UniswapV3QuoterV2::Instance::new(
                config.quoter,
                config.provider.clone(),
            ),
            provider: config.provider,
            settlement: config.settlement,
            weth: config.weth,
            factories: config.factories,
            v3_factory: config.v3_factory,
            router: config.router,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> {
        if order.sell == order.buy {
            return Err(Error::OrderNotSupported);
        }
        let sell_launch = self.authenticate(order.sell.0).await?;
        let buy_launch = self.authenticate(order.buy.0).await?;
        let route = match (sell_launch, buy_launch) {
            (None, None) => return Err(Error::OrderNotSupported),
            (Some(launch), None) | (None, Some(launch)) => Route::Single {
                fee: launch.poolFee,
            },
            (Some(sell), Some(buy)) => Route::Multi {
                sell_fee: sell.poolFee,
                buy_fee: buy.poolFee,
            },
        };

        let requested_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let slippage_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Pons,
            requested_bps,
            MAX_SLIPPAGE_BPS,
        );
        let (input, output, calldata) = match order.side {
            order::Side::Sell => {
                let amount_in = order.amount.get();
                let quoted_out = match route {
                    Route::Single { fee } => {
                        self.quoter
                            .quoteExactInputSingle(QuoteExactInputSingleParams {
                                tokenIn: order.sell.0,
                                tokenOut: order.buy.0,
                                amountIn: amount_in,
                                fee,
                                sqrtPriceLimitX96: U160::ZERO,
                            })
                            .call()
                            .await
                            .map_err(classify_quote_error)?
                            .amountOut
                    }
                    Route::Multi { sell_fee, buy_fee } => {
                        self.quoter
                            .quoteExactInput(
                                encode_path(
                                    order.sell.0,
                                    sell_fee,
                                    self.weth,
                                    buy_fee,
                                    order.buy.0,
                                ),
                                amount_in,
                            )
                            .call()
                            .await
                            .map_err(classify_quote_error)?
                            .amountOut
                    }
                };
                let min_out = subtract_slippage(quoted_out, slippage_bps)
                    .filter(|amount| !amount.is_zero())
                    .ok_or(Error::NotFound)?;
                let calldata = match route {
                    Route::Single { fee } => IPonsSwapRouter::exactInputSingleCall {
                        params: IPonsSwapRouter::ExactInputSingleParams {
                            tokenIn: order.sell.0,
                            tokenOut: order.buy.0,
                            fee,
                            recipient: self.settlement,
                            amountIn: amount_in,
                            amountOutMinimum: min_out,
                            sqrtPriceLimitX96: U160::ZERO,
                        },
                    }
                    .abi_encode(),
                    Route::Multi { sell_fee, buy_fee } => IPonsSwapRouter::exactInputCall {
                        params: IPonsSwapRouter::ExactInputParams {
                            path: encode_path(
                                order.sell.0,
                                sell_fee,
                                self.weth,
                                buy_fee,
                                order.buy.0,
                            ),
                            recipient: self.settlement,
                            amountIn: amount_in,
                            amountOutMinimum: min_out,
                        },
                    }
                    .abi_encode(),
                };
                (amount_in, min_out, calldata)
            }
            order::Side::Buy => {
                let amount_out = order.amount.get();
                let quoted_in = match route {
                    Route::Single { fee } => {
                        self.quoter
                            .quoteExactOutputSingle(QuoteExactOutputSingleParams {
                                tokenIn: order.sell.0,
                                tokenOut: order.buy.0,
                                amount: amount_out,
                                fee,
                                sqrtPriceLimitX96: U160::ZERO,
                            })
                            .call()
                            .await
                            .map_err(classify_quote_error)?
                            .amountIn
                    }
                    Route::Multi { sell_fee, buy_fee } => {
                        self.quoter
                            .quoteExactOutput(
                                encode_path(
                                    order.buy.0,
                                    buy_fee,
                                    self.weth,
                                    sell_fee,
                                    order.sell.0,
                                ),
                                amount_out,
                            )
                            .call()
                            .await
                            .map_err(classify_quote_error)?
                            .amountIn
                    }
                };
                let max_in = add_slippage(quoted_in, slippage_bps)
                    .filter(|amount| !amount.is_zero())
                    .ok_or(Error::AmountOverflow)?;
                let calldata = match route {
                    Route::Single { fee } => IPonsSwapRouter::exactOutputSingleCall {
                        params: IPonsSwapRouter::ExactOutputSingleParams {
                            tokenIn: order.sell.0,
                            tokenOut: order.buy.0,
                            fee,
                            recipient: self.settlement,
                            amountOut: amount_out,
                            amountInMaximum: max_in,
                            sqrtPriceLimitX96: U160::ZERO,
                        },
                    }
                    .abi_encode(),
                    Route::Multi { sell_fee, buy_fee } => IPonsSwapRouter::exactOutputCall {
                        params: IPonsSwapRouter::ExactOutputParams {
                            path: encode_path(
                                order.buy.0,
                                buy_fee,
                                self.weth,
                                sell_fee,
                                order.sell.0,
                            ),
                            recipient: self.settlement,
                            amountOut: amount_out,
                            amountInMaximum: max_in,
                        },
                    }
                    .abi_encode(),
                };
                (max_in, amount_out, calldata)
            }
        };

        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: self.router,
                calldata,
            }],
            input: eth::Asset {
                token: order.sell,
                amount: input,
            },
            // The clearing amount is the same floor enforced by router calldata.
            output: eth::Asset {
                token: order.buy,
                amount: output,
            },
            allowance: dex::Allowance {
                spender: self.router,
                amount: dex::Amount::new(input),
            },
            gas: eth::Gas(U256::from(match route {
                Route::Single { .. } => SINGLE_HOP_GAS,
                Route::Multi { .. } => MULTI_HOP_GAS,
            })),
        })
    }

    async fn authenticate(&self, token: Address) -> Result<Option<LaunchedToken>, Error> {
        if token == self.weth {
            return Ok(None);
        }
        let launch = self.find_launch(token).await?;
        if launch.pairedToken != self.weth || launch.token != token || !launch.exists {
            return Err(Error::NotFound);
        }
        let pool = IUniswapV3Factory::new(self.v3_factory, self.provider.clone())
            .getPool(token, self.weth, launch.poolFee)
            .call()
            .await
            .map_err(Error::Rpc)?;
        if pool == Address::ZERO {
            return Err(Error::NotFound);
        }
        Ok(Some(launch))
    }

    async fn find_launch(&self, token: Address) -> Result<LaunchedToken, Error> {
        for factory in &self.factories {
            let launched = IPonsFactory::new(*factory, self.provider.clone())
                .getLaunchedToken(token)
                .call()
                .await
                .map_err(Error::Rpc)?;
            if launched.exists {
                return Ok(launched);
            }
        }
        Err(Error::NotFound)
    }
}

/// Classifies a Quoter execution revert as route unavailability so partially
/// fillable orders retry at a smaller amount. Transport failures and local ABI
/// errors remain RPC failures: they do not prove that a smaller fill will work.
fn classify_quote_error(err: alloy::contract::Error) -> Error {
    use ethrpc::alloy::errors::ContractErrorExt;

    let is_execution_revert = matches!(
        &err,
        alloy::contract::Error::TransportError(transport)
            if transport.as_error_resp().is_some()
    ) && err.is_contract_revert();
    if is_execution_revert {
        Error::NotFound
    } else {
        Error::Rpc(err)
    }
}

fn subtract_slippage(amount: U256, bps: u16) -> Option<U256> {
    let numerator = U512::from(amount) * U512::from(10_000u16.saturating_sub(bps));
    U256::uint_try_from(numerator / U512::from(10_000u16)).ok()
}

fn add_slippage(amount: U256, bps: u16) -> Option<U256> {
    let denominator = U512::from(10_000u16);
    let numerator = U512::from(amount) * U512::from(10_000u32 + u32::from(bps));
    U256::uint_try_from((numerator + denominator - U512::from(1u8)) / denominator).ok()
}

fn encode_path(
    token_a: Address,
    fee_a: Fee,
    token_b: Address,
    fee_b: Fee,
    token_c: Address,
) -> Bytes {
    let mut path = Vec::with_capacity(66);
    path.extend_from_slice(token_a.as_slice());
    path.extend_from_slice(&fee_a.to_be_bytes::<3>());
    path.extend_from_slice(token_b.as_slice());
    path.extend_from_slice(&fee_b.to_be_bytes::<3>());
    path.extend_from_slice(token_c.as_slice());
    path.into()
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("at least one pons launch factory is required")]
    NoFactories,
    #[error("pons contract addresses must be non-zero")]
    ZeroAddress,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order type is not supported")]
    OrderNotSupported,
    #[error("no authenticated pons pool found")]
    NotFound,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("amount overflow")]
    AmountOverflow,
    #[error("onchain pons read failed: {0}")]
    Rpc(#[source] alloy::contract::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract_error(payload_json: &str) -> alloy::contract::Error {
        let dummy = serde_json::from_str::<u8>("x").unwrap_err();
        let rpc_err = alloy::transports::TransportError::deser_err(dummy, payload_json);
        assert!(rpc_err.is_error_resp(), "test setup: expected an ErrorResp");
        alloy::contract::Error::TransportError(rpc_err)
    }

    #[test]
    fn quote_execution_revert_is_unavailable_route() {
        let err = contract_error(r#"{"code":3,"message":"execution reverted","data":"0x"}"#);
        assert!(matches!(classify_quote_error(err), Error::NotFound));
    }

    #[test]
    fn quote_transport_failure_remains_rpc_error() {
        let err = alloy::contract::Error::TransportError(
            alloy::transports::TransportError::local_usage_str("connection reset"),
        );
        assert!(matches!(classify_quote_error(err), Error::Rpc(_)));
    }

    #[test]
    fn slippage_floor_is_exact_and_overflow_safe() {
        assert_eq!(
            subtract_slippage(U256::from(1_000), 100),
            Some(U256::from(990))
        );
        assert_eq!(subtract_slippage(U256::MAX, 0), Some(U256::MAX));
        assert_eq!(subtract_slippage(U256::from(1), 2_000), Some(U256::ZERO));
        assert_eq!(
            add_slippage(U256::from(1_000), 100),
            Some(U256::from(1_010))
        );
        assert_eq!(add_slippage(U256::from(1), 1), Some(U256::from(2)));
        assert_eq!(add_slippage(U256::MAX, 1), None);
    }
    #[test]
    fn multi_hop_path_uses_three_byte_big_endian_fees() {
        let token_a = Address::repeat_byte(0x11);
        let token_b = Address::repeat_byte(0x22);
        let token_c = Address::repeat_byte(0x33);
        let path = encode_path(token_a, Fee::from(500), token_b, Fee::from(10_000), token_c);
        assert_eq!(path.len(), 66);
        assert_eq!(&path[0..20], token_a.as_slice());
        assert_eq!(&path[20..23], &[0x00, 0x01, 0xf4]);
        assert_eq!(&path[23..43], token_b.as_slice());
        assert_eq!(&path[43..46], &[0x00, 0x27, 0x10]);
        assert_eq!(&path[46..66], token_c.as_slice());
    }

    #[test]
    fn multi_hop_router_abi_matches_swap_router_02_without_deadline() {
        assert_eq!(
            IPonsSwapRouter::exactInputCall::SELECTOR,
            [0xb8, 0x58, 0x18, 0x3f]
        );
        assert_eq!(
            IPonsSwapRouter::exactOutputCall::SELECTOR,
            [0x09, 0xb8, 0x13, 0x46]
        );
    }
}
