//! A simple solver that matches orders directly with swaps from the external
//! DEX and DEX aggregator APIs.

use {
    crate::{
        domain::{
            auction,
            dex::{self, minimum_surplus::MinimumSurplusLimits, slippage::SlippageLimits},
            eth,
            order::{self, Order},
            solution,
            solver::dex::fills::Fills,
        },
        infra,
    },
    futures::{FutureExt, StreamExt, future, stream},
    std::num::NonZeroUsize,
    tracing::Instrument,
};

mod fills;

pub struct Dex {
    /// The DEX API client.
    dex: infra::dex::Dex,

    /// A DEX swap gas simulator for computing limit order fees.
    simulator: infra::dex::Simulator,

    /// The slippage configuration to use for the solver.
    slippage: SlippageLimits,

    /// The minimum surplus configuration to use for the solver.
    minimum_surplus: MinimumSurplusLimits,

    /// The number of concurrent requests to make.
    concurrent_requests: NonZeroUsize,

    /// Helps to manage the strategy to fill orders (especially partially
    /// fillable orders).
    fills: Fills,

    /// Handles 429 Too Many Requests error with a retry mechanism
    rate_limiter: rate_limit::RateLimiter,

    /// Amount of gas that gets added to each swap to tweak the cost coverage of
    /// the solver.
    gas_offset: eth::Gas,

    /// Whether to internalize the solution interactions using the Settlement
    /// contract buffer.
    internalize_interactions: bool,

    /// OUTPUT-side anti-siphon guards applied to every aggregator swap at the
    /// `dex::Swap::into_solution` choke point.
    output_guard: dex::OutputGuard,
}

/// The amount of time we aim the solver to finish before the final deadline is
/// reached.
const DEADLINE_SLACK: chrono::Duration = chrono::Duration::milliseconds(500);

impl Dex {
    pub fn new(dex: infra::dex::Dex, config: infra::config::dex::Config) -> Self {
        let rate_limiter = rate_limit::RateLimiter::from_strategy(
            config.rate_limiting_strategy,
            "dex_api".to_string(),
        );
        Self {
            dex,
            simulator: infra::dex::Simulator::new(
                &config.node_url,
                config.contracts.settlement,
                config.contracts.authenticator,
            ),
            slippage: config.slippage,
            minimum_surplus: config.minimum_surplus,
            concurrent_requests: config.concurrent_requests,
            fills: Fills::new(config.smallest_partial_fill),
            rate_limiter,
            gas_offset: config.gas_offset,
            internalize_interactions: config.internalize_interactions,
            output_guard: config.output_guard,
        }
    }

    pub async fn solve(&self, auction: auction::Auction) -> Vec<solution::Solution> {
        let mut solutions = Vec::new();
        let solve_orders = async {
            let mut stream = self.solution_stream(&auction);
            while let Some(solution) = stream.next().await {
                solutions.push(solution);
            }
        };

        let deadline = auction
            .deadline
            .clone()
            .reduce(DEADLINE_SLACK)
            .remaining()
            .unwrap_or_default();
        if tokio::time::timeout(deadline, solve_orders).await.is_err() {
            tracing::debug!("reached deadline; stopping to solve");
        }

        self.fills.collect_garbage();

        solutions
    }

    fn solution_stream<'a>(
        &'a self,
        auction: &'a auction::Auction,
    ) -> impl stream::Stream<Item = solution::Solution> + 'a {
        // A price-estimation quote (`auction.id == Id::Quote`, i.e. the DTO `id`
        // field was absent) is handled two ways downstream: (a) the flooring DEX
        // lanes report the OPTIMISTIC swap output (0x/ParaSwap parity, not the
        // settle-only slippage floor), and (b) the strict output-delivery
        // simulation must NOT reject it — a quote's owner is unfunded so the sim
        // cannot run and would fail closed. Computed once; an auction is wholly
        // quote or wholly solve. NEVER true for a competition auction (those
        // carry a numeric id => Id::Solve), so the settle path is untouched.
        let is_quote = matches!(auction.id, auction::Id::Quote);
        stream::iter(auction.orders.iter())
            .enumerate()
            // `move` copies the `Copy` captures (`&self`, `&auction`, the
            // `is_quote` bool) into the closure so the produced `'a` futures own
            // `is_quote` rather than borrowing this frame's local.
            .map(move |(i, order)| {
                let span = tracing::info_span!("solve", order = %order.uid);
                self.solve_order(order, &auction.tokens, auction.gas_price, is_quote)
                    .map(move |solution| solution.map(|s| s.with_id(solution::Id(i as u64))))
                    .instrument(span)
            })
            .buffer_unordered(self.concurrent_requests.get())
            .filter_map(future::ready)
    }

    async fn try_solve(
        &self,
        order: &Order,
        dex_order: &dex::Order,
        tokens: &auction::Tokens,
        is_quote: bool,
    ) -> Option<dex::Swap> {
        let dex_err_handler = |err: infra::dex::Error| {
            infra::metrics::solve_error(err.format_variant());
            match &err {
                err @ infra::dex::Error::NotFound => {
                    if order.partially_fillable {
                        // Only adjust the amount to try next if we are sure the API
                        // worked correctly yet still wasn't able to provide a swap.
                        self.fills.reduce_next_try(order.uid);
                    } else {
                        tracing::debug!(?err, "skipping order");
                    }
                }
                err @ infra::dex::Error::OrderNotSupported => {
                    tracing::debug!(?err, "skipping order")
                }
                err @ infra::dex::Error::BadRequest => {
                    tracing::warn!(?err, "bad request")
                }
                err @ infra::dex::Error::RateLimited => {
                    tracing::debug!(?err, "encountered rate limit")
                }
                err @ infra::dex::Error::UnavailableForLegalReasons => {
                    tracing::debug!(?err, "unavailable for legal reasons")
                }
                infra::dex::Error::Other(err) => {
                    tracing::warn!(?err, "failed to get swap")
                }
            }
            err
        };
        let swap = async {
            let slippage = self.slippage.relative(&dex_order.amount(), tokens);
            self.dex
                .swap(dex_order, &slippage, tokens, is_quote)
                .await
                .inspect(|_| infra::metrics::request_sent())
                .map_err(dex_err_handler)
        };
        self.rate_limiter
            .execute_with_back_off(swap, |result| {
                matches!(result, Err(infra::dex::Error::RateLimited))
            })
            .await
            .map_err(|err| match err {
                rate_limit::Error::RateLimited => infra::dex::Error::RateLimited,
            })
            .and_then(|result| result)
            .ok()
            .filter(|swap| {
                if !swap.satisfies(order) {
                    tracing::debug!("swap does not satisfy order");
                    if order.partially_fillable {
                        self.fills.reduce_next_try(order.uid);
                    }
                    return false;
                }

                // Buffer-exposure bound. A swap must never approve the DEX
                // spender for more than this fill's signed sell cap (at the
                // order's limit price). For exactIn solvers the allowance
                // equals the fixed input so this is implied by `satisfies`,
                // but exactOut solvers pad the allowance above the input
                // estimate (the router pulls *up to* `maxSrc`) — `satisfies`
                // only bounds `input.amount`, not the padded allowance.
                // Without this, a compromised aggregator API quoting a BUY at
                // the (proportional) max-sell could get the spender approved
                // for more and pull the difference from Settlement's transient
                // buffer. The check mirrors `satisfies` with the allowance, so
                // it enforces the proportional cap for partial fills too.
                if !swap.allowance_within_sell_limit(order) {
                    tracing::debug!("swap allowance exceeds order limit price");
                    if order.partially_fillable {
                        self.fills.reduce_next_try(order.uid);
                    }
                    return false;
                }

                // Check minimum surplus requirement
                let minimum_surplus = self.minimum_surplus.relative(&dex_order.amount(), tokens);
                let valid_surplus = swap.satisfies_with_minimum_surplus(order, &minimum_surplus);
                if !valid_surplus {
                    tracing::debug!("swap does not meet minimum surplus requirement");
                    if order.partially_fillable {
                        self.fills.reduce_next_try(order.uid);
                    }
                }
                valid_surplus
            })
    }

    async fn solve_order(
        &self,
        order: &order::Order,
        tokens: &auction::Tokens,
        gas_price: auction::GasPrice,
        is_quote: bool,
    ) -> Option<solution::Solution> {
        let mut dex_order = self.fills.dex_order(order, tokens)?;
        // Fee context for solve-path slippage bounding: the lanes estimate the
        // surplus fee `into_dex_solution` will charge (below, from the same
        // gas price / offset / sell price) so the bounded router floor covers
        // the fee-scaled limit check and a tight order remains settleable.
        dex_order.solve_fee = dex::SolveFee {
            gas_price: gas_price.0,
            gas_offset: self.gas_offset,
            sell_price: tokens.reference_price(&order.sell.token),
        };
        let swap = self.try_solve(order, &dex_order, tokens, is_quote).await?;
        let sell = tokens.reference_price(&order.sell.token);
        let Some(solution) = swap
            .into_solution(
                order.clone(),
                gas_price,
                sell,
                tokens,
                &self.simulator,
                self.gas_offset,
                &self.output_guard,
                is_quote,
            )
            .await
        else {
            tracing::debug!("no solution for swap");
            return None;
        };

        tracing::debug!("solved");
        // Maybe some liquidity appeared that enables a bigger fill.
        self.fills.increase_next_try(order.uid);

        if self.internalize_interactions {
            Some(solution.with_buffers_internalizations(tokens))
        } else {
            Some(solution)
        }
    }
}
