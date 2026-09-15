//! Direct, single-pool V3/Slipstream SELL routes. Factories, quoters and routers
//! are pinned in config; no aggregator responses participate in execution.
use {
    crate::{
        domain::{dex, eth, order},
        infra::metrics,
    },
    alloy::primitives::{Address, U256, U512, ruint::UintTryFrom},
    ethrpc::block_context::{Error as RpcError, ReadOnlyRpc},
};

pub struct Config {
    pub chain_id: u64,
    pub node_url: reqwest::Url,
    pub settlement: Address,
    pub factory: Address,
    pub quoter: Address,
    pub router: Address,
    pub tick_spacing: bool,
    pub tiers: Vec<u32>,
    pub metric: metrics::Dex,
}

pub struct DirectV3 {
    config: Config,
    rpc: ReadOnlyRpc,
}

impl DirectV3 {
    pub fn try_new(config: Config) -> Result<Self, RpcError> {
        Ok(Self {
            rpc: ReadOnlyRpc::try_new(
                config.node_url.clone(),
                config.chain_id,
                "ophis-direct-v3/1.0",
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
        if order.side != order::Side::Sell
            || order.sell == order.buy
            || order.sell.0.is_zero()
            || order.buy.0.is_zero()
        {
            return Err(Error::OrderNotSupported);
        }
        let c = &self.config;
        let context = self.rpc.snapshot().await?;
        let mut best = None;
        // ponytail: single-pool search over pinned tiers; add multihop when measured pairs need it.
        for &tier in &c.tiers {
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
            if Address::from_slice(&pool[12..]).is_zero() {
                continue;
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
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            if data.len() != 128 {
                return Err(Error::InvalidResponse);
            }
            let output = U256::from_be_slice(&data[..32]);
            let gas = U256::from_be_slice(&data[96..]).saturating_add(U256::from(180_000));
            if !output.is_zero() && best.as_ref().is_none_or(|&(_, amount, _)| output > amount) {
                best = Some((tier, output, gas));
            }
        }
        let (tier, quoted, gas) = best.ok_or(Error::NotFound)?;
        let bps = metrics::clamp_slippage_bps(
            c.metric,
            slippage.as_bps().ok_or(Error::InvalidSlippage)?,
            2_000,
        );
        let bps = if is_quote {
            bps
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
                amount: min_out,
            },
            allowance: dex::Allowance {
                spender: c.router,
                amount: dex::Amount::new(order.amount.get()),
            },
            gas: eth::Gas(gas),
        })
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
    sell: Address,
    buy: Address,
    tier: u32,
    recipient: Address,
    input: U256,
    output: U256,
) -> Vec<u8> {
    let mut words = vec![word(sell), word(buy), U256::from(tier), word(recipient)];
    if tick_spacing {
        words.push(U256::MAX);
    }
    words.extend([input, output, U256::ZERO]);
    encode(
        if tick_spacing {
            [0xa0, 0x26, 0x38, 0x3e]
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
        interface CL { struct Params { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; } function exactInputSingle(Params p) external; }
    }
    #[test]
    fn calldata_matches_both_router_abis() {
        let sell = Address::repeat_byte(1);
        let buy = Address::repeat_byte(2);
        let recipient = Address::repeat_byte(3);
        let amount = U256::from(100);
        let min = U256::from(99);
        let a = swap_calldata(false, sell, buy, 500, recipient, amount, min);
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
        let a = swap_calldata(true, sell, buy, 10, recipient, amount, min);
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
