//! Various solver implementations rely on quoting APIs from DEXs and DEX
//! aggregators. This domain module models the various types around quoting
//! single orders with DEXs and turning swaps into single order solutions.

use {
    crate::{
        domain::{self, auction, eth, order, solution},
        infra,
    },
    alloy::primitives::{Address, U256},
    bigdecimal::BigDecimal,
    number::conversions::u256_to_big_int,
    std::fmt::{self, Debug, Formatter},
};

/// Configuration for the output-side anti-siphon guards applied to DEX
/// aggregator swaps at the [`Swap::into_solution`] choke point. Every DEX
/// aggregator lane funnels through that method; the baseline solver does not,
/// so these guards never touch it.
#[derive(Clone, Debug)]
pub struct OutputGuard {
    /// Coarse reference-price ceiling: reject a SELL swap whose reported output
    /// is worth more than this factor times its input at the auction's
    /// independent reference prices. Reference prices come from the CoW driver,
    /// never the aggregator. Fails open when either price is missing, so this
    /// only catches egregious over-reports (default `25.0`, loose because the
    /// sovereign chains' native price oracle can misprice a token by >2x; the
    /// strict output simulation is the ground-truth guard).
    pub max_output_reference_factor: BigDecimal,
    /// Whether to run the strict output-delivery simulation for SELL swaps.
    pub strict_output_simulation: bool,
    /// When to run the strict output-delivery simulation for MARKET SELL swaps.
    pub strict_market_output_simulation: MarketOutputSimulation,
    /// Skip the strict MARKET output simulation for orders whose native (wei)
    /// value is below this threshold (default `0`, i.e. never skip).
    pub market_output_simulation_min_native_value: eth::U256,
}

/// Selects when the strict output-delivery simulation runs for MARKET SELL
/// swaps (LIMIT swaps always run it, as they already simulate for gas).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketOutputSimulation {
    /// Never run the strict simulation for MARKET orders.
    Off,
    /// Run only when the buy token is buffer exposed (the settlement holds a
    /// balance an over-report could drain).
    BufferExposed,
    /// Always run for MARKET orders (subject to the min native value).
    All,
}

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
    ///
    /// This is the single cross-lane choke point for every DEX aggregator lane,
    /// so it is where the OUTPUT-side anti-siphon guards live: a compromised
    /// aggregator edge could echo an inflated `output.amount`, which sets the
    /// buy-side clearing price and would make the CoW settlement overpay the
    /// user out of its OWN buffer. Both guards apply to SELL orders only (an
    /// exactOut BUY has a user-fixed output that is never solver-derived).
    #[allow(clippy::too_many_arguments)]
    pub async fn into_solution(
        self,
        order: order::Order,
        gas_price: auction::GasPrice,
        sell_token: Option<auction::Price>,
        tokens: &auction::Tokens,
        simulator: &infra::dex::Simulator,
        gas_offset: eth::Gas,
        output_guard: &OutputGuard,
        // Whether this auction is a price quote (never settles). A quote's owner
        // is unfunded, so the strict output simulation cannot run; a quote must
        // NOT be rejected on that basis (it drains nothing), whereas a real
        // (settle-able) solve is failed closed. See `output_delivery_proven`.
        is_quote: bool,
    ) -> Option<solution::Solution> {
        let sell_side = order.side == order::Side::Sell;

        // Part 1: coarse reference-price ceiling. Cheap, no latency, fails open
        // on missing prices; catches only egregious (> factor) over-reports.
        if sell_side
            && !self.output_within_price_reference(tokens, &output_guard.max_output_reference_factor)
        {
            tracing::warn!(
                input = ?self.input,
                output = ?self.output,
                "dex swap output exceeds reference-price ceiling; rejecting"
            );
            return None;
        }

        // Part 2: strict output-delivery simulation. For LIMIT orders this also
        // supplies the gas estimate (replacing the plain gas simulation with
        // the same latency profile). For MARKET orders it runs only when the
        // config requires it (buy token buffer exposed, by default). It runs
        // BEFORE any buffer internalization, simulating the DEX calls
        // non-internalized, so a legitimate later internalization cannot hide
        // an under-delivery.
        let strict_output = sell_side
            && output_guard.strict_output_simulation
            && self.strict_output_required(&order, tokens, output_guard);

        let gas = if order.class == order::Class::Limit {
            if strict_output {
                match simulator.gas_with_output(order.owner(), &self).await {
                    Ok(sim) => {
                        if !self.output_delivery_proven(sim.realized_output, is_quote, tokens) {
                            tracing::warn!(
                                output = ?self.output,
                                realized = ?sim.realized_output,
                                "strict output simulation: interactions under-deliver reported \
                                 output; rejecting"
                            );
                            return None;
                        }
                        sim.gas
                    }
                    Err(infra::dex::simulator::Error::SettlementContractIsOwner) => {
                        // Cannot simulate (owner collides with the settlement
                        // contract). Same policy as an unprovable swap: accept a
                        // quote or a non-buffer-exposed swap; fail closed on a
                        // buffer-exposed real solve.
                        if is_quote || !self.buy_is_buffer_exposed(tokens) {
                            self.gas
                        } else {
                            return None;
                        }
                    }
                    Err(err) => {
                        // A sim that reverts or errors follows the same policy as
                        // SettlementContractIsOwner above: price a quote or a
                        // non-buffer-exposed swap on heuristic gas rather than
                        // dropping it; fail closed on a buffer-exposed real solve.
                        tracing::warn!(?err, "strict output simulation errored");
                        if is_quote || !self.buy_is_buffer_exposed(tokens) {
                            self.gas
                        } else {
                            return None;
                        }
                    }
                }
            } else {
                match simulator.gas(order.owner(), &self).await {
                    Ok(value) => value,
                    Err(infra::dex::simulator::Error::SettlementContractIsOwner) => self.gas,
                    Err(err) => {
                        // A quote must not be dropped on a plain-gas-sim failure:
                        // a flooring DEX lane reports the OPTIMISTIC output on
                        // quotes, which the Swapper.sol gas sim (buy.amount ==
                        // output.amount) cannot realize, so it reverts. Quotes
                        // never settle, so price them on heuristic gas instead of
                        // dropping them; a real solve still fails closed. Mirrors
                        // the strict-output path's quote policy above.
                        if is_quote {
                            self.gas
                        } else {
                            tracing::warn!(?err, "gas simulation failed");
                            return None;
                        }
                    }
                }
            }
        } else {
            // We are fine with just using heuristic gas for market orders,
            // since it doesn't really play a role in the final solution. The
            // strict output check, when required, still runs and can reject.
            if strict_output {
                match simulator.gas_with_output(order.owner(), &self).await {
                    Ok(sim) => {
                        if !self.output_delivery_proven(sim.realized_output, is_quote, tokens) {
                            tracing::warn!(
                                output = ?self.output,
                                realized = ?sim.realized_output,
                                "strict output simulation: interactions under-deliver reported \
                                 output; rejecting"
                            );
                            return None;
                        }
                    }
                    Err(infra::dex::simulator::Error::SettlementContractIsOwner) => {
                        // Cannot simulate. Fail closed on a buffer-exposed real
                        // solve; accept a quote or non-buffer-exposed swap.
                        if !is_quote && self.buy_is_buffer_exposed(tokens) {
                            return None;
                        }
                    }
                    Err(err) => {
                        // A sim that reverts or errors follows the same policy as
                        // SettlementContractIsOwner above: accept a quote or a
                        // non-buffer-exposed swap; fail closed on a buffer-exposed
                        // real solve.
                        tracing::warn!(?err, "strict output simulation errored");
                        if !is_quote && self.buy_is_buffer_exposed(tokens) {
                            return None;
                        }
                    }
                }
            }
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

    /// OUTPUT-side anti-siphon, part 1 (coarse reference-price ceiling).
    ///
    /// Returns `false` (reject) when this swap's reported `output` is worth
    /// more than `max_factor` times its `input` at the auction's INDEPENDENT
    /// native reference prices (from the CoW driver, NEVER the aggregator). A
    /// hijacked aggregator edge inflating `output.amount` sets the buy-side
    /// clearing price, which the settlement would honor out of its own buffer.
    ///
    /// Fails OPEN (returns `true`) when either reference price is missing or a
    /// price multiplication overflows: reference prices can be stale by tens of
    /// percent, so this only catches egregious over-reports and never blocks a
    /// swap merely because a price is unavailable. The strict simulation (part
    /// 2) is the ground-truth guard.
    pub fn output_within_price_reference(
        &self,
        tokens: &auction::Tokens,
        max_factor: &BigDecimal,
    ) -> bool {
        let (Some(in_price), Some(out_price)) = (
            tokens.reference_price(&self.input.token),
            tokens.reference_price(&self.output.token),
        ) else {
            return true;
        };
        let (Some(in_value), Some(out_value)) = (
            in_price.native_value(self.input.amount),
            out_price.native_value(self.output.amount),
        ) else {
            return true;
        };
        let in_value = BigDecimal::from(u256_to_big_int(&in_value));
        let out_value = BigDecimal::from(u256_to_big_int(&out_value));
        out_value <= in_value * max_factor
    }

    /// Whether the buy (output) token is "buffer exposed": the settlement holds
    /// a balance of it that an inflated, unproven output could drain. Only such
    /// tokens make the output-side siphon possible, so they gate whether the
    /// strict MARKET output simulation runs (`strict_output_required`) AND
    /// whether an unprovable (simulation-unavailable) real SOLVE is rejected --
    /// a quote is never rejected on that basis. See `output_delivery_proven`.
    pub fn buy_is_buffer_exposed(&self, tokens: &auction::Tokens) -> bool {
        tokens
            .get(&self.output.token)
            .map(|token| !token.available_balance.is_zero())
            .unwrap_or(false)
    }

    /// Whether this swap's native (wei) value clears the configured minimum for
    /// running the strict MARKET output simulation. Fails toward running the
    /// simulation (returns `true`) when the value cannot be priced.
    fn meets_min_native_value(&self, tokens: &auction::Tokens, guard: &OutputGuard) -> bool {
        if guard.market_output_simulation_min_native_value.is_zero() {
            return true;
        }
        match tokens
            .reference_price(&self.output.token)
            .and_then(|price| price.native_value(self.output.amount))
        {
            Some(value) => value >= guard.market_output_simulation_min_native_value,
            None => true,
        }
    }

    /// Whether the strict output-delivery simulation should run for `order`.
    /// LIMIT orders always run it (they already simulate for gas); MARKET
    /// orders run it per the configured [`MarketOutputSimulation`] mode.
    fn strict_output_required(
        &self,
        order: &order::Order,
        tokens: &auction::Tokens,
        guard: &OutputGuard,
    ) -> bool {
        match order.class {
            order::Class::Limit => true,
            order::Class::Market => match guard.strict_market_output_simulation {
                MarketOutputSimulation::Off => false,
                MarketOutputSimulation::BufferExposed => {
                    self.buy_is_buffer_exposed(tokens) && self.meets_min_native_value(tokens, guard)
                }
                MarketOutputSimulation::All => self.meets_min_native_value(tokens, guard),
            },
        }
    }

    /// Given the realized output measured by the strict simulation, whether the
    /// swap's reported output delivery has been DISPROVEN (returns false only on
    /// a proven shortfall).
    ///
    /// - `Some(realized)`: the interactions themselves must deliver at least the
    ///   reported `output.amount`; a buffer-covered shortfall shows up as
    ///   `realized < output.amount` and is rejected. This is the real guard and
    ///   it runs for every normal, settle-able order (whose owner holds the sell
    ///   token, so the Swapper simulation succeeds).
    /// - `None`: the simulation could not run at all. The Swapper returns
    ///   `gasUsed == 0` ONLY when the owner-address swapper lacks the sell
    ///   balance (owner unfunded at simulation time). Two disjoint cases land
    ///   here: a QUOTE (`is_quote`; priced but never settled, so nothing can be
    ///   drained -- accept it, since rejecting quotes 404'd all /quote pricing
    ///   for buffer-exposed buy tokens), and a hook-funded SOLVE (owner funded
    ///   later by pre-hooks, so it CAN settle and over-report). For a real solve
    ///   we therefore fail CLOSED when the buy token is buffer exposed (drop the
    ///   unprovable order) and only accept when no buffer could be drained. A
    ///   normal drainable order always funds the owner, so the simulation runs
    ///   and returns `Some`; it never lands here.
    fn output_delivery_proven(
        &self,
        realized: Option<U256>,
        is_quote: bool,
        tokens: &auction::Tokens,
    ) -> bool {
        match realized {
            Some(realized) => realized >= self.output.amount,
            None => is_quote || !self.buy_is_buffer_exposed(tokens),
        }
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

#[cfg(test)]
mod output_guard_tests {
    use {
        super::*,
        crate::domain::{auction, eth, order},
        alloy::primitives::address,
        std::collections::HashMap,
    };

    const USDC: Address = address!("0x0b2c639c533813f4aa9d7837caf62653d097ff85");
    const WETH: Address = address!("0x4200000000000000000000000000000000000006");
    const SPENDER: Address = address!("0x6a000f20005980200259b80c5102003040001068");

    /// Reference price where value equals amount (1 wei per 1e18 base units).
    const UNIT_PRICE: u128 = 1_000_000_000_000_000_000;

    fn tok(a: Address) -> eth::TokenAddress {
        eth::TokenAddress(a)
    }

    /// Build a `Tokens` map from `(address, reference_price, available_balance)`
    /// tuples. A `None` price means the token has no reference price.
    fn tokens(entries: &[(Address, Option<u128>, u128)]) -> auction::Tokens {
        auction::Tokens(
            entries
                .iter()
                .map(|(addr, price, bal)| {
                    (
                        tok(*addr),
                        auction::Token {
                            decimals: None,
                            symbol: None,
                            reference_price: price
                                .map(|p| auction::Price(eth::Ether(U256::from(p)))),
                            available_balance: U256::from(*bal),
                            trusted: true,
                        },
                    )
                })
                .collect::<HashMap<_, _>>(),
        )
    }

    /// A SELL swap: sell `input` USDC for `output` WETH.
    fn sell_swap(input: u128, output: u128) -> Swap {
        Swap {
            calls: vec![],
            input: eth::Asset {
                amount: U256::from(input),
                token: tok(USDC),
            },
            output: eth::Asset {
                amount: U256::from(output),
                token: tok(WETH),
            },
            allowance: Allowance {
                spender: SPENDER,
                amount: Amount::new(U256::from(input)),
            },
            gas: eth::Gas(U256::from(100_000u64)),
        }
    }

    fn order_with(side: order::Side, class: order::Class) -> order::Order {
        order::Order {
            uid: order::Uid([0u8; 56]),
            sell: eth::Asset {
                amount: U256::from(1_000u64),
                token: tok(USDC),
            },
            buy: eth::Asset {
                amount: U256::from(1_000u64),
                token: tok(WETH),
            },
            side,
            class,
            partially_fillable: false,
            flashloan_hint: None,
            wrappers: vec![],
        }
    }

    fn factor(f: i64) -> BigDecimal {
        BigDecimal::new(f.into(), 0)
    }

    fn guard(mode: MarketOutputSimulation, min_native: u128) -> OutputGuard {
        OutputGuard {
            max_output_reference_factor: factor(2),
            strict_output_simulation: true,
            strict_market_output_simulation: mode,
            market_output_simulation_min_native_value: U256::from(min_native),
        }
    }

    // --- Part 1: coarse reference-price ceiling ---

    #[test]
    fn ceiling_rejects_egregious_over_report() {
        // Both tokens priced 1:1 with the native asset (value == amount).
        let t = tokens(&[(USDC, Some(UNIT_PRICE), 0), (WETH, Some(UNIT_PRICE), 0)]);
        // Output worth 3x the input at reference prices, above the 2.0 factor.
        assert!(!sell_swap(1_000, 3_000).output_within_price_reference(&t, &factor(2)));
    }

    #[test]
    fn ceiling_allows_output_within_factor() {
        let t = tokens(&[(USDC, Some(UNIT_PRICE), 0), (WETH, Some(UNIT_PRICE), 0)]);
        // 1.5x is allowed, and exactly 2.0x is allowed (boundary inclusive).
        assert!(sell_swap(1_000, 1_500).output_within_price_reference(&t, &factor(2)));
        assert!(sell_swap(1_000, 2_000).output_within_price_reference(&t, &factor(2)));
    }

    #[test]
    fn ceiling_fails_open_on_missing_price() {
        // The output token has no reference price: the coarse tripwire is a
        // no-op (accept) even for a wildly inflated output.
        let t = tokens(&[(USDC, Some(UNIT_PRICE), 0), (WETH, None, 0)]);
        assert!(sell_swap(1_000, 1_000_000).output_within_price_reference(&t, &factor(2)));
    }

    #[test]
    fn native_value_is_amount_scaled_by_price() {
        let unit = auction::Price(eth::Ether(U256::from(UNIT_PRICE)));
        assert_eq!(unit.native_value(U256::from(1_234u64)), Some(U256::from(1_234u64)));
        let half = auction::Price(eth::Ether(U256::from(UNIT_PRICE / 2)));
        assert_eq!(half.native_value(U256::from(1_000u64)), Some(U256::from(500u64)));
    }

    // --- Part 2: strict output-delivery simulation gating ---

    #[test]
    fn buffer_exposure_reflects_available_balance() {
        let exposed = tokens(&[(WETH, Some(UNIT_PRICE), 5)]);
        assert!(sell_swap(1_000, 1_000).buy_is_buffer_exposed(&exposed));
        let empty = tokens(&[(WETH, Some(UNIT_PRICE), 0)]);
        assert!(!sell_swap(1_000, 1_000).buy_is_buffer_exposed(&empty));
        let missing = tokens(&[(USDC, Some(UNIT_PRICE), 0)]);
        assert!(!sell_swap(1_000, 1_000).buy_is_buffer_exposed(&missing));
    }

    #[test]
    fn strict_required_for_limit_regardless_of_buffer() {
        // A LIMIT order always runs the strict variant (it already simulates
        // for gas), even with the market mode off and no buffer.
        let t = tokens(&[(WETH, Some(UNIT_PRICE), 0)]);
        let order = order_with(order::Side::Sell, order::Class::Limit);
        assert!(sell_swap(1_000, 1_000).strict_output_required(
            &order,
            &t,
            &guard(MarketOutputSimulation::Off, 0)
        ));
    }

    #[test]
    fn strict_market_off_never_runs() {
        let t = tokens(&[(WETH, Some(UNIT_PRICE), 5)]);
        let order = order_with(order::Side::Sell, order::Class::Market);
        assert!(!sell_swap(1_000, 1_000).strict_output_required(
            &order,
            &t,
            &guard(MarketOutputSimulation::Off, 0)
        ));
    }

    #[test]
    fn strict_market_buffer_exposed_gates_on_buffer() {
        let order = order_with(order::Side::Sell, order::Class::Market);
        let exposed = tokens(&[(WETH, Some(UNIT_PRICE), 5)]);
        assert!(sell_swap(1_000, 1_000).strict_output_required(
            &order,
            &exposed,
            &guard(MarketOutputSimulation::BufferExposed, 0)
        ));
        let empty = tokens(&[(WETH, Some(UNIT_PRICE), 0)]);
        assert!(!sell_swap(1_000, 1_000).strict_output_required(
            &order,
            &empty,
            &guard(MarketOutputSimulation::BufferExposed, 0)
        ));
    }

    #[test]
    fn strict_market_all_runs_without_buffer() {
        let order = order_with(order::Side::Sell, order::Class::Market);
        let empty = tokens(&[(WETH, Some(UNIT_PRICE), 0)]);
        assert!(sell_swap(1_000, 1_000).strict_output_required(
            &order,
            &empty,
            &guard(MarketOutputSimulation::All, 0)
        ));
    }

    #[test]
    fn strict_market_respects_min_native_value() {
        let order = order_with(order::Side::Sell, order::Class::Market);
        let exposed = tokens(&[(WETH, Some(UNIT_PRICE), 5)]);
        let g = guard(MarketOutputSimulation::BufferExposed, 2_000);
        // Output value 1_000 < 2_000 min -> skip.
        assert!(!sell_swap(1_000, 1_000).strict_output_required(&order, &exposed, &g));
        // Output value 3_000 >= 2_000 min -> run.
        assert!(sell_swap(1_000, 3_000).strict_output_required(&order, &exposed, &g));
    }

    #[test]
    fn delivery_proven_only_when_realized_meets_output() {
        let t = tokens(&[(WETH, Some(UNIT_PRICE), 5)]);
        let swap = sell_swap(1_000, 1_000);
        // A run simulation (Some) is the real guard, independent of is_quote.
        assert!(swap.output_delivery_proven(Some(U256::from(1_000u64)), false, &t));
        assert!(swap.output_delivery_proven(Some(U256::from(1_500u64)), false, &t));
        // A buffer-covered shortfall surfaces as realized < output -> rejected.
        assert!(!swap.output_delivery_proven(Some(U256::from(999u64)), false, &t));
    }

    #[test]
    fn delivery_unproven_gated_by_quote_then_buffer() {
        // Simulation unavailable (realized None: owner unfunded at sim time).
        let swap = sell_swap(1_000, 1_000);
        let exposed = tokens(&[(WETH, Some(UNIT_PRICE), 5)]);
        let empty = tokens(&[(WETH, Some(UNIT_PRICE), 0)]);
        // QUOTE never settles -> accept regardless of buffer (fixes the /quote
        // 404 regression: rejecting these broke all pricing for USDC/WETH).
        assert!(swap.output_delivery_proven(None, true, &exposed));
        assert!(swap.output_delivery_proven(None, true, &empty));
        // Real SOLVE (e.g. hook-funded, CAN settle) -> fail closed on a
        // buffer-exposed buy token; accept only when no buffer could be drained.
        assert!(!swap.output_delivery_proven(None, false, &exposed));
        assert!(swap.output_delivery_proven(None, false, &empty));
    }

    // --- into_solution gating: SELL guarded, exactOut BUY untouched ---

    fn simulator() -> infra::dex::Simulator {
        // A never-dialed simulator: the paths exercised below return before any
        // RPC call. The URL is unreachable on purpose.
        infra::dex::Simulator::new(
            &"http://localhost:1/".parse().unwrap(),
            Address::ZERO,
            address!("0x1111111111111111111111111111111111111111"),
        )
    }

    #[tokio::test]
    async fn sell_ceiling_reject_returns_none() {
        // A SELL market order whose reported output is 3x the input value is
        // rejected by the reference-price ceiling before any simulation.
        let t = tokens(&[(USDC, Some(UNIT_PRICE), 0), (WETH, Some(UNIT_PRICE), 0)]);
        let order = order_with(order::Side::Sell, order::Class::Market);
        let solution = sell_swap(1_000, 3_000)
            .into_solution(
                order,
                auction::GasPrice(eth::Ether(U256::from(1u64))),
                None,
                &t,
                &simulator(),
                eth::Gas(U256::ZERO),
                &guard(MarketOutputSimulation::BufferExposed, 0),
                false,
            )
            .await;
        assert!(solution.is_none());
    }

    #[tokio::test]
    async fn buy_exact_out_untouched_by_ceiling() {
        // The same 3x output on an exactOut BUY (output is the user's fixed buy
        // amount) is NOT guarded: no ceiling, no strict sim, so `into_solution`
        // still produces a solution without dialing the simulator.
        let t = tokens(&[(USDC, Some(UNIT_PRICE), 0), (WETH, Some(UNIT_PRICE), 0)]);
        let mut order = order_with(order::Side::Buy, order::Class::Market);
        // Full buy: fixed buy amount equals the swap output; max sell covers it.
        order.buy.amount = U256::from(3_000u64);
        order.sell.amount = U256::from(1_000u64);
        let solution = sell_swap(1_000, 3_000)
            .into_solution(
                order,
                auction::GasPrice(eth::Ether(U256::from(1u64))),
                None,
                &t,
                &simulator(),
                eth::Gas(U256::ZERO),
                &guard(MarketOutputSimulation::BufferExposed, 0),
                false,
            )
            .await;
        assert!(solution.is_some());
    }
}
