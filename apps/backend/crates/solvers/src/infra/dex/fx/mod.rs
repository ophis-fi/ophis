//! Native f(x) Protocol fxUSD redemption solver for Ethereum.
//!
//! Quotes execute the real `redeem` entry point with `eth_call`. A balance-only
//! state override gives Settlement the requested fxUSD for the read without
//! changing live state, capturing live fees, oracle state and liquidity.

use {
    crate::domain::{dex, eth, order},
    alloy::{
        primitives::{Address, B256, U256, U512, keccak256, ruint::UintTryFrom},
        providers::DynProvider,
        rpc::types::state::StateOverridesBuilder,
        sol,
        sol_types::SolCall,
    },
};

sol! {
    #[sol(rpc)]
    interface IFxUSD {
        function getMarkets() external view returns (address[] memory);
        function balanceOf(address account) external view returns (uint256);
        function redeem(address baseToken, uint256 amountIn, address receiver, uint256 minOut)
            external returns (uint256 amountOut, uint256 bonusOut);
    }
}

const MAX_SLIPPAGE_BPS: u16 = 2_000;
const REDEEM_GAS: u64 = 320_000;

pub struct Config {
    pub provider: DynProvider,
    pub settlement: Address,
    pub fxusd: Address,
    pub balance_slot: U256,
}

pub struct Fx {
    settlement: Address,
    fxusd: Address,
    balance_slot: U256,
    provider: DynProvider,
}

impl Fx {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        if config.settlement.is_zero() || config.fxusd.is_zero() {
            return Err(CreationError::ZeroAddress);
        }
        Ok(Self {
            settlement: config.settlement,
            fxusd: config.fxusd,
            balance_slot: config.balance_slot,
            provider: config.provider,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> {
        // Phase one supports the atomic redemption lane only. Minting needs an
        // allowance override as well; exact-output needs bounded inversion.
        if order.side != order::Side::Sell || order.sell.0 != self.fxusd {
            return Err(Error::OrderNotSupported);
        }
        let contract = IFxUSD::new(self.fxusd, self.provider.clone());
        let markets = contract.getMarkets().call().await.map_err(Error::Rpc)?;
        if !markets.contains(&order.buy.0) {
            return Err(Error::OrderNotSupported);
        }

        let amount_in = order.amount.get();
        if amount_in.is_zero() {
            return Err(Error::NotFound);
        }
        let balance_key = solidity_mapping_key(self.settlement, self.balance_slot);
        let overrides = |balance: U256| {
            StateOverridesBuilder::with_capacity(1).with_state_diff(
                self.fxusd,
                [(balance_key, B256::from(balance.to_be_bytes::<32>()))],
            )
        };

        // A proxy upgrade can change storage layout. Prove that the configured
        // slot still controls Settlement's fxUSD balance before using it for a
        // stateful quote. The sentinel MUST differ from the live value: checking
        // only `amount_in` can false-pass when the real balance already happens
        // to equal the order amount while a stale slot mutates unrelated state.
        let live_balance = contract
            .balanceOf(self.settlement)
            .call()
            .await
            .map_err(Error::Rpc)?;
        let sentinel = if live_balance == U256::MAX {
            U256::ZERO
        } else {
            live_balance + U256::from(1)
        };
        let overridden_balance = contract
            .balanceOf(self.settlement)
            .call()
            .overrides(overrides(sentinel))
            .await
            .map_err(Error::Rpc)?;
        if overridden_balance != sentinel {
            return Err(Error::InvalidBalanceSlot);
        }
        let quote = contract
            .redeem(order.buy.0, amount_in, self.settlement, U256::ZERO)
            .from(self.settlement)
            .call()
            .overrides(overrides(amount_in))
            .await
            .map_err(classify_quote_error)?;

        // Bonus reserve liquidity is best-effort. Exclude it from the clearing
        // amount and protect only the protocol's base `amountOut` with minOut.
        let requested_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let slippage_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Fx,
            requested_bps,
            MAX_SLIPPAGE_BPS,
        );
        let min_out = subtract_slippage(quote.amountOut, slippage_bps)
            .filter(|amount| !amount.is_zero())
            .ok_or(Error::NotFound)?;
        let calldata = IFxUSD::redeemCall {
            baseToken: order.buy.0,
            amountIn: amount_in,
            receiver: self.settlement,
            minOut: min_out,
        }
        .abi_encode();

        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: self.fxusd,
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
                // `redeem` burns `_msgSender()` directly and never calls
                // transferFrom, but the shared Swap shape requires an
                // allowance. Self-approve Settlement instead of granting the
                // upgradeable fxUSD proxy a persistent, unnecessary allowance.
                spender: self.settlement,
                amount: dex::Amount::new(amount_in),
            },
            gas: eth::Gas(U256::from(REDEEM_GAS)),
        })
    }
}

fn solidity_mapping_key(holder: Address, slot: U256) -> B256 {
    let mut key = [0u8; 64];
    key[12..32].copy_from_slice(holder.as_slice());
    key[32..64].copy_from_slice(&slot.to_be_bytes::<32>());
    keccak256(key)
}

fn subtract_slippage(amount: U256, bps: u16) -> Option<U256> {
    let numerator = U512::from(amount) * U512::from(10_000u16.saturating_sub(bps));
    U256::uint_try_from(numerator / U512::from(10_000u16)).ok()
}

/// Execution reverts mean the requested redemption is unavailable and allow a
/// partially fillable order to retry smaller. Transport and local ABI failures
/// remain RPC errors because they say nothing about protocol liquidity.
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

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("f(x) contract addresses must be non-zero")]
    ZeroAddress,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order type is not supported")]
    OrderNotSupported,
    #[error("f(x) redemption is unavailable at this size")]
    NotFound,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("configured fxUSD balance slot failed onchain verification")]
    InvalidBalanceSlot,
    #[error("onchain f(x) read failed: {0}")]
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
    fn balance_override_uses_solidity_mapping_layout() {
        let holder = Address::repeat_byte(0x11);
        let key = solidity_mapping_key(holder, U256::from(151));
        let mut encoded = [0u8; 64];
        encoded[12..32].copy_from_slice(holder.as_slice());
        encoded[63] = 151;
        assert_eq!(key, keccak256(encoded));
    }

    #[test]
    fn slippage_floor_is_exact_and_overflow_safe() {
        assert_eq!(
            subtract_slippage(U256::from(1_000), 100),
            Some(U256::from(990))
        );
        assert_eq!(subtract_slippage(U256::MAX, 0), Some(U256::MAX));
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
    fn redeem_abi_matches_official_interface() {
        assert_eq!(IFxUSD::redeemCall::SELECTOR, [0xf3, 0xf0, 0x94, 0xa1]);
    }
}
