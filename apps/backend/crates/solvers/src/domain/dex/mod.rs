//! Various solver implementations rely on quoting APIs from DEXs and DEX
//! aggregators. This domain module models the various types around quoting
//! single orders with DEXs and turning swaps into single order solutions.

use {
    crate::{
        domain::{self, auction, eth, order, solution},
        infra,
    },
    alloy::primitives::{Address, U256},
    std::fmt::{self, Debug, Formatter},
};

pub mod minimum_surplus;
mod shared;
pub mod slippage;

pub use self::slippage::Slippage;

/// An order for quoting with an external DEX or DEX aggregator. This is a
/// simplified representation of a CoW Protocol order.
#[derive(Debug)]
pub struct Order {
    pub sell: eth::TokenAddress,
    pub buy: eth::TokenAddress,
    pub side: order::Side,
    pub amount: Amount,
    pub owner: eth::Address,
}

impl Order {
    pub fn new(order: &order::Order) -> Self {
        Self {
            sell: order.sell.token,
            buy: order.buy.token,
            side: order.side,
            amount: Amount(match order.side {
                order::Side::Buy => order.buy.amount,
                order::Side::Sell => order.sell.amount,
            }),
            owner: order.owner(),
        }
    }

    /// Returns the order swapped amount as an asset. The token associated with
    /// the asset is dependent on the side of the DEX order.
    pub fn amount(&self) -> eth::Asset {
        eth::Asset {
            token: match self.side {
                order::Side::Buy => self.buy,
                order::Side::Sell => self.sell,
            },
            amount: self.amount.0,
        }
    }
}

/// An on-chain Ethereum call for executing a DEX swap.
pub struct Call {
    /// The address that gets called on-chain.
    pub to: Address,
    /// The associated calldata for the on-chain call.
    pub calldata: Vec<u8>,
}

impl Debug for Call {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        f.debug_struct("Call")
            .field("to", &self.to)
            .field(
                "calldata",
                &format_args!("{}", const_hex::encode_prefixed(&self.calldata)),
            )
            .finish()
    }
}

/// A DEX swap.
#[derive(Debug)]
pub struct Swap {
    /// The Ethereum calls for executing the swap.
    pub calls: Vec<Call>,
    /// The expected input asset for the swap. The executed input may end up
    /// being different because of slippage.
    pub input: eth::Asset,
    /// The expected output asset for the swap. The executed output may end up
    /// being different because of slippage.
    pub output: eth::Asset,
    /// The minimum allowance that is required for executing the swap.
    pub allowance: Allowance,
    /// The gas guesstimate in gas units for the swap.
    ///
    /// This estimate is **not** expected to be accurate, and is purely
    /// indicative.
    pub gas: eth::Gas,
}

impl Swap {
    pub fn allowance(&self) -> solution::Allowance {
        solution::Allowance {
            spender: self.allowance.spender,
            asset: eth::Asset {
                token: self.input.token,
                amount: self.allowance.amount.0,
            },
        }
    }

    /// Constructs a single order `solution::Solution` for this swap. Returns
    /// `None` if the swap is not valid for the specified order.
    pub async fn into_solution(
        self,
        order: order::Order,
        gas_price: auction::GasPrice,
        sell_token: Option<auction::Price>,
        simulator: &infra::dex::Simulator,
        gas_offset: eth::Gas,
    ) -> Option<solution::Solution> {
        let gas = if order.class == order::Class::Limit {
            match simulator.gas(order.owner(), &self).await {
                Ok(value) => value,
                Err(infra::dex::simulator::Error::SettlementContractIsOwner) => self.gas,
                Err(err) => {
                    tracing::warn!(?err, "gas simulation failed");
                    return None;
                }
            }
        } else {
            // We are fine with just using heuristic gas for market orders,
            // since it doesn't really play a role in the final solution.
            self.gas
        };

        let allowance = self.allowance();
        let interactions = self
            .calls
            .into_iter()
            .map(|call| {
                solution::Interaction::Custom(solution::CustomInteraction {
                    target: call.to,
                    value: eth::Ether::default(),
                    calldata: call.calldata,
                    inputs: vec![self.input],
                    outputs: vec![self.output],
                    internalize: false,
                    allowances: vec![allowance.clone()],
                })
            })
            .collect();

        solution::Single {
            order,
            input: self.input,
            output: self.output,
            interactions,
            gas,
            wrappers: vec![],
        }
        .into_dex_solution(gas_price, sell_token, gas_offset)
    }

    pub fn satisfies(&self, order: &domain::order::Order) -> bool {
        self.output
            .amount
            .widening_mul::<_, _, 512, 8>(order.sell.amount)
            >= self.input.amount.widening_mul(order.buy.amount)
    }

    pub fn satisfies_with_minimum_surplus(
        &self,
        order: &domain::order::Order,
        minimum_surplus: &minimum_surplus::MinimumSurplus,
    ) -> bool {
        let required_buy_amount = minimum_surplus.add(order.buy.amount);
        self.output
            .amount
            .widening_mul::<_, _, 512, 8>(order.sell.amount)
            >= self.input.amount.widening_mul(required_buy_amount)
    }

    /// Whether this swap's ERC-20 allowance respects the order's signed limit
    /// price — i.e. the *padded max input the DEX spender is approved to pull*
    /// stays within what the user committed for this (possibly partial) fill.
    ///
    /// This is [`Self::satisfies`] with `allowance.amount` substituted for
    /// `input.amount`: the order's limit price must hold even when the spender
    /// pulls its maximum approval, not just the quoted estimate. A swap that
    /// fails this would let the router pull beyond the fill's signed sell cap,
    /// reaching Settlement's transient buffer.
    ///
    /// - **exactIn:** allowance equals the fixed input, so this is exactly
    ///   `satisfies` — always holds when `satisfies` does.
    /// - **exactOut:** the allowance is padded above the input estimate (the
    ///   router pulls *up to* `maxSrc`); this bounds that pad against the
    ///   order's limit price. For a FULL buy it reduces to
    ///   `allowance <= order.sell.amount`; for a PARTIAL buy it enforces the
    ///   proportional sell cap (output is the scaled-down fill amount).
    ///
    /// For BUY *quotes* the driver sets `sell.amount` to `2**144`, so this
    /// never constrains quoting; it only caps allowances on signed orders.
    pub fn allowance_within_sell_limit(&self, order: &domain::order::Order) -> bool {
        self.output
            .amount
            .widening_mul::<_, _, 512, 8>(order.sell.amount)
            >= self.allowance.amount.get().widening_mul(order.buy.amount)
    }
}

#[cfg(test)]
mod allowance_limit_tests {
    use {
        super::*,
        crate::domain::{eth, order},
        alloy::primitives::address,
    };

    const USDC: Address = address!("0x0b2c639c533813f4aa9d7837caf62653d097ff85");
    const WETH: Address = address!("0x4200000000000000000000000000000000000006");

    /// A BUY swap (sell USDC -> buy WETH) with a given filled `output` (WETH
    /// received) and `allowance` (USDC the router may pull).
    fn buy_swap(output_weth: U256, allowance_usdc: U256) -> Swap {
        Swap {
            calls: vec![],
            input: eth::Asset { amount: allowance_usdc, token: eth::TokenAddress(USDC) },
            output: eth::Asset { amount: output_weth, token: eth::TokenAddress(WETH) },
            allowance: Allowance {
                spender: address!("0x6a000f20005980200259b80c5102003040001068"),
                amount: Amount::new(allowance_usdc),
            },
            gas: eth::Gas(U256::from(100_000u64)),
        }
    }

    /// A signed BUY order: buy `buy_weth` WETH for at most `max_sell_usdc` USDC.
    fn buy_order(buy_weth: U256, max_sell_usdc: U256) -> order::Order {
        order::Order {
            uid: order::Uid([0u8; 56]),
            sell: eth::Asset { amount: max_sell_usdc, token: eth::TokenAddress(USDC) },
            buy: eth::Asset { amount: buy_weth, token: eth::TokenAddress(WETH) },
            side: order::Side::Buy,
            class: order::Class::Market,
            partially_fillable: false,
            flashloan_hint: None,
            wrappers: vec![],
        }
    }

    // Buy 1 WETH for at most 3,000 USDC.
    fn one_weth() -> U256 { U256::from(1_000_000_000_000_000_000u128) }
    fn max_sell() -> U256 { U256::from(3_000_000_000u64) }

    #[test]
    fn full_buy_allowance_at_limit_is_allowed() {
        // Full fill, allowance exactly the signed max-sell.
        let swap = buy_swap(one_weth(), max_sell());
        assert!(swap.allowance_within_sell_limit(&buy_order(one_weth(), max_sell())));
    }

    #[test]
    fn full_buy_allowance_one_wei_over_limit_is_rejected() {
        // The exactOut siphon: a padded allowance one wei over max-sell.
        let swap = buy_swap(one_weth(), max_sell() + U256::from(1u8));
        assert!(!swap.allowance_within_sell_limit(&buy_order(one_weth(), max_sell())));
    }

    #[test]
    fn partial_buy_allowance_within_proportional_cap_is_allowed() {
        // Half fill (0.5 WETH) → proportional cap is 1,500 USDC.
        let half = one_weth() / U256::from(2u8);
        let swap = buy_swap(half, U256::from(1_500_000_000u64));
        assert!(swap.allowance_within_sell_limit(&buy_order(one_weth(), max_sell())));
    }

    #[test]
    fn partial_buy_allowance_over_proportional_cap_is_rejected() {
        // The Codex P1: full max-sell (3,000) approved for a 0.5 WETH fill
        // whose proportional cap is only 1,500 USDC. Must be rejected even
        // though 3,000 <= the full order's 3,000 max-sell.
        let half = one_weth() / U256::from(2u8);
        let swap = buy_swap(half, U256::from(1_500_000_001u64));
        assert!(!swap.allowance_within_sell_limit(&buy_order(one_weth(), max_sell())));
    }

    #[test]
    fn sell_allowance_equal_to_input_is_allowed() {
        // SELL: allowance == fixed input == order.sell.amount; the check is
        // exactly `satisfies` and must hold for a price-satisfying swap.
        let sell_amount = max_sell();
        let order = order::Order {
            uid: order::Uid([0u8; 56]),
            sell: eth::Asset { amount: sell_amount, token: eth::TokenAddress(USDC) },
            buy: eth::Asset { amount: one_weth(), token: eth::TokenAddress(WETH) },
            side: order::Side::Sell,
            class: order::Class::Market,
            partially_fillable: false,
            flashloan_hint: None,
            wrappers: vec![],
        };
        // Output meets the limit exactly; allowance == input == sell_amount.
        let swap = Swap {
            calls: vec![],
            input: eth::Asset { amount: sell_amount, token: eth::TokenAddress(USDC) },
            output: eth::Asset { amount: one_weth(), token: eth::TokenAddress(WETH) },
            allowance: Allowance {
                spender: address!("0x6a000f20005980200259b80c5102003040001068"),
                amount: Amount::new(sell_amount),
            },
            gas: eth::Gas(U256::from(100_000u64)),
        };
        assert!(swap.allowance_within_sell_limit(&order));
    }
}

/// A swap allowance.
#[derive(Debug)]
pub struct Allowance {
    /// The spender address that requires an allowance in order to execute a
    /// swap.
    pub spender: Address,
    /// The amount, in tokens, of the required allowance.
    pub amount: Amount,
}

/// A token amount.
#[derive(Debug)]
pub struct Amount(U256);

impl Amount {
    pub fn new(value: U256) -> Self {
        Self(value)
    }

    pub fn get(&self) -> U256 {
        self.0
    }
}
