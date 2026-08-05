//! Direct Curve StableSwap solver for explicitly configured, verified pools.
//!
//! The first production scope is Optimism's canonical 3pool. Pools are never
//! accepted from a quote API: operators pin the pool and its ordered coin list,
//! and every quote is read directly from that pool onchain.

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
    interface ICurveStableSwap {
        function coins(uint256 index) external view returns (address);
        function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
        function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)
            external returns (uint256);
    }
}

const MAX_SLIPPAGE_BPS: u16 = 2_000;
const SWAP_GAS: u64 = 220_000;
const OPTIMISM_3POOL: Address = address!("1337BedC9D22ecbe766dF105c9623922A27963EC");
const OPTIMISM_3POOL_COINS: [Address; 3] = [
    address!("DA10009cBd5D07dd0CeCc66161FC93D7c9000da1"),
    address!("7F5c764cBc14f9669B88837ca1490cCa17c31607"),
    address!("94b008aA00579c1307B0EF2c499aD98a8ce58e58"),
];

#[derive(Clone, Debug)]
pub struct Pool {
    pub address: Address,
    /// Coin addresses in the exact index order exposed by the pool.
    pub coins: Vec<Address>,
}

pub struct Config {
    pub provider: DynProvider,
    pub pools: Vec<Pool>,
}

pub struct Curve {
    provider: DynProvider,
    pools: Vec<Pool>,
}

impl Curve {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        if config.pools.is_empty() {
            return Err(CreationError::NoPools);
        }
        for pool in &config.pools {
            if pool.address.is_zero()
                || pool.coins.len() < 2
                || pool.coins.iter().any(|coin| coin.is_zero())
            {
                return Err(CreationError::InvalidPool);
            }
            let mut unique = pool.coins.clone();
            unique.sort_unstable();
            unique.dedup();
            if unique.len() != pool.coins.len() {
                return Err(CreationError::DuplicateCoin);
            }
            if pool.address != OPTIMISM_3POOL || pool.coins != OPTIMISM_3POOL_COINS {
                return Err(CreationError::PoolNotAllowlisted(pool.address));
            }
        }
        let mut pool_addresses: Vec<_> = config.pools.iter().map(|pool| pool.address).collect();
        pool_addresses.sort_unstable();
        pool_addresses.dedup();
        if pool_addresses.len() != config.pools.len() {
            return Err(CreationError::DuplicatePool);
        }
        Ok(Self {
            provider: config.provider,
            pools: config.pools,
        })
    }

    /// Authenticate the configured coin-index mapping against each live pool.
    /// A wrong order would make a quote describe different assets than the
    /// calldata actually exchanges, so startup fails closed on any mismatch.
    pub async fn validate_onchain(&self) -> Result<(), CreationError> {
        for pool in &self.pools {
            let contract = ICurveStableSwap::new(pool.address, self.provider.clone());
            for (index, expected) in pool.coins.iter().enumerate() {
                let actual = contract
                    .coins(U256::from(index))
                    .call()
                    .await
                    .map_err(CreationError::Rpc)?;
                if actual != *expected {
                    return Err(CreationError::CoinMismatch {
                        pool: pool.address,
                        index,
                        expected: *expected,
                        actual,
                    });
                }
            }
        }
        Ok(())
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        // The legacy StableSwap ABI has no exact-output entry point. Emulating
        // BUY with an exact-input exchange could overspend while donating the
        // excess output to Settlement, so phase one fails closed on BUY.
        if order.side != order::Side::Sell {
            return Err(Error::OrderNotSupported);
        }
        let (pool, sell_index, buy_index, quoted_out) = self
            .best_pool(order.sell.0, order.buy.0, order.amount.get())
            .await?;
        let requested_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let configured_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Curve,
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
        let calldata = ICurveStableSwap::exchangeCall {
            i: sell_index,
            j: buy_index,
            dx: order.amount.get(),
            min_dy: min_out,
        }
        .abi_encode();

        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: pool.address,
                calldata,
            }],
            input: eth::Asset {
                token: order.sell,
                amount: order.amount.get(),
            },
            output: eth::Asset {
                token: order.buy,
                amount: min_out,
            },
            allowance: dex::Allowance {
                spender: pool.address,
                amount: dex::Amount::new(order.amount.get()),
            },
            gas: eth::Gas(U256::from(SWAP_GAS)),
        })
    }

    async fn best_pool(
        &self,
        sell: Address,
        buy: Address,
        amount: U256,
    ) -> Result<(&Pool, i128, i128, U256), Error> {
        let mut best = None;
        for pool in &self.pools {
            let Some(i) = pool.coins.iter().position(|coin| *coin == sell) else {
                continue;
            };
            let Some(j) = pool.coins.iter().position(|coin| *coin == buy) else {
                continue;
            };
            let i = i128::try_from(i).map_err(|_| Error::InvalidPool)?;
            let j = i128::try_from(j).map_err(|_| Error::InvalidPool)?;
            match ICurveStableSwap::new(pool.address, self.provider.clone())
                .get_dy(i, j, amount)
                .call()
                .await
            {
                Ok(output)
                    if !output.is_zero() && best.is_none_or(|(_, _, _, value)| output > value) =>
                {
                    best = Some((pool, i, j, output));
                }
                Ok(_) => {}
                Err(err) if is_execution_revert(&err) => {}
                Err(err) => return Err(Error::Rpc(err)),
            }
        }
        best.ok_or(Error::NotFound)
    }
}

fn subtract_slippage(amount: U256, bps: u16) -> Option<U256> {
    let numerator = U512::from(amount) * U512::from(10_000u16.saturating_sub(bps));
    U256::uint_try_from(numerator / U512::from(10_000u16)).ok()
}

fn is_execution_revert(err: &alloy::contract::Error) -> bool {
    use ethrpc::alloy::errors::ContractErrorExt;
    matches!(
        err,
        alloy::contract::Error::TransportError(transport)
            if transport.as_error_resp().is_some()
    ) && err.is_contract_revert()
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("at least one Curve pool must be configured")]
    NoPools,
    #[error("Curve pool address and coin list must be valid")]
    InvalidPool,
    #[error("Curve pool coin addresses must be unique")]
    DuplicateCoin,
    #[error("Curve pool {0} is not in the solver's compile-time allowlist")]
    PoolNotAllowlisted(Address),
    #[error("Curve pool addresses must be unique")]
    DuplicatePool,
    #[error("Curve pool {pool} coin {index} mismatch: configured {expected}, onchain {actual}")]
    CoinMismatch {
        pool: Address,
        index: usize,
        expected: Address,
        actual: Address,
    },
    #[error("failed to authenticate Curve pool configuration onchain: {0}")]
    Rpc(#[source] alloy::contract::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order type is not supported")]
    OrderNotSupported,
    #[error("no live configured Curve pool can fill this order")]
    NotFound,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("invalid configured Curve pool")]
    InvalidPool,
    #[error("onchain Curve read failed: {0}")]
    Rpc(#[source] alloy::contract::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slippage_floor_is_exact_and_overflow_safe() {
        assert_eq!(
            subtract_slippage(U256::from(1_000), 100),
            Some(U256::from(990))
        );
        assert_eq!(subtract_slippage(U256::MAX, 0), Some(U256::MAX));
    }

    #[test]
    fn exchange_selector_matches_optimism_pool_abi() {
        assert_eq!(
            ICurveStableSwap::exchangeCall::SELECTOR,
            [0x3d, 0xf0, 0x21, 0x24]
        );
    }
}
