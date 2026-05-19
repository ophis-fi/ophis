//! Winner selection arbitrator.
//!
//! Implements the auction winner selection algorithm that picks the set of
//! solutions which maximize surplus while enforcing uniform directional
//! clearing prices.

use {
    crate::{
        auction::AuctionContext,
        primitives::{DirectedTokenPair, FeePolicy, Quote, Side, as_erc20, price_in_eth},
        solution::{Order, RankType, Ranked, Scored, Solution, Unscored},
        state::{RankedItem, ScoredItem, UnscoredItem},
    },
    alloy_primitives::{Address, U256},
    anyhow::{Context, Result},
    itertools::{Either, Itertools},
    number::u256_ext::U256Ext,
    std::{
        cmp::Reverse,
        collections::{HashMap, HashSet},
    },
    tracing::instrument,
};

/// Auction arbitrator responsible for selecting winning solutions.
pub struct Arbitrator {
    /// Maximum number of winning solutions to select.
    pub max_winners: usize,
    /// Wrapped native token address (WETH on mainnet, WXDAI on Gnosis).
    pub weth: Address,
}

impl Arbitrator {
    /// Runs the auction mechanism on solutions.
    ///
    /// Takes solutions and auction context, returns a ranking with winners.
    #[instrument(skip_all)]
    pub fn arbitrate(
        &self,
        solutions: Vec<Solution<Unscored>>,
        context: &AuctionContext,
    ) -> Ranking {
        let partitioned = self.partition_unfair_solutions(solutions, context);
        let filtered_out = partitioned
            .discarded
            .into_iter()
            .map(|s| s.with_rank(RankType::FilteredOut))
            .collect();
        let mut ranked = self.mark_winners(partitioned.kept);

        ranked.sort_by_key(|solution| (Reverse(solution.is_winner()), Reverse(solution.score())));

        Ranking {
            filtered_out,
            ranked,
        }
    }

    /// Removes unfair solutions from the set of all solutions.
    #[instrument(skip_all)]
    fn partition_unfair_solutions(
        &self,
        solutions: Vec<Solution<Unscored>>,
        context: &AuctionContext,
    ) -> PartitionedSolutions {
        // Discard all solutions where we can't compute the aggregate scores
        // accurately because the fairness guarantees heavily rely on them.
        let (mut solutions, scores_by_solution) =
            self.compute_scores_by_solution(solutions, context);

        // Sort by score descending
        solutions.sort_by_key(|solution| Reverse(solution.score()));

        let baseline_scores = compute_baseline_scores(&scores_by_solution);

        // Partition into fair and unfair solutions
        let (kept, discarded): (Vec<_>, Vec<_>) = solutions.into_iter().partition_map(|solution| {
            let aggregated_scores = scores_by_solution
                .get(&SolutionKey {
                    solver: solution.solver(),
                    solution_id: solution.id(),
                })
                .expect("every remaining solution has an entry");

            // only keep solutions where each order execution is at least as good as
            // the baseline solution.
            // we only filter out unfair solutions with more than one token pair,
            // to avoid reference scores set to 0.
            // see https://github.com/fhenneke/comb_auctions/issues/2
            if aggregated_scores.len() == 1
                || aggregated_scores.iter().all(|(pair, score)| {
                    baseline_scores
                        .get(pair)
                        .is_none_or(|baseline| score >= baseline)
                })
            {
                Either::Left(solution)
            } else {
                Either::Right(solution)
            }
        });

        PartitionedSolutions { kept, discarded }
    }

    /// Picks winners and sorts all solutions where winners come before
    /// non-winners and higher scores come before lower scores.
    fn mark_winners(&self, solutions: Vec<Solution<Scored>>) -> Vec<Solution<Ranked>> {
        let winner_indices = self.pick_winners(solutions.iter());

        solutions
            .into_iter()
            .enumerate()
            .map(|(index, solution)| {
                let rank_type = if winner_indices.contains(&index) {
                    RankType::Winner
                } else {
                    RankType::NonWinner
                };
                solution.with_rank(rank_type)
            })
            .collect()
    }

    /// Computes the `DirectionalScores` for all solutions and discards
    /// solutions as invalid whenever that computation is not possible.
    /// Solutions get discarded because fairness guarantees heavily
    /// depend on these scores being accurate.
    fn compute_scores_by_solution(
        &self,
        solutions: Vec<Solution<Unscored>>,
        context: &AuctionContext,
    ) -> (Vec<Solution<Scored>>, ScoresBySolution) {
        let mut scores_by_solution = HashMap::default();
        let mut scored_solutions = Vec::new();

        for solution in solutions {
            match self.score_by_token_pair(&solution, context) {
                Ok(score) => {
                    let total_score = score
                        .values()
                        .fold(U256::ZERO, |acc, s| acc.saturating_add(*s));
                    scores_by_solution.insert(
                        SolutionKey {
                            solver: solution.solver(),
                            solution_id: solution.id(),
                        },
                        score,
                    );
                    scored_solutions.push(solution.with_score(total_score));
                }
                Err(err) => {
                    tracing::warn!(
                        solution_id = solution.id(),
                        ?err,
                        "discarding solution where scores could not be computed"
                    );
                }
            }
        }

        (scored_solutions, scores_by_solution)
    }

    /// Returns the total scores for each directed token pair of the solution.
    /// E.g. if a solution contains 3 orders like:
    ///     sell A for B with a score of 10
    ///     sell A for B with a score of 5
    ///     sell B for C with a score of 5
    /// it will return a map like:
    ///     (A, B) => 15
    ///     (B, C) => 5
    fn score_by_token_pair<T>(
        &self,
        solution: &Solution<T>,
        context: &AuctionContext,
    ) -> Result<HashMap<DirectedTokenPair, U256>> {
        let mut scores: HashMap<DirectedTokenPair, U256> = HashMap::default();

        for order in solution.orders() {
            if !context.contributes_to_score(&order.uid) {
                continue;
            }

            let score = self.compute_order_score(order, context)?;

            let token_pair = DirectedTokenPair {
                sell: order.sell_token,
                buy: order.buy_token,
            };

            let entry = scores.entry(token_pair).or_default();
            *entry = entry.saturating_add(score);
        }

        Ok(scores)
    }

    /// Score defined as (surplus + protocol fees) first converted to buy
    /// amounts and then converted to the native token.
    ///
    /// Follows CIP-38 as the base of the score computation.
    ///
    /// Denominated in NATIVE token.
    fn compute_order_score(&self, order: &Order, context: &AuctionContext) -> Result<U256> {
        let native_price_buy = context
            .native_prices
            .get(&order.buy_token)
            .context("missing native price for buy token")?;

        let custom_prices = self.calculate_custom_prices_from_executed(order);

        // Calculate surplus in surplus token (buy token for sell orders, sell token for
        // buy orders)
        let surplus_in_surplus_token = {
            let user_surplus = self.surplus_over_limit_price(order, &custom_prices)?;
            let fees = self.protocol_fees(order, context, &custom_prices)?;

            user_surplus
                .checked_add(fees)
                .context("overflow adding fees to surplus")?
        };

        let score_eth = match order.side {
            // `surplus` of sell orders is already in buy tokens so we simply convert it to ETH
            Side::Sell => price_in_eth(*native_price_buy, surplus_in_surplus_token),
            Side::Buy => {
                // `surplus` of buy orders is in sell tokens. We start with following formula:
                // buy_amount / sell_amount == buy_price / sell_price
                //
                // since `surplus` of buy orders is in sell tokens we convert to buy amount via:
                // buy_amount == (buy_price / sell_price) * surplus
                //
                // to avoid loss of precision because we work with integers we first multiply
                // and then divide:
                // buy_amount = surplus * buy_price / sell_price
                use alloy_primitives::{U512, ruint::UintTryFrom};

                let surplus_in_buy_tokens = surplus_in_surplus_token
                    .widening_mul(order.buy_amount)
                    .checked_div(U512::from(order.sell_amount))
                    .context("division by zero converting surplus to buy tokens")?;
                let surplus_in_buy_tokens: U256 = U256::uint_try_from(surplus_in_buy_tokens)
                    .map_err(|_| anyhow::anyhow!("overflow converting surplus to buy tokens"))?;

                // Afterwards we convert the buy token surplus to the native token.
                price_in_eth(*native_price_buy, surplus_in_buy_tokens)
            }
        };

        Ok(score_eth)
    }

    /// Calculate total protocol fees for an order.
    ///
    /// Returns the total fee in the surplus token.
    fn protocol_fees(
        &self,
        order: &Order,
        context: &AuctionContext,
        base_prices: &ClearingPrices,
    ) -> Result<U256> {
        let policies = context
            .fee_policies
            .get(&order.uid)
            .map(|v| v.as_slice())
            .unwrap_or_default();

        let mut total_fee = U256::ZERO;
        let mut current_prices = *base_prices;

        // Process policies in reverse order, updating custom prices as we go
        for (i, policy) in policies.iter().enumerate().rev() {
            let fee = self.protocol_fee(order, policy, &current_prices)?;

            total_fee = total_fee
                .checked_add(fee)
                .context("overflow adding protocol fees")?;

            // Update custom prices for next iteration (except last iteration)
            if i != 0 {
                current_prices = self.calculate_custom_prices(order, total_fee, base_prices)?;
            }
        }

        Ok(total_fee)
    }

    /// Calculate a single protocol fee based on policy type.
    fn protocol_fee(
        &self,
        order: &Order,
        policy: &FeePolicy,
        custom_prices: &ClearingPrices,
    ) -> MathResult<U256> {
        match policy {
            FeePolicy::Surplus {
                factor,
                max_volume_factor,
            } => {
                let surplus = self.surplus_over_limit_price(order, custom_prices)?;
                let surplus_fee = self.surplus_fee(surplus, *factor)?;
                let volume_fee = self.volume_fee(order, custom_prices, *max_volume_factor)?;
                Ok(surplus_fee.min(volume_fee))
            }
            FeePolicy::PriceImprovement {
                factor,
                max_volume_factor,
                quote,
            } => {
                let price_improvement =
                    self.price_improvement_over_quote(order, custom_prices, quote)?;
                let surplus_fee = self.surplus_fee(price_improvement, *factor)?;
                let volume_fee = self.volume_fee(order, custom_prices, *max_volume_factor)?;
                Ok(surplus_fee.min(volume_fee))
            }
            FeePolicy::Volume { factor } => self.volume_fee(order, custom_prices, *factor),
        }
    }

    /// Calculate surplus over limit price using custom clearing prices.
    fn surplus_over_limit_price(&self, order: &Order, prices: &ClearingPrices) -> MathResult<U256> {
        self.surplus_over(
            order,
            prices,
            PriceLimits {
                sell: order.sell_amount,
                buy: order.buy_amount,
            },
        )
    }

    /// Calculate surplus over arbitrary price limits.
    fn surplus_over(
        &self,
        order: &Order,
        prices: &ClearingPrices,
        limits: PriceLimits,
    ) -> MathResult<U256> {
        let executed = match order.side {
            Side::Buy => order.executed_buy,
            Side::Sell => order.executed_sell,
        };

        match order.side {
            Side::Buy => {
                // Scale limit sell to support partially fillable orders
                let limit_sell = limits
                    .sell
                    .checked_mul(executed)
                    .ok_or(MathError::Overflow)?
                    .checked_div(limits.buy)
                    .ok_or(MathError::DivisionByZero)?;

                let sold = executed
                    .checked_mul(prices.buy)
                    .ok_or(MathError::Overflow)?
                    .checked_div(prices.sell)
                    .ok_or(MathError::DivisionByZero)?;

                limit_sell.checked_sub(sold).ok_or(MathError::Negative)
            }
            Side::Sell => {
                // Scale limit buy to support partially fillable orders (ceiling division)
                let limit_buy = executed
                    .checked_mul(limits.buy)
                    .ok_or(MathError::Overflow)?
                    .checked_ceil_div(&limits.sell)
                    .ok_or(MathError::DivisionByZero)?;

                let bought = executed
                    .checked_mul(prices.sell)
                    .ok_or(MathError::Overflow)?
                    .checked_ceil_div(&prices.buy)
                    .ok_or(MathError::DivisionByZero)?;

                bought.checked_sub(limit_buy).ok_or(MathError::Negative)
            }
        }
    }

    /// Calculate price improvement over quote.
    ///
    /// Returns 0 if there's no improvement (instead of error).
    fn price_improvement_over_quote(
        &self,
        order: &Order,
        prices: &ClearingPrices,
        quote: &Quote,
    ) -> MathResult<U256> {
        let adjusted_quote = self.adjust_quote_to_order_limits(order, quote)?;
        match self.surplus_over(order, prices, adjusted_quote) {
            Ok(surplus) => Ok(surplus),
            Err(MathError::Negative) => Ok(U256::ZERO),
            Err(err) => Err(err),
        }
    }

    /// Adjust quote amounts to be comparable with order limits.
    fn adjust_quote_to_order_limits(
        &self,
        order: &Order,
        quote: &Quote,
    ) -> MathResult<PriceLimits> {
        match order.side {
            Side::Sell => {
                // Quote buy amount after fees
                let quote_buy_amount = quote
                    .buy_amount
                    .checked_sub(
                        quote
                            .fee
                            .checked_mul(quote.buy_amount)
                            .ok_or(MathError::Overflow)?
                            .checked_div(quote.sell_amount)
                            .ok_or(MathError::DivisionByZero)?,
                    )
                    .ok_or(MathError::Negative)?;

                // Scale to order's sell amount
                let scaled_buy_amount = quote_buy_amount
                    .checked_mul(order.sell_amount)
                    .ok_or(MathError::Overflow)?
                    .checked_div(quote.sell_amount)
                    .ok_or(MathError::DivisionByZero)?;

                // Use max to handle out-of-market orders
                let buy_amount = order.buy_amount.max(scaled_buy_amount);

                Ok(PriceLimits {
                    sell: order.sell_amount,
                    buy: buy_amount,
                })
            }
            Side::Buy => {
                // Quote sell amount including fees
                let quote_sell_amount = quote
                    .sell_amount
                    .checked_add(quote.fee)
                    .ok_or(MathError::Overflow)?;

                // Scale to order's buy amount
                let scaled_sell_amount = quote_sell_amount
                    .checked_mul(order.buy_amount)
                    .ok_or(MathError::Overflow)?
                    .checked_div(quote.buy_amount)
                    .ok_or(MathError::DivisionByZero)?;

                // Use min to handle out-of-market orders
                let sell_amount = order.sell_amount.min(scaled_sell_amount);

                Ok(PriceLimits {
                    sell: sell_amount,
                    buy: order.buy_amount,
                })
            }
        }
    }

    /// Calculate surplus fee as a cut of surplus.
    ///
    /// Uses adjusted factor: fee = surplus * factor / (1 - factor)
    fn surplus_fee(&self, surplus: U256, factor: f64) -> MathResult<U256> {
        // Surplus fee is specified as a `factor` from raw surplus (before fee).
        // Since we work with trades that already have the protocol fee applied,
        // we need to calculate the protocol fee using an adjusted factor.
        //
        // fee = surplus_before_fee * factor
        // surplus_after_fee = surplus_before_fee - fee
        // fee = surplus_after_fee * factor / (1 - factor)
        surplus
            .checked_mul_f64(factor / (1.0 - factor))
            .ok_or(MathError::Overflow)
    }

    /// Calculate volume fee as a cut of trade volume.
    fn volume_fee(&self, order: &Order, prices: &ClearingPrices, factor: f64) -> MathResult<U256> {
        // Volume fee is specified as a factor from raw volume (before fee).
        // We need to calculate using an adjusted factor based on order side.
        //
        // Sell: fee = traded_buy_amount * factor / (1 - factor)
        // Buy:  fee = traded_sell_amount * factor / (1 + factor)

        let executed_in_surplus_token = match order.side {
            Side::Sell => self.buy_amount(order, prices)?,
            Side::Buy => self.sell_amount(order, prices)?,
        };

        let adjusted_factor = match order.side {
            Side::Sell => factor / (1.0 - factor),
            Side::Buy => factor / (1.0 + factor),
        };

        executed_in_surplus_token
            .checked_mul_f64(adjusted_factor)
            .ok_or(MathError::Overflow)
    }

    /// Calculate custom clearing prices from executed amounts.
    ///
    /// Custom prices are derived from what was actually executed.
    fn calculate_custom_prices_from_executed(&self, order: &Order) -> ClearingPrices {
        ClearingPrices {
            sell: order.executed_buy,
            buy: order.executed_sell,
        }
    }

    /// Calculate custom clearing prices excluding protocol fees.
    ///
    /// This adjusts prices to reflect the trade without the accumulated fees.
    fn calculate_custom_prices(
        &self,
        order: &Order,
        protocol_fee: U256,
        prices: &ClearingPrices,
    ) -> MathResult<ClearingPrices> {
        let sell_amount = self.sell_amount(order, prices)?;
        let buy_amount = self.buy_amount(order, prices)?;

        Ok(ClearingPrices {
            sell: match order.side {
                Side::Sell => buy_amount
                    .checked_add(protocol_fee)
                    .ok_or(MathError::Overflow)?,
                Side::Buy => buy_amount,
            },
            buy: match order.side {
                Side::Sell => sell_amount,
                Side::Buy => sell_amount
                    .checked_sub(protocol_fee)
                    .ok_or(MathError::Negative)?,
            },
        })
    }

    /// Calculate effective sell amount (what left user's wallet).
    fn sell_amount(&self, order: &Order, prices: &ClearingPrices) -> MathResult<U256> {
        match order.side {
            Side::Sell => Ok(order.executed_sell),
            Side::Buy => order
                .executed_buy
                .checked_mul(prices.buy)
                .ok_or(MathError::Overflow)?
                .checked_div(prices.sell)
                .ok_or(MathError::DivisionByZero),
        }
    }

    /// Calculate effective buy amount (what user received).
    fn buy_amount(&self, order: &Order, prices: &ClearingPrices) -> MathResult<U256> {
        match order.side {
            Side::Sell => order
                .executed_sell
                .checked_mul(prices.sell)
                .ok_or(MathError::Overflow)?
                .checked_ceil_div(&prices.buy)
                .ok_or(MathError::DivisionByZero),
            Side::Buy => Ok(order.executed_buy),
        }
    }

    /// Returns indices of winning solutions.
    /// Assumes that `solutions` is sorted by score descendingly.
    /// This logic was moved into a helper function to avoid a ton of `.clone()`
    /// operations in `compute_reference_scores()`.
    fn pick_winners<'a, T: 'a>(
        &self,
        solutions: impl Iterator<Item = &'a Solution<T>>,
    ) -> HashSet<usize> {
        // Winners are selected one by one, starting from the best solution,
        // until `max_winners` are selected. A solution can only
        // win if none of the (sell_token, buy_token) pairs of the executed
        // orders have been covered by any previously selected winning solution.
        // In other words this enforces a uniform **directional** clearing price.
        let mut already_swapped_token_pairs = HashSet::new();
        let mut winners = HashSet::default();

        for (index, solution) in solutions.enumerate() {
            if winners.len() >= self.max_winners {
                return winners;
            }

            let swapped_token_pairs: HashSet<DirectedTokenPair> = solution
                .orders()
                .iter()
                .map(|order| DirectedTokenPair {
                    sell: as_erc20(order.sell_token, self.weth),
                    buy: as_erc20(order.buy_token, self.weth),
                })
                .collect();

            if swapped_token_pairs.is_disjoint(&already_swapped_token_pairs) {
                winners.insert(index);
                already_swapped_token_pairs.extend(swapped_token_pairs);
            }
        }

        winners
    }

    /// Compute reference scores for winning solvers.
    #[instrument(skip_all)]
    pub fn compute_reference_scores(&self, ranking: &Ranking) -> HashMap<Address, U256> {
        let mut reference_scores = HashMap::default();

        for ranked_solution in &ranking.ranked {
            let solver = ranked_solution.solver();

            if reference_scores.len() >= self.max_winners {
                return reference_scores;
            }
            if reference_scores.contains_key(&solver) {
                continue;
            }
            if !ranked_solution.is_winner() {
                continue;
            }

            // Compute score without this solver
            let solutions_without_solver: Vec<_> = ranking
                .ranked
                .iter()
                .filter(|s| s.solver() != solver)
                .collect();

            let winner_indices = self.pick_winners(solutions_without_solver.iter().copied());

            let score = solutions_without_solver
                .iter()
                .enumerate()
                .filter(|(index, _)| winner_indices.contains(index))
                .map(|(_, solution)| solution.score())
                .reduce(|acc, score| acc.saturating_add(score))
                .unwrap_or_default();

            reference_scores.insert(solver, score);
        }

        reference_scores
    }
}

/// Let's call a solution that only trades 1 directed token pair a baseline
/// solution. Returns the *second-best* baseline solution per token pair
/// across at least two distinct solver addresses.
///
/// **Anti-poisoning rationale (Phase 2 audit M6):**
///
/// The naive implementation took the max single-pair score per pair across
/// all solvers. A single attacker solver could submit a pathologically
/// inflated single-pair score for token pair X, and every honest
/// multi-pair solution covering X would be filtered out as "unfair"
/// because none of them could match the attacker's inflated baseline.
/// The attacker doesn't need to win the auction — they only need the
/// baseline to be high enough to exclude legitimate competitors.
///
/// The hardened version applies two defenses:
///
///   1. **Distinct-solver gate:** a pair with single-pair contributions
///      from < 2 distinct solver addresses produces NO baseline (caller's
///      `is_none_or` treats that as "no fairness constraint" for the
///      pair). A lone solver cannot poison a baseline they're the only
///      contributor to.
///
///   2. **Second-best score:** with ≥ 2 distinct solvers, the baseline
///      is the *second-highest* score across distinct solvers (not the
///      max). This bounds an attacker's influence even when they control
///      multiple solver addresses — they must inflate scores from ≥ 2
///      addresses simultaneously to move the baseline, doubling the
///      stake/submission cost of the grief.
///
/// The relaxation (second-best vs max) is intentional: trading off some
/// fairness strictness for griefing resistance is the explicit recommend-
/// ation in the audit. Honest baseline solutions tend to cluster within
/// a narrow band per pair (same token, same liquidity); the second-best
/// is usually close to the max in practice.
fn compute_baseline_scores(scores_by_solution: &ScoresBySolution) -> ScoreByDirection {
    // Group (solver, score) tuples by pair, keeping the BEST score each
    // solver produced for that pair (a single solver may submit multiple
    // single-pair solutions covering the same pair; we treat them as one
    // contribution).
    let mut best_per_pair_solver: HashMap<DirectedTokenPair, HashMap<Address, U256>> =
        HashMap::default();
    for (key, scores) in scores_by_solution {
        let Ok((token_pair, score)) = scores.iter().exactly_one() else {
            continue;
        };
        let solvers = best_per_pair_solver
            .entry(token_pair.clone())
            .or_default();
        let entry = solvers.entry(key.solver).or_default();
        if score > entry {
            *entry = *score;
        }
    }

    let mut baseline_scores = HashMap::default();
    for (pair, solvers) in best_per_pair_solver {
        if solvers.len() < 2 {
            // Single-solver baseline is poisonable — no fairness constraint.
            continue;
        }
        // Second-best across distinct solvers.
        let mut sorted: Vec<U256> = solvers.into_values().collect();
        sorted.sort_by(|a, b| b.cmp(a));
        baseline_scores.insert(pair, sorted[1]);
    }

    baseline_scores
}

/// Result of partitioning solutions into fair and unfair.
struct PartitionedSolutions {
    /// Solutions that passed fairness checks (with scores).
    kept: Vec<Solution<Scored>>,
    /// Solutions that were filtered out as unfair (with scores).
    discarded: Vec<Solution<Scored>>,
}

/// Final ranking of all solutions.
#[derive(Debug)]
pub struct Ranking {
    /// Solutions that were filtered out as unfair (with scores and FilteredOut
    /// rank).
    pub filtered_out: Vec<Solution<Ranked>>,
    /// Solutions that passed fairness checks, ordered by score (with
    /// Winner/NonWinner ranks).
    pub ranked: Vec<Solution<Ranked>>,
}

impl Ranking {
    /// All winning solutions.
    pub fn winners(&self) -> impl Iterator<Item = &Solution<Ranked>> {
        self.ranked.iter().filter(|s| s.is_winner())
    }

    /// All non-winning solutions that weren't filtered out.
    pub fn non_winners(&self) -> impl Iterator<Item = &Solution<Ranked>> {
        self.ranked.iter().filter(|s| !s.is_winner())
    }
}

/// Clearing prices for a trade.
///
/// These can be either uniform (same for all orders) or custom (adjusted for
/// protocol fees on a per-order basis).
#[derive(Debug, Clone, Copy)]
struct ClearingPrices {
    /// Price of sell token in terms of buy token.
    sell: U256,
    /// Price of buy token in terms of sell token.
    buy: U256,
}

/// Price limits for an order or quote.
#[derive(Debug, Clone, Copy)]
struct PriceLimits {
    /// Maximum sell amount.
    sell: U256,
    /// Minimum buy amount.
    buy: U256,
}

/// Key to uniquely identify every solution.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct SolutionKey {
    solver: Address,
    solution_id: u64,
}

/// Scores of all trades in a solution aggregated by the directional
/// token pair. E.g. all trades (WETH -> USDC) are aggregated into
/// one value and all trades (USDC -> WETH) into another.
type ScoreByDirection = HashMap<DirectedTokenPair, U256>;

/// Mapping from solution to `DirectionalScores` for all solutions
/// of the auction.
type ScoresBySolution = HashMap<SolutionKey, ScoreByDirection>;

type MathResult<T> = std::result::Result<T, MathError>;

#[derive(Debug, thiserror::Error)]
enum MathError {
    #[error("overflow")]
    Overflow,
    #[error("division by zero")]
    DivisionByZero,
    #[error("negative")]
    Negative,
}

#[cfg(test)]
mod baseline_poisoning_tests {
    use super::*;

    fn pair(a: u8, b: u8) -> DirectedTokenPair {
        DirectedTokenPair {
            sell: Address::repeat_byte(a),
            buy: Address::repeat_byte(b),
        }
    }

    fn solver(byte: u8) -> Address {
        Address::repeat_byte(byte)
    }

    fn make(scores: Vec<(Address, u64, Vec<(DirectedTokenPair, U256)>)>) -> ScoresBySolution {
        scores
            .into_iter()
            .map(|(solver, id, pair_scores)| {
                (
                    SolutionKey {
                        solver,
                        solution_id: id,
                    },
                    pair_scores.into_iter().collect(),
                )
            })
            .collect()
    }

    #[test]
    fn single_solver_single_pair_produces_no_baseline() {
        // Attacker submits exactly one inflated single-pair solution.
        // Pre-PR this set baseline to u64::MAX, filtering out every
        // honest multi-pair solution covering this pair.
        let attacker = solver(0x42);
        let pair_x = pair(1, 2);
        let scores = make(vec![(
            attacker,
            1,
            vec![(pair_x.clone(), U256::from(u64::MAX))],
        )]);
        let baseline = compute_baseline_scores(&scores);
        assert!(baseline.is_empty());
    }

    #[test]
    fn single_solver_multiple_solutions_same_pair_still_no_baseline() {
        // Attacker controls one address, submits N inflated single-pair
        // solutions. Still counts as 1 distinct solver — no baseline.
        let attacker = solver(0x42);
        let pair_x = pair(1, 2);
        let scores = make(vec![
            (attacker, 1, vec![(pair_x.clone(), U256::from(1_000u64))]),
            (attacker, 2, vec![(pair_x.clone(), U256::from(u64::MAX))]),
            (attacker, 3, vec![(pair_x.clone(), U256::from(500u64))]),
        ]);
        let baseline = compute_baseline_scores(&scores);
        assert!(baseline.is_empty());
    }

    #[test]
    fn two_solvers_takes_second_best_not_max() {
        // Even with the distinct-solver gate passed, baseline = SECOND-best
        // score. This bounds attacker influence even when they control
        // 2 addresses.
        let attacker = solver(0x42);
        let honest = solver(0x01);
        let pair_x = pair(1, 2);
        let scores = make(vec![
            (attacker, 1, vec![(pair_x.clone(), U256::from(u64::MAX))]),
            (honest, 2, vec![(pair_x.clone(), U256::from(1_000u64))]),
        ]);
        let baseline = compute_baseline_scores(&scores);
        assert_eq!(baseline.get(&pair_x), Some(&U256::from(1_000u64)));
    }

    #[test]
    fn three_solvers_takes_second_best() {
        let s1 = solver(0x01);
        let s2 = solver(0x02);
        let s3 = solver(0x03);
        let pair_x = pair(1, 2);
        let scores = make(vec![
            (s1, 1, vec![(pair_x.clone(), U256::from(100u64))]),
            (s2, 1, vec![(pair_x.clone(), U256::from(300u64))]),
            (s3, 1, vec![(pair_x.clone(), U256::from(200u64))]),
        ]);
        let baseline = compute_baseline_scores(&scores);
        assert_eq!(baseline.get(&pair_x), Some(&U256::from(200u64)));
    }

    #[test]
    fn multi_pair_solutions_dont_count_as_baseline_contributors() {
        // A solution touching > 1 pair is not a "baseline" candidate at
        // all — pre-PR behavior preserved.
        let s1 = solver(0x01);
        let s2 = solver(0x02);
        let pair_x = pair(1, 2);
        let pair_y = pair(3, 4);
        let scores = make(vec![
            (s1, 1, vec![(pair_x.clone(), U256::from(100u64))]),
            (
                s2,
                1,
                vec![
                    (pair_x.clone(), U256::from(200u64)),
                    (pair_y.clone(), U256::from(50u64)),
                ],
            ),
        ]);
        let baseline = compute_baseline_scores(&scores);
        // Only s1 contributed a single-pair solution covering pair_x.
        // s2's solution touches two pairs, so it's NOT a baseline
        // contributor. Without a second distinct single-pair contributor,
        // no baseline.
        assert!(baseline.is_empty());
    }

    #[test]
    fn per_solver_best_is_used_for_ranking() {
        // If a solver submits multiple single-pair solutions for the
        // same pair, only their BEST counts for the second-best
        // computation.
        let s1 = solver(0x01);
        let s2 = solver(0x02);
        let pair_x = pair(1, 2);
        let scores = make(vec![
            (s1, 1, vec![(pair_x.clone(), U256::from(100u64))]),
            (s1, 2, vec![(pair_x.clone(), U256::from(150u64))]),
            (s2, 1, vec![(pair_x.clone(), U256::from(200u64))]),
        ]);
        let baseline = compute_baseline_scores(&scores);
        // s1 best = 150, s2 best = 200. Second-best = 150.
        assert_eq!(baseline.get(&pair_x), Some(&U256::from(150u64)));
    }
}
