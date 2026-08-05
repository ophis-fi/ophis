//! Direct WOOFi sPMM solver for Optimism.

use {
    crate::domain::{dex, eth, order},
    alloy::{
        primitives::{Address, U256, U512, address, ruint::UintTryFrom},
        providers::DynProvider,
        sol,
        sol_types::SolCall,
    },
};

sol! {
    #[sol(rpc)]
    interface IWooRouterV2 {
        function querySwap(address fromToken, address toToken, uint256 fromAmount)
            external view returns (uint256 toAmount);
        function swap(
            address fromToken,
            address toToken,
            uint256 fromAmount,
            uint256 minToAmount,
            address payable to,
            address rebateTo
        ) external payable returns (uint256 realToAmount);
    }
}

pub const OPTIMISM_ROUTER: Address = address!("4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7");
const MAX_SLIPPAGE_BPS: u16 = 2_000;
const SWAP_GAS: u64 = 300_000;

pub struct Config {
    pub provider: DynProvider,
    pub settlement: Address,
    pub router: Address,
}

pub struct Woofi {
    router: IWooRouterV2::IWooRouterV2Instance<DynProvider>,
    settlement: Address,
}

impl Woofi {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        if config.router != OPTIMISM_ROUTER {
            return Err(CreationError::RouterNotAllowlisted(config.router));
        }
        if config.settlement.is_zero() {
            return Err(CreationError::InvalidSettlement);
        }
        Ok(Self {
            router: IWooRouterV2::new(config.router, config.provider),
            settlement: config.settlement,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        if order.side != order::Side::Sell
            || order.sell == order.buy
            || order.sell.0.is_zero()
            || order.buy.0.is_zero()
        {
            return Err(Error::OrderNotSupported);
        }
        let amount_in = order.amount.get();
        if amount_in.is_zero() {
            return Err(Error::NotFound);
        }
        let quoted_out = self
            .router
            .querySwap(order.sell.0, order.buy.0, amount_in)
            .call()
            .await
            .map_err(|err| {
                if is_execution_revert(&err) {
                    Error::NotFound
                } else {
                    Error::Rpc(err)
                }
            })?;
        if quoted_out.is_zero() {
            return Err(Error::NotFound);
        }
        let requested_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let configured_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Woofi,
            requested_bps,
            MAX_SLIPPAGE_BPS,
        );
        let slippage_bps = if is_quote {
            configured_bps
        } else {
            order.bounded_solve_slippage_bps(
                quoted_out,
                configured_bps,
                eth::Gas(U256::from(
                    SWAP_GAS.saturating_add(dex::SIM_SETTLE_OVERHEAD_GAS),
                )),
                0,
            )
        };
        let min_out = subtract_slippage(quoted_out, slippage_bps)
            .filter(|amount| !amount.is_zero())
            .ok_or(Error::NotFound)?;
        let calldata = IWooRouterV2::swapCall {
            fromToken: order.sell.0,
            toToken: order.buy.0,
            fromAmount: amount_in,
            minToAmount: min_out,
            to: self.settlement,
            rebateTo: Address::ZERO,
        }
        .abi_encode();
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: OPTIMISM_ROUTER,
                calldata,
            }],
            input: eth::Asset {
                token: order.sell,
                amount: amount_in,
            },
            output: eth::Asset {
                token: order.buy,
                amount: min_out,
            },
            allowance: dex::Allowance {
                spender: OPTIMISM_ROUTER,
                amount: dex::Amount::new(amount_in),
            },
            gas: eth::Gas(U256::from(SWAP_GAS)),
        })
    }
}

fn subtract_slippage(amount: U256, bps: u16) -> Option<U256> {
    let numerator = U512::from(amount) * U512::from(10_000u16.saturating_sub(bps));
    U256::uint_try_from(numerator / U512::from(10_000u16)).ok()
}

fn is_execution_revert(err: &alloy::contract::Error) -> bool {
    use ethrpc::alloy::errors::ContractErrorExt;
    matches!(err, alloy::contract::Error::TransportError(transport) if transport.as_error_resp().is_some())
        && err.is_contract_revert()
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("WOOFi router {0} is not in the compile-time allowlist")]
    RouterNotAllowlisted(Address),
    #[error("settlement address must be non-zero")]
    InvalidSettlement,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order type is not supported")]
    OrderNotSupported,
    #[error("WOOFi has no live route for this order")]
    NotFound,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("onchain WOOFi read failed: {0}")]
    Rpc(#[source] alloy::contract::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_selector_matches_router_abi() {
        assert_eq!(IWooRouterV2::swapCall::SELECTOR, [0x7d, 0xc2, 0x03, 0x82]);
    }

    #[test]
    fn slippage_floor_is_overflow_safe() {
        assert_eq!(
            subtract_slippage(U256::from(1_000), 100),
            Some(U256::from(990))
        );
        assert_eq!(subtract_slippage(U256::MAX, 0), Some(U256::MAX));
    }
}
