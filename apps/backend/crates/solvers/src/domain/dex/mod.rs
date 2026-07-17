//! Various solver implementations rely on quoting APIs from DEXs and DEX
//! aggregators. This domain module models the various types around quoting
//! single orders with DEXs and turning swaps into single order solutions.

use {
    crate::{
        domain::{self, auction, eth, order, solution},
        infra,
    },
    alloy::primitives::{Address, U256, U512, ruint::UintTryFrom},
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
    /// The order's signed minimum buy amount for THIS (possibly partial) fill,
    /// at the order's limit price. On the SELL solve path the flooring
    /// aggregator lanes bound the router's minReturn to at least this so a swap
    /// the order would actually accept is never dropped by `satisfies`: the
    /// fixed-slippage floor can otherwise sit below the limit when the user's
    /// slippage is tighter than the solver's, leaving an optimistically-quoted
    /// order unsettleable. Ignored on the quote path (which reports optimistic)
    /// and for BUY (exactOut pins the output).
    pub buy_limit: eth::U256,
    pub owner: eth::Address,
    /// Parameters for estimating the solver's surplus fee (gas recovery, taken
    /// in the SELL token) at slippage-bounding time. Populated by the solver
    /// layer from the auction; defaults to a zero fee (bounding then targets
    /// the bare `buy_limit`, the pre-fee-aware behavior).
    pub solve_fee: SolveFee,
}

/// Inputs for estimating the surplus fee a LIMIT-order solution will carry.
///
/// `Solution::into_dex_solution` charges the user
/// `ether_value((solution_gas + gas_offset) × gas_price)` in SELL tokens and
/// credits the buy side only `(sell − fee) × output / sell` (ceil), so the
/// router floor must exceed the order's `buy_limit` by the fee-scaled margin or
/// the solution is rejected as "limit price not satisfied" AFTER the swap was
/// built. This struct lets the flooring lanes reproduce that fee (with a
/// conservative gas estimate) BEFORE choosing the router slippage, so the
/// bounded minReturn covers the fee-inflated bar. Discovered live on Unichain
/// 2026-07-17: every default-slippage market order was unsettleable because the
/// bounded floor undershot the bar by exactly the fee (sub-bp to a few bp).
#[derive(Clone, Copy, Debug, Default)]
pub struct SolveFee {
    /// The auction's effective gas price, in wei per gas unit.
    pub gas_price: eth::Ether,
    /// The solver's configured gas offset (added to the swap gas when the fee
    /// is computed, mirroring `into_dex_solution`).
    pub gas_offset: eth::Gas,
    /// The auction reference price of the SELL token. `None` when the auction
    /// carries no price — the fee estimate is then zero (fail-open to the
    /// pre-fee-aware behavior; `into_dex_solution` also returns no solution
    /// without a sell price, so nothing is lost).
    pub sell_price: Option<auction::Price>,
    /// The order's FULL signed sell amount (not the fill). The surplus fee is
    /// charged ON TOP of the routed input up to this cap
    /// (`into_dex_solution`: `sell = min(input + fee, order.sell.amount)`), so
    /// for a partial fill with room above it the fee raises the limit bar
    /// proportionally but the swap output is credited in full; only when the
    /// cap binds does the fee eat into the credited buy. Zero (the default)
    /// means "assume the cap binds" — the conservative full-fill shape.
    pub total_sell: eth::U256,
    /// The order's FULL signed buy amount (the limit-price counterpart of
    /// `total_sell`). Zero (the default) falls back to the fill-scaled
    /// `buy_limit`.
    pub total_buy: eth::U256,
}

impl SolveFee {
    /// Estimated surplus fee in SELL-token atoms for a swap expected to use
    /// `gas` units of gas. Mirrors `into_dex_solution`'s
    /// `ether_value((gas + gas_offset) × gas_price)` and adds 1 atom so the
    /// estimate is never below the final (floored) fee for the same gas.
    /// Returns zero on a missing sell price or arithmetic overflow (fail-open:
    /// bounding then targets the bare buy limit, as before fee-awareness).
    pub fn fee_in_sell(&self, gas: eth::Gas) -> eth::U256 {
        let Some(price) = self.sell_price else {
            return U256::ZERO;
        };
        let Some(total_wei) = gas
            .0
            .checked_add(self.gas_offset.0)
            .and_then(|g| g.checked_mul(self.gas_price.0))
        else {
            return U256::ZERO;
        };
        price
            .ether_value(eth::Ether(total_wei))
            .map(|fee| fee.saturating_add(U256::from(1)))
            .unwrap_or(U256::ZERO)
    }
}

/// Extra gas added to a lane's padded API gas estimate when estimating the
/// surplus fee for slippage bounding. When the strict output simulation
/// succeeds, `into_dex_solution` uses the SIMULATED gas — a full `settle()`
/// including transfers and approvals — which can exceed the aggregator API's
/// route-only estimate (observed on Unichain: velora API 193k padded vs 307k
/// simulated). Over-estimating only tightens the router floor by the
/// fee-difference (sub-bp on typical trades); under-estimating recreates the
/// unsettleable-order bug this margin exists to prevent.
pub const SIM_SETTLE_OVERHEAD_GAS: u64 = 200_000;

/// Gas estimate used for slippage bounding when the aggregator's gas string
/// does not parse. Deliberately LARGE: an over-estimate only tightens the
/// router floor, while treating unparseable gas as zero would under-estimate
/// the fee and recreate the unsettleable-order bug for that lane. (The lanes
/// fail the whole swap on an unparseable BUILD-stage gas anyway; this covers
/// the bounding-stage string diverging from it.)
pub const UNPARSEABLE_GAS_FALLBACK: u64 = 3_000_000;

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
            // For a SELL this is the signed min-buy (scaled to the fill by the
            // caller); for a BUY it is the exact requested output. Unused on the
            // BUY floor path but carried uniformly.
            buy_limit: order.buy.amount,
            owner: order.owner(),
            solve_fee: SolveFee::default(),
        }
    }

    /// SELL solve path only: the aggregator slippage (bps) to actually send so
    /// the router's guaranteed minReturn covers the order's signed buy limit
    /// PLUS the estimated surplus fee. Returns the TIGHTER of the solver's
    /// configured slippage and the slippage implied by the fee-inflated limit
    /// vs the optimistic route output, so a loose order keeps the configured
    /// floor while a tight one is bounded to its (fee-adjusted) limit.
    ///
    /// The fee matters because `into_dex_solution` credits the buy side only
    /// `(sell − fee) × output / sell`: a floor that covers the bare limit
    /// still fails the limit check by ~fee/sell (the 2026-07-17 Unichain
    /// unsettleable-orders bug). `swap_gas_estimate` should be the lane's
    /// padded API gas plus [`SIM_SETTLE_OVERHEAD_GAS`], so the estimated fee
    /// upper-bounds the fee the solution will actually carry.
    ///
    /// `reprice_margin_bps` is subtracted from the IMPLIED bound (floored at
    /// 0) for lanes whose build step re-prices the optimistic base the bound
    /// was computed against (KyberSwap's `/route/build` re-quotes below
    /// `/routes` by ~1 bp; the margin keeps the re-priced minReturn above the
    /// bar). Loose orders that keep the configured slippage are unaffected —
    /// their floor is derived from the build-stage base itself and needs no
    /// cross-call margin.
    pub fn bounded_solve_slippage_bps(
        &self,
        optimistic: eth::U256,
        configured_bps: u16,
        swap_gas_estimate: eth::Gas,
        reprice_margin_bps: u16,
    ) -> u16 {
        // Inflate the signed buy limit so the router floor also covers the
        // surplus fee, mirroring `into_dex_solution` + the limit check
        // EXACTLY: the fee is charged on top of the routed input up to the
        // order's full signed sell (`sell = min(input + fee, total_sell)`),
        // the credited buy is `ceil((sell − fee) × output / input)`, and the
        // check is `total_sell × buy >= total_buy × sell`. Two regimes:
        //
        // - UNCAPPED (input + fee <= total_sell, partial fills with room):
        //   credited = output, bar = ceil(total_buy × (input + fee) /
        //   total_sell) — the fee raises the bar proportionally.
        // - CAPPED (input + fee > total_sell; always for a full fill):
        //   bar = total_buy, credited factor = total_sell − fee, so the
        //   minimal output is floor((total_buy − 1) × input /
        //   (total_sell − fee)) + 1.
        //
        // Widened to U512 so huge-supply tokens cannot overflow into a
        // fail-open under-bound; a target that overflows U256 is unreachable,
        // so fail closed with zero slippage instead. Zero totals (context not
        // populated) fall back to the full-fill shape over the fill-scaled
        // `buy_limit` — the conservative pre-context behavior.
        let fee = self.solve_fee.fee_in_sell(swap_gas_estimate);
        let amount = self.amount.0;
        let total_sell = match self.solve_fee.total_sell {
            t if t.is_zero() || t < amount => amount,
            t => t,
        };
        let total_buy = match self.solve_fee.total_buy {
            t if t.is_zero() => self.buy_limit,
            t => t,
        };
        let target = if fee.is_zero() || total_buy.is_zero() {
            self.buy_limit
        } else if amount.saturating_add(fee) <= total_sell {
            // UNCAPPED: bar = ceil(total_buy × (input + fee) / total_sell).
            let num = U512::from(total_buy) * (U512::from(amount) + U512::from(fee));
            let den = U512::from(total_sell);
            match U256::uint_try_from((num + den - U512::from(1u8)) / den) {
                Ok(target) => target,
                Err(_) => return 0,
            }
        } else if fee >= total_sell {
            // The fee alone consumes the order's whole signed sell: no output
            // can satisfy the limit check; send zero slippage (the tightest
            // safe bound) and let the limit check drop the swap — the order
            // is economically unsettleable at this gas price.
            return 0;
        } else {
            // CAPPED: minimal output with ceil((total_sell − fee) × out /
            // input) >= total_buy.
            let num = U512::from(total_buy - U256::from(1)) * U512::from(amount);
            let den = U512::from(total_sell - fee);
            match U256::uint_try_from(num / den + U512::from(1u8)) {
                Ok(target) => target,
                Err(_) => return 0,
            }
        };
        // Target at or above the optimistic route output: send zero slippage so
        // the router must realize the full optimistic (the tightest safe bound);
        // if the market can't deliver it the swap is correctly not settled.
        if target >= optimistic || optimistic.is_zero() {
            return 0;
        }
        let bps = eth::U256::from(10_000u64);
        // implied = (optimistic - target) / optimistic, in bps. In [0, 10000)
        // since 0 < target < optimistic, so the u16 cast never truncates; the
        // checked mul only fails for absurd optimistic values (> ~1e73), where
        // the configured slippage is the right answer anyway.
        let implied_bps: u16 = (optimistic - target)
            .checked_mul(bps)
            .map(|scaled| scaled / optimistic)
            .and_then(|v| v.try_into().ok())
            .unwrap_or(configured_bps);
        configured_bps.min(implied_bps.saturating_sub(reprice_margin_bps))
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
            && !self
                .output_within_price_reference(tokens, &output_guard.max_output_reference_factor)
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
                        let is_revert = err.is_revert();
                        tracing::warn!(?err, is_revert, "strict output simulation errored");
                        // A REAL solve whose settlement simulation REVERTED is
                        // unexecutable (DEX under-delivers / router calldata
                        // reverts); never submit it — upstream filtered LIMIT
                        // gas-sim errors. Fail closed regardless of buffer
                        // exposure.
                        if !is_quote && is_revert {
                            return None;
                        }
                        // TRANSIENT (RPC/transport) errors and QUOTES keep the
                        // prior can-not-measure policy: price a quote or a
                        // non-buffer-exposed swap on heuristic gas rather than
                        // dropping it; fail closed only on a buffer-exposed real
                        // solve. (A quote that reverts on a flooring lane's
                        // optimistic output is still priced here — #774.)
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
                        let is_revert = err.is_revert();
                        tracing::warn!(?err, is_revert, "strict output simulation errored");
                        // A REAL solve whose settlement simulation REVERTED is
                        // unexecutable, so drop it regardless of buffer
                        // exposure. TRANSIENT errors and quotes keep the prior
                        // policy: accept unless a buffer-exposed real solve.
                        if !is_quote && (is_revert || self.buy_is_buffer_exposed(tokens)) {
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
            input: eth::Asset {
                amount: allowance_usdc,
                token: eth::TokenAddress(USDC),
            },
            output: eth::Asset {
                amount: output_weth,
                token: eth::TokenAddress(WETH),
            },
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
            sell: eth::Asset {
                amount: max_sell_usdc,
                token: eth::TokenAddress(USDC),
            },
            buy: eth::Asset {
                amount: buy_weth,
                token: eth::TokenAddress(WETH),
            },
            side: order::Side::Buy,
            class: order::Class::Market,
            partially_fillable: false,
            flashloan_hint: None,
            wrappers: vec![],
        }
    }

    // Buy 1 WETH for at most 3,000 USDC.
    fn one_weth() -> U256 {
        U256::from(1_000_000_000_000_000_000u128)
    }
    fn max_sell() -> U256 {
        U256::from(3_000_000_000u64)
    }

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
            sell: eth::Asset {
                amount: sell_amount,
                token: eth::TokenAddress(USDC),
            },
            buy: eth::Asset {
                amount: one_weth(),
                token: eth::TokenAddress(WETH),
            },
            side: order::Side::Sell,
            class: order::Class::Market,
            partially_fillable: false,
            flashloan_hint: None,
            wrappers: vec![],
        };
        // Output meets the limit exactly; allowance == input == sell_amount.
        let swap = Swap {
            calls: vec![],
            input: eth::Asset {
                amount: sell_amount,
                token: eth::TokenAddress(USDC),
            },
            output: eth::Asset {
                amount: one_weth(),
                token: eth::TokenAddress(WETH),
            },
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
        assert_eq!(
            unit.native_value(U256::from(1_234u64)),
            Some(U256::from(1_234u64))
        );
        let half = auction::Price(eth::Ether(U256::from(UNIT_PRICE / 2)));
        assert_eq!(
            half.native_value(U256::from(1_000u64)),
            Some(U256::from(500u64))
        );
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

#[cfg(test)]
mod bounded_slippage_tests {
    use {super::*, crate::domain::order, alloy::primitives::address};

    fn sell_order(buy_limit: u128) -> Order {
        Order {
            sell: eth::TokenAddress(address!("0x0b2c639c533813f4aa9d7837caf62653d097ff85")),
            buy: eth::TokenAddress(address!("0x4200000000000000000000000000000000000006")),
            side: order::Side::Sell,
            amount: Amount::new(U256::from(1_000u64)),
            buy_limit: U256::from(buy_limit),
            owner: address!("0x0000000000000000000000000000000000000001"),
            solve_fee: SolveFee::default(),
        }
    }

    /// Zero-fee, zero-margin — the pre-fee-aware call shape.
    fn bounded(order: &Order, optimistic: u64, configured: u16) -> u16 {
        order.bounded_solve_slippage_bps(
            U256::from(optimistic),
            configured,
            eth::Gas(U256::ZERO),
            0,
        )
    }

    #[test]
    fn loose_order_keeps_configured_slippage() {
        // buy_limit (900) below the configured floor (990): the fixed floor
        // already satisfies, so the configured slippage is unchanged.
        assert_eq!(bounded(&sell_order(900), 1_000, 100), 100);
    }

    #[test]
    fn tight_order_is_bounded_to_its_limit() {
        // buy_limit (995) above the configured floor (990) — the P1 case.
        // Tighten to 50 bps so the reported floor == 995 == buy_limit, so the
        // order the optimistic quote produced still settles.
        assert_eq!(bounded(&sell_order(995), 1_000, 100), 50);
    }

    #[test]
    fn limit_at_or_above_optimistic_sends_zero() {
        assert_eq!(bounded(&sell_order(1_000), 1_000, 100), 0);
        assert_eq!(bounded(&sell_order(1_100), 1_000, 100), 0);
    }

    /// A [`SolveFee`] whose `fee_in_sell` comes out to exactly `fee_atoms + 1`
    /// for a 1-gas swap with no offset: gas price = fee_atoms wei and a sell
    /// price of 1e18 (1 atom per wei).
    fn fee(fee_atoms: u64) -> SolveFee {
        SolveFee {
            gas_price: eth::Ether(U256::from(fee_atoms)),
            gas_offset: eth::Gas(U256::ZERO),
            sell_price: Some(auction::Price(eth::Ether(U256::from(
                1_000_000_000_000_000_000_u128,
            )))),
            // Zero totals = the conservative full-fill (capped) shape.
            total_sell: U256::ZERO,
            total_buy: U256::ZERO,
        }
    }

    #[test]
    fn partial_fill_with_room_gets_a_proportional_bar_not_fee_scaling() {
        // Partial fill: input 500 of a signed 1000-sell / 990-buy order, fee 5
        // (4 + safety atom). input + fee = 505 <= 1000, so the fee rides above
        // the fill (`sell = min(input + fee, total)`) and the bar is
        // proportional: ceil(990 × 505 / 1000) = 500 — NOT the fee-scaled
        // full-fill shape, and NOT "unsettleable" even though a same-size fee
        // on a tiny fill could exceed it.
        let mut order = sell_order(495); // fill-scaled limit (unused: totals set)
        order.amount = Amount::new(U256::from(500u64));
        order.solve_fee = SolveFee {
            total_sell: U256::from(1_000u64),
            total_buy: U256::from(990u64),
            ..fee(4)
        };
        // Optimistic 502 for the 500-input route → implied vs the 500 bar =
        // floor((502 − 500) × 1e4 / 502) = 39 bps.
        assert_eq!(
            order.bounded_solve_slippage_bps(
                U256::from(502u64),
                100,
                eth::Gas(U256::from(1u64)),
                0
            ),
            39
        );
        // And a fee at/above the PARTIAL input alone no longer zeroes the
        // bound (the old full-fill assumption did): fee 600 > input 500 but
        // input + fee = 1100 > total 1000 → capped regime, bar = full 990 buy
        // over factor total − fee = 400: target = floor(989 × 500 / 400) + 1
        // = 1237 ≥ optimistic → zero slippage only because the bar is truly
        // unreachable at this optimistic, not because of a false
        // "fee >= input" cutoff.
        let mut order = sell_order(495);
        order.amount = Amount::new(U256::from(500u64));
        order.solve_fee = SolveFee {
            total_sell: U256::from(1_000u64),
            total_buy: U256::from(990u64),
            ..fee(599)
        };
        assert_eq!(
            order.bounded_solve_slippage_bps(
                U256::from(502u64),
                100,
                eth::Gas(U256::from(1u64)),
                0
            ),
            0
        );
    }

    #[test]
    fn fee_in_sell_mirrors_solution_fee_plus_one() {
        // ether_value((gas + offset) × price) with price 1e18 (1:1) = gas × gas_price, +1.
        assert_eq!(
            fee(7).fee_in_sell(eth::Gas(U256::from(1u64))),
            U256::from(8u64)
        );
        // Missing sell price → zero (fail-open).
        let missing = SolveFee {
            sell_price: None,
            ..fee(7)
        };
        assert_eq!(missing.fee_in_sell(eth::Gas(U256::from(1u64))), U256::ZERO);
    }

    #[test]
    fn fee_inflates_the_bound_target() {
        // buy_limit 990 of optimistic 1000 → implied 100 bps bare. With a fee
        // estimate of 5 atoms (4 + the safety atom) on a sell of 1000, the
        // EXACT minimal output is floor(989 × 1000 / 995) + 1 = 994 (output
        // 994 credits ceil(995 × 994 / 1000) = 990 = the limit; 993 credits
        // only 989) → implied 60 bps: the floor now leaves exactly enough
        // room for the fee-scaled limit check, and no more.
        let mut order = sell_order(990);
        order.solve_fee = fee(4);
        assert_eq!(
            order.bounded_solve_slippage_bps(
                U256::from(1_000u64),
                100,
                eth::Gas(U256::from(1u64)),
                0
            ),
            60
        );
        // Sanity: the minimal target really is minimal — credited buy at
        // output 994 meets the limit, at 993 it does not.
        let credited =
            |out: u64| (U256::from(1_000u64 - 5) * U256::from(out)).div_ceil(U256::from(1_000u64));
        assert!(credited(994) >= U256::from(990u64));
        assert!(credited(993) < U256::from(990u64));
    }

    #[test]
    fn overflowing_target_fails_closed_with_zero_slippage() {
        // A near-max buy limit whose fee-inflated target exceeds U256: the
        // bound must fail CLOSED (zero slippage → router must beat the full
        // optimistic) rather than silently dropping the fee margin.
        let mut order = sell_order(0);
        order.buy_limit = U256::MAX - U256::from(1u8);
        order.solve_fee = fee(4);
        assert_eq!(
            order.bounded_solve_slippage_bps(U256::MAX, 100, eth::Gas(U256::from(1u64)), 0),
            0
        );
    }

    #[test]
    fn fee_covering_bound_satisfies_the_fee_scaled_limit_check() {
        // Regression for the 2026-07-17 Unichain unsettleable-orders bug, with
        // the live numbers: USDC (6 dp) → WETH, sell 3594671 atoms, the
        // auction's fee-adjusted buy limit, velora's optimistic route output,
        // gas price 1.5e6 wei, USDC reference price ~5.43e26, gas offset
        // 106391, velora padded API gas 193110 (+ the sim overhead margin).
        let sell_amount = U256::from(3_594_671_u64);
        let buy_limit = U256::from(1_948_989_691_966_047_u128);
        let optimistic = U256::from(1_957_061_929_356_070_u128);
        let solve_fee = SolveFee {
            gas_price: eth::Ether(U256::from(1_500_000_u64)),
            gas_offset: eth::Gas(U256::from(106_391_u64)),
            sell_price: Some(auction::Price(eth::Ether(U256::from(
                543_000_000_000_000_000_000_000_000_u128,
            )))),
            // Full fill: totals equal the fill (the capped regime, like prod).
            total_sell: sell_amount,
            total_buy: buy_limit,
        };
        let order = Order {
            amount: Amount::new(sell_amount),
            buy_limit,
            solve_fee,
            ..sell_order(0)
        };
        let gas_estimate = eth::Gas(U256::from(193_110_u64 + SIM_SETTLE_OVERHEAD_GAS));

        let bps = order.bounded_solve_slippage_bps(optimistic, 100, gas_estimate, 0);
        // The bound must have engaged (tighter than configured) but not
        // degenerated to zero.
        assert!(bps > 0 && bps < 100, "bps = {bps}");

        // The router floor at the bounded slippage…
        let floor = optimistic * U256::from(10_000 - bps as u64) / U256::from(10_000u64);
        // …must pass `into_dex_solution`'s fee-scaled limit check even when
        // the SIMULATED gas (307541, larger than the padded API estimate)
        // sets the actual fee: credited buy = ceil((sell − fee) × floor /
        // sell) >= buy_limit.
        let actual_fee = solve_fee
            .fee_in_sell(eth::Gas(U256::from(307_541_u64)))
            .checked_sub(U256::from(1u64)) // the estimate's safety atom is not in the real fee
            .unwrap();
        let credited = (sell_amount - actual_fee)
            .checked_mul(floor)
            .unwrap()
            .div_ceil(sell_amount);
        assert!(
            credited >= buy_limit,
            "credited {credited} < limit {buy_limit} (bps {bps}, floor {floor}, fee {actual_fee})"
        );
    }

    #[test]
    fn fee_swallowing_the_input_sends_zero() {
        let mut order = sell_order(990);
        order.solve_fee = fee(2_000); // fee > the 1000-atom sell
        assert_eq!(
            order.bounded_solve_slippage_bps(
                U256::from(1_000u64),
                100,
                eth::Gas(U256::from(1u64)),
                0
            ),
            0
        );
    }

    #[test]
    fn reprice_margin_is_subtracted_from_the_implied_bound_only() {
        // Same as tight_order_is_bounded_to_its_limit but with a 1 bp
        // re-pricing margin (the KyberSwap /routes → /route/build drift).
        let order = sell_order(995);
        assert_eq!(
            order.bounded_solve_slippage_bps(U256::from(1_000u64), 100, eth::Gas(U256::ZERO), 1),
            49
        );
        // A LOOSE order keeps the configured slippage untouched: its floor is
        // derived from the build-stage base itself, so no margin applies.
        let order = sell_order(900);
        assert_eq!(
            order.bounded_solve_slippage_bps(U256::from(1_000u64), 100, eth::Gas(U256::ZERO), 1),
            100
        );
        // The margin also floors at zero rather than underflowing.
        let order = sell_order(1_000);
        assert_eq!(
            order.bounded_solve_slippage_bps(U256::from(1_000u64), 100, eth::Gas(U256::ZERO), 1),
            0
        );
    }
}
