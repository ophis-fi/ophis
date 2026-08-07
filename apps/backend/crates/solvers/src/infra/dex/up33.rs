//! Direct UP33 Solidly V2 solver for Robinhood Chain.
//!
//! Pool discovery and quotes are read from pinned onchain contracts. Execution
//! is restricted to ordinary two- or three-token V2 paths and always returns
//! proceeds directly to Settlement.

use {
    crate::domain::{dex, eth, order},
    alloy::{
        primitives::{Address, U256, U512, ruint::UintTryFrom},
        providers::DynProvider,
        sol,
        sol_types::SolCall,
    },
};

sol! {
    #[sol(rpc)]
    interface IUp33Factory {
        function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool);
    }
    #[sol(rpc)]
    interface IUp33Router {
        struct Route { address from; address to; bool stable; address factory; }
        function getAmountsOut(uint256 amountIn, Route[] routes)
            external view returns (uint256[] amounts);
        function swapExactTokensForTokens(
            uint256 amountIn,
            uint256 amountOutMin,
            Route[] routes,
            address to,
            uint256 deadline
        ) external returns (uint256[] amounts);
    }
}

const MAX_SLIPPAGE_BPS: u16 = 2_000;
const SINGLE_HOP_GAS: u64 = 180_000;
const MULTI_HOP_GAS: u64 = 260_000;
const DEADLINE: U256 = U256::MAX;

pub struct Config {
    pub provider: DynProvider,
    pub settlement: Address,
    pub weth: Address,
    pub factory: Address,
    pub router: Address,
}

pub struct Up33 {
    factory: IUp33Factory::IUp33FactoryInstance<DynProvider>,
    router: IUp33Router::IUp33RouterInstance<DynProvider>,
    settlement: Address,
    weth: Address,
    factory_address: Address,
    router_address: Address,
}

impl Up33 {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        if [
            config.settlement,
            config.weth,
            config.factory,
            config.router,
        ]
        .contains(&Address::ZERO)
        {
            return Err(CreationError::ZeroAddress);
        }
        Ok(Self {
            factory: IUp33Factory::new(config.factory, config.provider.clone()),
            router: IUp33Router::new(config.router, config.provider),
            settlement: config.settlement,
            weth: config.weth,
            factory_address: config.factory,
            router_address: config.router,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        _is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        if order.sell == order.buy || order.sell.0.is_zero() || order.buy.0.is_zero() {
            return Err(Error::OrderNotSupported);
        }
        if order.side != order::Side::Sell {
            return Err(Error::OrderNotSupported);
        }
        let (routes, quoted) = self
            .best_route(order.sell.0, order.buy.0, order.amount.get())
            .await?;
        let bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Up33,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            MAX_SLIPPAGE_BPS,
        );
        let (input, output, calldata) = match order.side {
            order::Side::Sell => {
                let amount_in = order.amount.get();
                let min_out = subtract_slippage(quoted, bps)
                    .filter(|x| !x.is_zero())
                    .ok_or(Error::NotFound)?;
                let calldata = IUp33Router::swapExactTokensForTokensCall {
                    amountIn: amount_in,
                    amountOutMin: min_out,
                    routes: routes.clone(),
                    to: self.settlement,
                    deadline: DEADLINE,
                }
                .abi_encode();
                (amount_in, min_out, calldata)
            }
            order::Side::Buy => unreachable!("buy orders were rejected above"),
        };
        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: self.router_address,
                calldata,
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
                spender: self.router_address,
                amount: dex::Amount::new(input),
            },
            gas: eth::Gas(U256::from(if routes.len() == 1 {
                SINGLE_HOP_GAS
            } else {
                MULTI_HOP_GAS
            })),
        })
    }

    async fn best_route(
        &self,
        sell: Address,
        buy: Address,
        amount: U256,
    ) -> Result<(Vec<IUp33Router::Route>, U256), Error> {
        let mut candidates = Vec::new();
        for stable in [false, true] {
            if self.pool(sell, buy, stable).await? {
                candidates.push(vec![self.route(sell, buy, stable)]);
            }
        }
        if sell != self.weth && buy != self.weth {
            for first in [false, true] {
                if !self.pool(sell, self.weth, first).await? {
                    continue;
                }
                for second in [false, true] {
                    if self.pool(self.weth, buy, second).await? {
                        candidates.push(vec![
                            self.route(sell, self.weth, first),
                            self.route(self.weth, buy, second),
                        ]);
                    }
                }
            }
        }
        let mut best: Option<(Vec<IUp33Router::Route>, U256)> = None;
        for routes in candidates {
            let Ok(amounts) = self
                .router
                .getAmountsOut(amount, routes.clone())
                .call()
                .await
            else {
                continue;
            };
            let Some(output) = amounts.last().copied().filter(|x| !x.is_zero()) else {
                continue;
            };
            if best.as_ref().is_none_or(|(_, current)| output > *current) {
                best = Some((routes, output));
            }
        }
        best.ok_or(Error::NotFound)
    }

    fn route(&self, from: Address, to: Address, stable: bool) -> IUp33Router::Route {
        IUp33Router::Route {
            from,
            to,
            stable,
            factory: self.factory_address,
        }
    }

    async fn pool(&self, a: Address, b: Address, stable: bool) -> Result<bool, Error> {
        self.factory
            .getPool(a, b, stable)
            .call()
            .await
            .map(|p| !p.is_zero())
            .map_err(Error::Rpc)
    }
}

fn classify_quote_error(err: alloy::contract::Error) -> Error {
    use ethrpc::alloy::errors::ContractErrorExt;
    if matches!(&err, alloy::contract::Error::TransportError(t) if t.as_error_resp().is_some())
        && err.is_contract_revert()
    {
        Error::NotFound
    } else {
        Error::Rpc(err)
    }
}
fn subtract_slippage(amount: U256, bps: u16) -> Option<U256> {
    U256::uint_try_from(U512::from(amount) * U512::from(10_000u16 - bps) / U512::from(10_000u16))
        .ok()
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("UP33 configuration contains a zero address")]
    ZeroAddress,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("order is unsupported")]
    OrderNotSupported,
    #[error("UP33 route is unavailable")]
    NotFound,
    #[error("invalid slippage")]
    InvalidSlippage,
    #[error("UP33 RPC call failed: {0}")]
    Rpc(#[source] alloy::contract::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selector_matches_up33_solidly_router() {
        assert_eq!(
            IUp33Router::swapExactTokensForTokensCall::SELECTOR,
            [0xca, 0xc8, 0x8e, 0xa9]
        );
    }
}
