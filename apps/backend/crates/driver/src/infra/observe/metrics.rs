use prometheus::HistogramTimer;

/// Label values for `resimulation_transport_error{kind=…}`. Centralized
/// here so callers can't typo-create new series (a Prometheus footgun
/// flagged by sharp-edges review of M7+M12).
pub mod resim_kind {
    /// `alloy::transports::RpcError` that is *not* `is_error_resp()` —
    /// the node didn't reply with a structured error, so this is local
    /// network / remote node unreachable / fallback exhausted.
    pub const TRANSPORT: &str = "transport";
    /// `GasPrice(_)` — the gas-price boundary itself failed (rare; usually
    /// a misconfigured fee oracle or a chain that returned nonsense).
    pub const GAS_PRICE: &str = "gas_price";
    /// Anything else that didn't match the dedicated buckets.
    pub const OTHER: &str = "other";
}

/// Label values for `access_list_fallback{kind=…}`.
pub mod access_list_fallback_kind {
    /// `simulator::Error::Other` covers both transport and decode; left
    /// single-bucket because M7's fallback is benign and the volume is
    /// low. Operators alert on the *rate*, not the *cause* — and the
    /// cause is in the accompanying `tracing::warn!`.
    pub const TRANSPORT_OR_DECODE: &str = "transport_or_decode";
}

/// Metrics for the driver.
#[derive(Debug, Clone, prometheus_metric_storage::MetricStorage)]
pub struct Metrics {
    /// Reasons for dropped solutions.
    #[metric(labels("solver", "reason"))]
    pub dropped_solutions: prometheus::IntCounterVec,
    /// The results of the solving process.
    #[metric(labels("solver", "result"))]
    pub solutions: prometheus::IntCounterVec,
    /// The results of the reveal process.
    #[metric(labels("solver", "result"))]
    pub reveals: prometheus::IntCounterVec,
    /// The results of the settlement process.
    #[metric(labels("solver", "result"))]
    pub settlements: prometheus::IntCounterVec,
    /// The results of the quoting process.
    #[metric(labels("solver", "result"))]
    pub quotes: prometheus::IntCounterVec,
    /// The results of the mempool submission.
    #[metric(labels("mempool", "result"))]
    pub mempool_submission: prometheus::IntCounterVec,
    /// The number of blocks passed between the first time submission was
    /// atempted and the error detection.
    #[metric(labels("mempool", "result"))]
    pub mempool_submission_results_blocks_passed: prometheus::IntCounterVec,
    /// How many orders detected by specific solver and strategy.
    #[metric(labels("solver"))]
    pub bad_orders_detected: prometheus::IntCounterVec,
    /// Orders dropped because their app_data hooks declare `gas_limit` above
    /// the chain-aware per-hook cap. Audit MEDIUM-8 mitigation; primarily
    /// fires on HyperEVM (chain 999) where the block gas budget is tight.
    #[metric(labels("chain_id"))]
    pub dropped_orders_hook_gas_limit: prometheus::IntCounterVec,
    /// Mempool cancellation failures. Each event indicates the submitter
    /// nonce may now be stuck — operator intervention required. Audit
    /// Phase 2 finding H2; pre-this-metric these failures were `let _ =`
    /// discarded.
    #[metric(labels("mempool", "reason"))]
    pub submitter_cancellation_failed: prometheus::IntCounterVec,
    /// How many tokens detected by specific solver and strategy.
    pub bad_tokens_detected: prometheus::IntCounter,
    /// Access-list estimation failures that fell back to an empty access list.
    /// Phase 2 audit MED M7: the fallback itself is intentional (the tx
    /// would still succeed on-chain without the access list) but operators
    /// need visibility into when/how often it fires — a sustained spike
    /// implies a degraded simulator/RPC, not just a transient blip.
    /// Pre-this-metric, the only signal was a `tracing::warn!`.
    #[metric(labels("kind"))]
    pub access_list_fallback: prometheus::IntCounterVec,
    /// Mempool inspection (txpool_content_from) failed. Function-
    /// analyzer F9 (2026-05-21): `txpool_content_from` is a Geth-only
    /// debug method that many public providers reject. The driver
    /// silently degrades (loses pending-tx visibility) when this is
    /// unavailable. Counter lets ops detect provider-unsupport per
    /// mempool — sustained non-zero on a mempool flags either a
    /// provider that doesn't implement the method or transient
    /// degradation worth investigating.
    #[metric(labels("mempool"))]
    pub mempool_txpool_inspect_error: prometheus::IntCounterVec,
    /// In-flight tx re-simulation transport errors (non-revert).
    /// Phase 2 audit MED M12: an RPC outage during in-flight tracking
    /// causes `estimate_gas` to fail-non-revert, which previously was a
    /// silent `tracing::warn!` and continued holding the tx. With this
    /// metric, ops can alert when re-sim transport errors per signer
    /// exceed a threshold (signals either RPC degradation or an exhausted
    /// fallback chain) and intervene before the deadline.
    #[metric(labels("mempool", "kind"))]
    pub resimulation_transport_error: prometheus::IntCounterVec,
    /// Final gas price (post-replacement-bump, post-solver-override) exceeded
    /// the configured per-mempool `gas_price_cap`. Phase 4 audit F2 — the
    /// initial estimate is cap-enforced in `gas.rs::estimate()`, but RBF and
    /// solver overrides happen downstream of that check. A non-zero rate on
    /// this counter indicates either a pathological upstream RPC misreport
    /// of `eth_gasPrice` (cap-bypass attempt) OR an over-aggressive solver
    /// override hitting the cap legitimately. Either way: operator
    /// intervention required. Page on rate > 0 for 5m.
    ///
    /// `context` label values:
    ///   - "submit_settlement" — main settle() broadcast path
    ///   - "cancel_settlement" — cancellation/RBF path
    #[metric(labels("mempool", "context"))]
    pub gas_price_cap_exceeded: prometheus::IntCounterVec,
    /// Winner re-simulation produced a non-revert error (RPC failure,
    /// simulator outage, etc.). Pre-this-metric, these errors were
    /// indistinguishable from "simulation passed" — winning solutions
    /// stayed in the candidate set on simulator outages, producing
    /// settlements that could revert on-chain. The error path still
    /// returns the winner (conservative — we don't know it would
    /// revert), but the metric lets ops alert on simulator degradation.
    #[metric(labels("solver"))]
    pub winner_resim_non_revert_error: prometheus::IntCounterVec,
    /// Time spent in the auction preprocessing stage.
    #[metric(
        labels("stage"),
        buckets(
            0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0
        )
    )]
    pub auction_preprocessing: prometheus::HistogramVec,

    /// Remaining time the solver has to compute a solution.
    #[metric(
        labels("solver", "kind"),
        buckets(
            0.5, 1., 1.5, 2., 2.5, 3., 3.5, 4., 4.5, 5., 5.5, 6., 6.5, 7., 7.5, 8., 8.5, 9., 9.5,
            10, 10.5, 11.
        )
    )]
    pub remaining_solve_time: prometheus::HistogramVec,

    /// How much time it took to receive a response from the solver.
    #[metric(
        labels("solver", "kind"),
        buckets(
            0.5, 1, 1.5, 2, 2.5, 3., 3.5, 4., 4.5, 5., 5.5, 6., 6.5, 7., 7.5, 8., 8.5, 9., 9.5, 10,
            10.5, 11.
        )
    )]
    pub used_solve_time: prometheus::HistogramVec,
}

impl Metrics {
    pub fn processing_stage_timer(&self, stage: &str) -> HistogramTimer {
        self.auction_preprocessing
            .with_label_values(&[stage])
            .start_timer()
    }
}

/// Setup the metrics registry.
pub fn init() {
    observe::metrics::setup_registry_reentrant(Some("driver".to_owned()), None);
}

/// Get the metrics instance.
pub fn get() -> &'static Metrics {
    Metrics::instance(observe::metrics::get_storage_registry())
        .expect("unexpected error getting metrics instance")
}
