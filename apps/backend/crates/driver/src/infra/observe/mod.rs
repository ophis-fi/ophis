//! This module implements the observability for the driver. It exposes
//! functions which represent events that are meaningful to the system. These
//! functions are called when the corresponding events occur. They log the event
//! and update the metrics, if the event is worth measuring.

use {
    super::{Ethereum, Mempool, solver::Timeouts},
    crate::{
        boundary,
        domain::{
            Liquidity,
            competition::{
                self,
                Solution,
                Solved,
                solution::{self, Settlement},
            },
            mempools::{self, SubmissionSuccess},
            quote::{self, Quote},
            time::{Deadline, Remaining},
        },
        infra::solver,
        util::http,
    },
    eth_domain_types::{self as eth, Gas},
    ethrpc::block_stream::BlockInfo,
    num::Saturating,
    std::{
        collections::{BTreeMap, HashSet},
        time::Duration,
    },
    url::Url,
};

pub mod metrics;

/// Setup the observability. The log argument configures the tokio tracing
/// framework.
pub fn init(obs_config: observe::Config) {
    observe::tracing::init::initialize_reentrant(&obs_config);
    metrics::init();
    #[cfg(unix)]
    observe::heap_dump_handler::spawn_heap_dump_handler();
}

/// Observe a received auction.
pub fn auction(auction_id: i64) {
    tracing::debug!(id=?auction_id, "received auction");
}

/// Observe that liquidity fetching is about to start.
pub fn fetching_liquidity() {
    tracing::trace!("fetching liquidity");
}

/// Observe the fetched liquidity.
pub fn fetched_liquidity(liquidity: &[Liquidity]) {
    let mut grouped: BTreeMap<&'static str, usize> = Default::default();
    for liquidity in liquidity {
        *grouped.entry((&liquidity.kind).into()).or_default() += 1;
    }
    tracing::debug!(liquidity = ?grouped, "fetched liquidity sources");
}

/// Observe that fetching liquidity failed.
pub fn fetching_liquidity_failed(err: &boundary::Error) {
    tracing::warn!(?err, "failed to fetch liquidity");
}

pub fn duplicated_solution_id(solver: &solver::Name, id: &solution::Id) {
    tracing::debug!(?id, "discarded solution: duplicated id");
    metrics::get()
        .dropped_solutions
        .with_label_values(&[solver.as_str(), "DuplicateId"])
        .inc();
}

/// Observe the solutions returned by the solver.
pub fn solutions(
    solutions: &[Solution],
    surplus_capturing_jit_order_owners: &HashSet<eth::Address>,
) {
    if solutions
        .iter()
        .any(|s| !s.is_empty(surplus_capturing_jit_order_owners))
    {
        tracing::info!(?solutions, "computed solutions");
    } else {
        tracing::debug!("no solutions");
    }
}

/// Observe that a solution was discarded because it is empty.
pub fn empty_solution(solver: &solver::Name, id: &solution::Id) {
    tracing::debug!(?id, "discarded solution: empty");
    metrics::get()
        .dropped_solutions
        .with_label_values(&[solver.as_str(), "EmptySolution"])
        .inc();
}

// Observe that postprocessing (encoding & merging) of solutions is about to
// start.
pub fn postprocessing(solutions: &[Solution], deadline: chrono::DateTime<chrono::Utc>) {
    tracing::debug!(
        solutions = ?solutions.len(),
        remaining = ?deadline.remaining(),
        "postprocessing solutions"
    );
}

// Observe that postprocessing didn't complete before the timeout.
pub fn postprocessing_timed_out(completed: &[Settlement]) {
    tracing::debug!(
        completed = ?completed.len(),
        "postprocessing solutions timed out"
    );
}

/// Observe that a solution is about to be encoded into a settlement.
pub fn encoding(id: &solution::Id) {
    tracing::trace!(?id, "encoding settlement");
}

/// Observe that settlement encoding failed.
pub fn encoding_failed(
    solver: &solver::Name,
    id: &solution::Id,
    err: &solution::Error,
    has_haircut: bool,
    orders: &[competition::order::Uid],
) {
    tracing::info!(
        ?id,
        ?orders,
        ?err,
        has_haircut,
        "discarded solution: settlement encoding"
    );
    let reason = if has_haircut {
        "SettlementEncodingHaircut"
    } else {
        "SettlementEncoding"
    };
    metrics::get()
        .dropped_solutions
        .with_label_values(&[solver.as_str(), reason])
        .inc();
}

/// Observe that two solutions were merged.
pub fn merged(first: &Solution, other: &Solution, result: &Solution) {
    tracing::trace!(?first, ?other, ?result, "merged solutions");
}

/// Observe that scoring is about to start.
pub fn scoring(settlement: &Settlement) {
    tracing::trace!(
        solution = ?settlement.solution(),
        gas = ?settlement.gas,
        "scoring settlement"
    );
}

/// Observe that scoring failed.
pub fn scoring_failed(solver: &solver::Name, err: &solution::error::Scoring) {
    tracing::info!(%solver, ?err, "discarded solution: scoring");
    metrics::get()
        .dropped_solutions
        .with_label_values(&[solver.as_str(), "Scoring"])
        .inc();
}

/// Observe the settlement score.
pub fn score(settlement: &Settlement, score: &eth::Ether) {
    tracing::info!(
        solution = ?settlement.solution(),
        score = ?score,
        "scored settlement"
    );
}

// Observe that the winning settlement started failing upon arrival of a new
// block
pub fn winner_voided(
    solver: &solver::Name,
    block: BlockInfo,
    err: &simulator::RevertError,
    has_haircut: bool,
) {
    tracing::warn!(
        block = block.number,
        ?err,
        has_haircut,
        "solution reverts on new block"
    );
    let reason = if has_haircut {
        "SimulationRevertHaircut"
    } else {
        "SimulationRevert"
    };
    metrics::get()
        .dropped_solutions
        .with_label_values(&[solver.as_str(), reason])
        .inc();
}

pub fn revealing() {
    tracing::trace!("revealing");
}

pub fn revealed(solver: &solver::Name, result: &Result<competition::Revealed, competition::Error>) {
    match result {
        Ok(calldata) => {
            tracing::info!(?calldata, "revealed");
            metrics::get()
                .reveals
                .with_label_values(&[solver.as_str(), "Success"])
                .inc();
        }
        Err(err) => {
            tracing::warn!(?err, "failed to reveal");
            metrics::get()
                .reveals
                .with_label_values(&[solver.as_str(), competition_error(err)])
                .inc();
        }
    }
}

/// Observe that the settlement process is about to start.
pub fn settling() {
    tracing::trace!("settling solution");
}

/// Observe the result of the settlement process.
pub fn settled(solver: &solver::Name, result: &Result<competition::Settled, competition::Error>) {
    match result {
        Ok(calldata) => {
            tracing::info!(?calldata, "settled solution");
            metrics::get()
                .settlements
                .with_label_values(&[solver.as_str(), "Success"])
                .inc();
        }
        Err(err) => {
            tracing::warn!(?err, "failed to settle");
            metrics::get()
                .settlements
                .with_label_values(&[solver.as_str(), competition_error(err)])
                .inc();
        }
    }
}

/// Observe the result of solving an auction.
pub fn solved(solver: &str, result: &Result<Vec<Solved>, competition::Error>) {
    match result {
        Ok(solutions) if solutions.is_empty() => {
            tracing::debug!("no solution found");
            metrics::get()
                .solutions
                .with_label_values(&[solver, "SolutionNotFound"])
                .inc();
        }
        Ok(solutions) => {
            tracing::info!(?solutions, "solved auction");
            metrics::get()
                .solutions
                .with_label_values(&[solver, "Success"])
                .inc_by(solutions.len() as u64);
        }
        Err(err) => {
            tracing::warn!(?err, "failed to solve auction");
            metrics::get()
                .solutions
                .with_label_values(&[solver, competition_error(err)])
                .inc();
        }
    }
}

/// Observe the result of quoting an auction.
pub fn quoted(solver: &solver::Name, order: &quote::Order, result: &Result<Quote, quote::Error>) {
    match result {
        Ok(quote) => {
            tracing::info!(?order, ?quote, "quoted order");
            metrics::get()
                .quotes
                .with_label_values(&[solver.as_str(), "Success"])
                .inc();
        }
        Err(err) => {
            tracing::warn!(?order, ?err, "failed to quote order");
            metrics::get()
                .quotes
                .with_label_values(&[
                    solver.as_str(),
                    match err {
                        quote::Error::QuotingFailed(quote::QuotingFailed::ClearingSellMissing) => {
                            "ClearingSellMissing"
                        }
                        quote::Error::QuotingFailed(quote::QuotingFailed::ClearingBuyMissing) => {
                            "ClearingBuyMissing"
                        }
                        quote::Error::QuotingFailed(quote::QuotingFailed::NoSolutions) => {
                            "NoSolutions"
                        }
                        quote::Error::QuotingFailed(quote::QuotingFailed::Math) => "MathError",
                        quote::Error::QuotingFailed(quote::QuotingFailed::UnsupportedToken) => {
                            "UnsupportedToken"
                        }
                        quote::Error::DeadlineExceeded(_) => "DeadlineExceeded",
                        quote::Error::Blockchain(_) => "BlockchainError",
                        quote::Error::Solver(solver::Error::Http(_)) => "SolverHttpError",
                        quote::Error::Solver(solver::Error::Deserialize(_)) => {
                            "SolverDeserializeError"
                        }
                        quote::Error::Solver(solver::Error::Dto(_)) => "SolverDtoError",
                        quote::Error::Solver(solver::Error::CustomError(_)) => "SolverCustomError",
                        quote::Error::Solver(solver::Error::DeadlineExceededBeforeRequest) => {
                            "SolverDeadlineExceededBeforeRequest"
                        }
                        quote::Error::Boundary(_) => "Unknown",
                        quote::Error::Encoding(_) => "Encoding",
                    },
                ])
                .inc();
        }
    }
}

/// Observe that the API routes for a solver are being mounted.
pub fn mounting_solver(solver: &solver::Name, path: &str) {
    tracing::debug!(%solver, path, "mounting solver");
}

/// Observe that a request is about to be sent to the solver.
pub fn solver_request(endpoint: &Url, req: &str) {
    tracing::trace!(%endpoint, %req, "sending request to solver");
}

/// Observe that a response was received from the solver.
pub fn solver_response(
    endpoint: &Url,
    res: Result<&str, &http::Error>,
    solver: &str,
    compute_time: Duration,
    is_quote_request: bool,
) {
    match res {
        Ok(res) => {
            tracing::trace!(%endpoint, %res, "received response from solver")
        }
        Err(err) => {
            tracing::warn!(%endpoint, ?err, "failed to receive response from solver")
        }
    }
    let kind = if is_quote_request { "quote" } else { "auction" };
    metrics::get()
        .used_solve_time
        .with_label_values(&[solver, kind])
        .observe(compute_time.as_secs_f64());
}

/// Every `result` label value that `mempool_executed` can emit. Kept adjacent
/// to the match in `mempool_executed` (which `debug_assert!`s membership) so
/// the two cannot drift silently.
pub(crate) const MEMPOOL_SUBMISSION_RESULTS: [&str; 6] = [
    "Success",
    "Revert",
    "Expired",
    "GasPriceCapExceeded",
    "Other",
    "Disabled",
];

/// Every `context` label value used on `gas_price_cap_exceeded`
/// (domain/mempools.rs submit + cancel paths).
pub(crate) const GAS_PRICE_CAP_CONTEXTS: [&str; 2] = ["submit_settlement", "cancel_settlement"];

/// Pre-create the lazy CounterVec children the alerting layer depends on, so
/// Prometheus exports them at 0 from the first scrape and every later
/// increment is an observable transition.
///
/// Why this exists (observability/alerts.yml, 2026-08-09 incident review):
/// a lazily-born child's first scraped value is arbitrary — a burst between
/// scrapes lands at 2+, and after a driver restart a reborn child can land on
/// exactly its pre-restart value. No PromQL over the samples alone can
/// distinguish those histories (missed critical pages or false pages,
/// depending on the expression), so the gap has to be closed here at the
/// producer: with children present at 0, plain `increase()`/`rate()` alert
/// forms are correct by construction.
pub fn init_mempool_metric_children(mempool_names: &[String]) {
    let metrics = metrics::get();
    for name in mempool_names {
        for result in MEMPOOL_SUBMISSION_RESULTS {
            metrics
                .mempool_submission
                .with_label_values(&[name.as_str(), result]);
        }
        for context in GAS_PRICE_CAP_CONTEXTS {
            metrics
                .gas_price_cap_exceeded
                .with_label_values(&[name.as_str(), context]);
        }
    }
}

/// Observe the result of mempool transaction execution.
pub fn mempool_executed(
    mempool: &Mempool,
    settlement: &Settlement,
    res: &Result<SubmissionSuccess, mempools::Error>,
) {
    match res {
        Ok(submission) => {
            tracing::info!(
                txid = ?submission.tx_hash,
                %mempool,
                ?settlement,
                "sending transaction via mempool succeeded",
            );
        }
        Err(mempools::Error::Disabled) => {
            tracing::debug!(
                %mempool,
                "sending transaction via mempool disabled",
            );
        }
        Err(err) => {
            tracing::warn!(
                ?err,
                %mempool,
                ?settlement,
                "sending transaction via mempool failed",
            );
        }
    }
    let result = match res {
        Ok(_) => "Success",
        Err(mempools::Error::Revert { .. } | mempools::Error::SimulationRevert { .. }) => "Revert",
        Err(mempools::Error::Expired { .. }) => "Expired",
        Err(mempools::Error::GasPriceCapExceeded { .. }) => "GasPriceCapExceeded",
        Err(mempools::Error::Other(_)) => "Other",
        Err(mempools::Error::Disabled) => "Disabled",
    };
    // A value missing from the const would resurrect the lazy-child alerting
    // gap for that value — keep the list and this match in lockstep.
    debug_assert!(
        MEMPOOL_SUBMISSION_RESULTS.contains(&result),
        "mempool_executed result {result:?} missing from MEMPOOL_SUBMISSION_RESULTS"
    );
    metrics::get()
        .mempool_submission
        .with_label_values(&[mempool.to_string().as_str(), result])
        .inc();

    // For some of the errors we are interested in observing the exact block numbers
    // passed since the first submission.
    let blocks_passed = match res {
        Ok(SubmissionSuccess {
            submitted_at_block,
            included_in_block,
            ..
        }) => Some(("Success", submitted_at_block, included_in_block)),
        Err(mempools::Error::Revert {
            tx_id: _,
            submitted_at_block,
            reverted_at_block,
        }) => Some(("Revert", submitted_at_block, reverted_at_block)),
        Err(mempools::Error::SimulationRevert {
            submitted_at_block,
            reverted_at_block,
        }) => Some(("Revert", submitted_at_block, reverted_at_block)),
        Err(mempools::Error::Expired {
            tx_id: _,
            submitted_at_block,
            submission_deadline,
        }) => Some(("Expired", submitted_at_block, submission_deadline)),
        Err(mempools::Error::GasPriceCapExceeded { .. }) => None,
        Err(mempools::Error::Other(_)) => None,
        Err(mempools::Error::Disabled) => None,
    };

    if let Some((label, start, end)) = blocks_passed {
        let blocks_passed = end.saturating_sub(*start);
        metrics::get()
            .mempool_submission_results_blocks_passed
            .with_label_values(&[mempool.to_string().as_str(), label])
            .inc_by(blocks_passed.0);
    }
}

/// Observe that an invalid DTO was received.
pub fn invalid_dto(err: &impl std::error::Error, dto: &str) {
    tracing::warn!(?err, ?dto, "received invalid dto");
}

/// Observe that the quoting process is about to start.
pub fn quoting(order: &quote::Order) {
    tracing::trace!(?order, "quoting");
}

fn competition_error(err: &competition::Error) -> &'static str {
    match err {
        competition::Error::SolutionNotAvailable => "SolutionNotAvailable",
        competition::Error::DeadlineExceeded(_) => "DeadlineExceeded",
        competition::Error::Solver(solver::Error::Http(_)) => "SolverHttpError",
        competition::Error::Solver(solver::Error::Deserialize(_)) => "SolverDeserializeError",
        competition::Error::Solver(solver::Error::Dto(_)) => "SolverDtoError",
        competition::Error::Solver(solver::Error::CustomError(_)) => "SolverCustomError",
        competition::Error::Solver(solver::Error::DeadlineExceededBeforeRequest) => {
            "SolverDeadlineExceededBeforeRequest"
        }
        competition::Error::SubmissionError(kind) => kind.as_label(),
        competition::Error::TooManyPendingSettlements => "TooManyPendingSettlements",
        competition::Error::NoValidOrdersFound => "NoValidOrdersFound",
        competition::Error::MalformedRequest => "MalformedRequest",
    }
}

pub fn deadline(deadline: &Deadline, timeouts: &Timeouts) {
    tracing::trace!(?deadline, ?timeouts, "computed deadline");
}

pub fn sending_solve_request(solver: &str, remaining_time: Duration, is_quote_request: bool) {
    tracing::trace!(?remaining_time, "sending solve request");
    let kind = if is_quote_request { "quote" } else { "auction" };
    metrics::get()
        .remaining_solve_time
        .with_label_values(&[solver, kind])
        .observe(remaining_time.as_secs_f64());
}

#[derive(Debug)]
pub enum OrderExcludedFromAuctionReason {
    CouldNotFetchBalance,
    InsufficientBalance,
    OrderWithZeroAmountRemaining,
}

pub fn order_excluded_from_auction(
    order: &competition::Order,
    reason: OrderExcludedFromAuctionReason,
) {
    tracing::trace!(uid=?order.uid, ?reason, "order excluded from auction");
}

/// Observe that a settlement was simulated
pub fn simulated(eth: &Ethereum, tx: &eth::Tx, gas: &Result<Gas, simulator::Error>) {
    let block: eth::BlockNo = eth.current_block().borrow().number.into();
    match gas {
        Ok(gas) => tracing::debug!(block = ?block, gas = ?gas.0, ?tx, "simulated settlement"),
        Err(err) => tracing::debug!(block = ?block, ?err, "simulated settlement"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The children must be present at 0 in the REGISTRY after init — asserted
    /// via gather(), which cannot create children, so a passing test proves
    /// pre-initialization did (a with_label_values-based assertion would
    /// create the child it checks and could never fail).
    #[test]
    fn init_mempool_metric_children_exports_zeroed_children() {
        metrics::init();
        init_mempool_metric_children(&["Mempool(test_lane)".to_string()]);

        let families = ::observe::metrics::get_storage_registry().gather();
        let assert_children = |metric_name: &str, label_name: &str, expected: &[&str]| {
            let family = families
                .iter()
                .find(|f| f.get_name().ends_with(metric_name))
                .unwrap_or_else(|| panic!("{metric_name} family missing from registry"));
            for value in expected {
                let child = family
                    .get_metric()
                    .iter()
                    .find(|m| {
                        let labels = m.get_label();
                        labels
                            .iter()
                            .any(|l| l.name() == "mempool" && l.value() == "Mempool(test_lane)")
                            && labels
                                .iter()
                                .any(|l| l.name() == label_name && l.value() == *value)
                    })
                    .unwrap_or_else(|| panic!("{metric_name} child {value:?} missing"));
                assert_eq!(
                    child.get_counter().value(),
                    0.0,
                    "{metric_name} child {value:?} must start at 0"
                );
            }
        };
        assert_children(
            "mempool_submission",
            "result",
            &MEMPOOL_SUBMISSION_RESULTS[..],
        );
        assert_children(
            "gas_price_cap_exceeded",
            "context",
            &GAS_PRICE_CAP_CONTEXTS[..],
        );
    }
}
