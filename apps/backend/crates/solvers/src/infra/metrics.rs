use crate::domain::{auction, solution};

/// Metrics for the solver engine.
#[derive(Debug, Clone, prometheus_metric_storage::MetricStorage)]
#[metric(subsystem = "solver_engine")]
struct Metrics {
    /// The amount of time this solver engine has for solving.
    #[metric(buckets(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15))]
    time_limit: prometheus::Histogram,

    /// The amount of time this solver engine has left when it finished solving.
    #[metric(buckets(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15))]
    remaining_time: prometheus::Histogram,

    /// Total number of requests that got sent to the DEX API.
    solve_requests: prometheus::IntCounter,

    /// Errors that occurred during solving.
    #[metric(labels("reason"))]
    solve_errors: prometheus::IntCounterVec,

    /// The number of solutions that were found.
    solutions: prometheus::IntCounter,

    /// DEX-side slippage tolerance clamps. Phase 2 audit MED M10: the
    /// solver asks the DEX for slippage `requested_bps`; the DEX caps
    /// it at its own `max_bps` (KyberSwap, Velora, ...) and executes
    /// the route with the tighter tolerance. Pre-this-metric the only
    /// signal was a `tracing::warn!` per request — not alertable.
    ///
    /// The clamp is a *user-facing economic divergence*: the on-chain
    /// transaction is now sensitive to a smaller slippage band than the
    /// user signed for, so a real-world price move that the user would
    /// have tolerated now reverts as a "slippage exceeded" failure.
    /// Operators alert on the rate per dex to catch either:
    ///   - chain volatility pushing through our default slippage band
    ///     (action: widen the band), or
    ///   - a DEX silently lowering its max_bps (action: re-tune).
    #[metric(labels("dex"))]
    dex_slippage_clamped: prometheus::IntCounterVec,
}

/// Setup the metrics registry.
pub fn init() {
    observe::metrics::setup_registry_reentrant(Some("solver-engine".to_owned()), None);
}

pub fn solve(auction: &auction::Auction) {
    get().time_limit.observe(
        auction
            .deadline
            .remaining()
            .unwrap_or_default()
            .as_secs_f64(),
    );
}

pub fn solved(deadline: &auction::Deadline, solutions: &[solution::Solution]) {
    get()
        .remaining_time
        .observe(deadline.remaining().unwrap_or_default().as_secs_f64());
    get().solutions.inc_by(solutions.len() as u64);
}

pub fn solve_error(reason: &str) {
    get().solve_errors.with_label_values(&[reason]).inc();
}

pub fn request_sent() {
    get().solve_requests.inc();
}

/// Typed identifier for a DEX integration. Used both as the
/// `dex_slippage_clamped{dex}` label value and as a compile-time gate:
/// `clamp_slippage_bps` only accepts a `Dex`, so a typo / new
/// integration cannot silently spawn a new Prometheus series.
#[derive(Debug, Clone, Copy)]
pub enum Dex {
    KyberSwap,
    Velora,
    Odos,
    OpenOcean,
    Dodo,
    Okx,
    Lifi,
    Enso,
}

impl Dex {
    fn as_label(self) -> &'static str {
        match self {
            Dex::KyberSwap => "kyberswap",
            Dex::Velora => "velora",
            Dex::Odos => "odos",
            Dex::OpenOcean => "openocean",
            Dex::Dodo => "dodo",
            Dex::Okx => "okx",
            Dex::Lifi => "lifi",
            Dex::Enso => "enso",
        }
    }
}

/// Clamp the solver's requested slippage to the DEX's hard cap,
/// recording the clamp as a metric when it fires.
///
/// Phase 2 audit MED M10 chokepoint: keeping clamp + metric in the same
/// function guarantees a new DEX integration cannot reintroduce the
/// "silent clamp + tracing::warn! only" pattern. Pattern-matched
/// `Dex` argument also prevents the typo-creates-new-series footgun
/// (sharp-edges-flagged in pre-merge review).
pub fn clamp_slippage_bps(dex: Dex, requested_bps: u16, max_bps: u16) -> u16 {
    if requested_bps > max_bps {
        tracing::warn!(
            dex = dex.as_label(),
            requested = requested_bps,
            clamp = max_bps,
            "slippage exceeds DEX maximum, clamping",
        );
        get()
            .dex_slippage_clamped
            .with_label_values(&[dex.as_label()])
            .inc();
        max_bps
    } else {
        requested_bps
    }
}

/// Get the metrics instance.
fn get() -> &'static Metrics {
    Metrics::instance(observe::metrics::get_storage_registry())
        .expect("unexpected error getting metrics instance")
}
