//! Direct hookless Uniswap V4 solver lane.
//!
//! Quotes come from Uniswap's canonical V4Quoter over Ophis' own RPC. The
//! executable interaction calls the immutable, pair-restricted
//! OphisUniswapV4Adapter; no third-party routing or quote API participates.

use {
    crate::domain::{dex, eth, order},
    alloy::{
        primitives::{Address, Bytes, U256},
        sol,
        sol_types::SolCall,
    },
    ethrpc::block_context::{Error as ReadOnlyRpcError, ReadOnlyRpc},
};

sol! {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);

    function swapExactInput(address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut);
}

const MAX_SLIPPAGE_BPS: u16 = 2_000;
const ADAPTER_OVERHEAD_GAS: u64 = 250_000;

pub struct Config {
    pub chain_id: u64,
    pub node_url: reqwest::Url,
    pub quoter: Address,
    pub adapter: Address,
    pub wrapped_native: Address,
    pub stablecoin: Address,
    pub pool_fee: u32,
    pub tick_spacing: i32,
}

pub struct UniswapV4 {
    client: ReadOnlyRpc,
    config: Config,
}

impl UniswapV4 {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        Ok(Self {
            client: ReadOnlyRpc::try_new(
                config.node_url.clone(),
                config.chain_id,
                "ophis-uniswap-v4-solver/1.0",
            )?,
            config,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        let sell = order.sell.0;
        let buy = order.buy.0;
        let zero_for_one = if sell == self.config.wrapped_native && buy == self.config.stablecoin {
            true
        } else if sell == self.config.stablecoin && buy == self.config.wrapped_native {
            false
        } else {
            return Err(Error::OrderNotSupported);
        };
        let exact_amount: u128 = order
            .amount
            .get()
            .try_into()
            .map_err(|_| Error::AmountTooLarge)?;

        let quote_call = quoteExactInputSingleCall {
            params: QuoteExactSingleParams {
                poolKey: PoolKey {
                    currency0: Address::ZERO,
                    currency1: self.config.stablecoin,
                    fee: self
                        .config
                        .pool_fee
                        .try_into()
                        .map_err(|_| Error::InvalidPoolKey)?,
                    tickSpacing: self
                        .config
                        .tick_spacing
                        .try_into()
                        .map_err(|_| Error::InvalidPoolKey)?,
                    hooks: Address::ZERO,
                },
                zeroForOne: zero_for_one,
                exactAmount: exact_amount,
                hookData: Bytes::new(),
            },
        };
        let quote_data = self
            .eth_call(self.config.quoter, quote_call.abi_encode())
            .await?;
        let quote = quoteExactInputSingleCall::abi_decode_returns(&quote_data)
            .map_err(Error::QuoteDecode)?;
        if quote.amountOut.is_zero() {
            return Err(Error::NotFound);
        }

        let configured_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let clamped_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::UniswapV4,
            configured_bps,
            MAX_SLIPPAGE_BPS,
        );
        let sent_bps = if is_quote {
            clamped_bps
        } else {
            order.bounded_solve_slippage_bps(
                quote.amountOut,
                clamped_bps,
                eth::Gas(
                    quote
                        .gasEstimate
                        .saturating_add(U256::from(ADAPTER_OVERHEAD_GAS)),
                ),
                0,
            )
        };
        let min_amount_out = quote
            .amountOut
            .saturating_mul(U256::from(10_000u64 - u64::from(sent_bps)))
            / U256::from(10_000u64);
        if min_amount_out.is_zero() {
            return Err(Error::NotFound);
        }

        let swap_call = swapExactInputCall {
            tokenIn: sell,
            amountIn: order.amount.get(),
            minAmountOut: min_amount_out,
        };
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: self.config.adapter,
                calldata: swap_call.abi_encode(),
            }],
            input: eth::Asset {
                token: order.sell,
                amount: order.amount.get(),
            },
            output: eth::Asset {
                token: order.buy,
                amount: min_amount_out,
            },
            allowance: dex::Allowance {
                spender: self.config.adapter,
                amount: dex::Amount::new(order.amount.get()),
            },
            gas: eth::Gas(
                quote
                    .gasEstimate
                    .saturating_add(U256::from(ADAPTER_OVERHEAD_GAS)),
            ),
        })
    }

    async fn eth_call(&self, to: Address, calldata: Vec<u8>) -> Result<Vec<u8>, Error> {
        let context = self.client.snapshot().await?;
        match self.client.call_at(context, to, calldata).await {
            Ok(result) => Ok(result),
            Err(ReadOnlyRpcError::Rpc(error)) => {
                // V4Quoter reports absent pools, exhausted liquidity, and an
                // amount that crosses all initialized liquidity as an execution
                // revert. This is route unavailability, not an RPC transport
                // failure; classifying it as NotFound lets partially fillable
                // orders reduce their next attempt instead of retrying 100%
                // forever in every auction.
                if is_quote_unavailable(error.code, &error.message) {
                    return Err(Error::NotFound);
                }
                Err(Error::PinnedRpc(ReadOnlyRpcError::Rpc(error)))
            }
            Err(error) => Err(Error::PinnedRpc(error)),
        }
    }
}

fn is_quote_unavailable(code: i64, message: &str) -> bool {
    matches!(code, 3 | -32_000) && message.to_ascii_lowercase().contains("revert")
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order is not an exact-input WETH/USDG swap")]
    OrderNotSupported,
    #[error("no direct Uniswap V4 route")]
    NotFound,
    #[error("order amount exceeds uint128")]
    AmountTooLarge,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("invalid Uniswap V4 pool key")]
    InvalidPoolKey,
    #[error("pinned read-only RPC error")]
    PinnedRpc(#[from] ReadOnlyRpcError),
    #[error("invalid V4Quoter response")]
    QuoteDecode(#[source] alloy::sol_types::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error(transparent)]
    Client(#[from] reqwest::Error),
}

#[cfg(test)]
mod tests {
    use super::is_quote_unavailable;

    #[test]
    fn execution_reverts_are_unavailable_routes_but_transport_errors_are_not() {
        assert!(is_quote_unavailable(3, "execution reverted"));
        assert!(is_quote_unavailable(
            -32_000,
            "Execution Reverted: PoolNotInitialized"
        ));
        assert!(!is_quote_unavailable(-32_000, "upstream timeout"));
        assert!(!is_quote_unavailable(-32_605, "execution reverted"));
    }
}
