//! Bounded-retry helper for fallible async operations, designed for the
//! autopilot's bootstrap-time RPC calls.
//!
//! Background: the autopilot's startup performs several `eth_call` / chain-id
//! queries against the eRPC proxy. The proxy enforces a strict 2-of-3 consensus
//! over HL upstreams (`disputeBehavior: returnError`,
//! `lowParticipantsBehavior: returnError`) — audit-required for
//! fork-view-poisoning resistance. Under bootstrap burst, transient
//! `ErrConsensusLowParticipants` events occur when 2 of 3 upstreams exhaust
//! their per-request retry budget simultaneously. The right response is to
//! retry the request at the application layer with backoff, not to weaken the
//! consensus invariant.
//!
//! See also: `apps/backend/crates/autopilot/src/run.rs:242` (the original
//! crash site that motivated this helper) and the project memory entry
//! `project_ophis_autopilot_bootstrap_loop`.

use {
    rand::Rng as _,
    std::{future::Future, time::Duration},
};

/// Configuration for `with_backoff`. The defaults target the
/// startup-burst regime: aggressive enough to recover from transient
/// upstream exhaustion within a few seconds, bounded enough that a real
/// outage surfaces as a clean error rather than an infinite hang.
///
/// CODESYNC(retry-helper): also defined in
/// `apps/backend/crates/orderbook/src/retry.rs` and
/// `apps/backend/crates/solvers/src/util/retry.rs`. Keep all three copies
/// in sync until a shared crate exists. CI grep checks file checksums.
#[derive(Debug, Clone)]
pub struct BackoffConfig {
    pub max_attempts: usize,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub backoff_factor: f64,
    pub jitter_ms: u64,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        // Worst-case sleep total: delays 200+400+800+1600+3200+5000+5000+
        // 5000+5000 = 26.2s across 9 inter-attempt gaps, + up to 9×50ms
        // jitter = ~26.65s sleep-only. Add per-attempt RPC latency (eRPC
        // consensus path can be 2-4s under burst) for true wall-clock.
        Self {
            max_attempts: 10,
            initial_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
            backoff_factor: 2.0,
            jitter_ms: 50,
        }
    }
}

/// Retry an async fallible operation with exponential backoff + jitter.
///
/// On each failure logs a `warn` with the operation name, attempt number and
/// error display. On final exhaustion returns the last error verbatim — the
/// caller is responsible for the surrounding `.expect()` or `?` if a panic /
/// propagation is appropriate.
///
/// The `name` argument is used only for tracing context; pick something that
/// would let an oncall operator find the call site quickly.
pub async fn with_backoff<T, E, F, Fut>(
    name: &str,
    config: BackoffConfig,
    mut operation: F,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    let mut delay = config.initial_delay;
    let mut last_err: Option<E> = None;

    for attempt in 1..=config.max_attempts {
        match operation().await {
            Ok(value) => {
                if attempt > 1 {
                    tracing::info!(operation = name, attempt, "succeeded after retry");
                }
                return Ok(value);
            }
            Err(err) => {
                tracing::warn!(
                    operation = name,
                    attempt,
                    max_attempts = config.max_attempts,
                    error = %err,
                    "transient failure; will retry"
                );
                last_err = Some(err);
                if attempt < config.max_attempts {
                    let jitter = rand::rng().random_range(0..=config.jitter_ms);
                    tokio::time::sleep(delay + Duration::from_millis(jitter)).await;
                    let next_ms = (delay.as_millis() as f64 * config.backoff_factor) as u64;
                    delay = Duration::from_millis(next_ms).min(config.max_delay);
                }
            }
        }
    }

    Err(last_err.expect("with_backoff exhausted attempts without recording an error"))
}

#[cfg(test)]
mod tests {
    use {super::*, std::sync::atomic::{AtomicUsize, Ordering}};

    fn fast_config() -> BackoffConfig {
        BackoffConfig {
            max_attempts: 5,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(2),
            backoff_factor: 2.0,
            jitter_ms: 0,
        }
    }

    #[tokio::test]
    async fn succeeds_on_first_attempt() {
        let attempts = AtomicUsize::new(0);
        let result: Result<u32, &'static str> = with_backoff("test", fast_config(), || async {
            attempts.fetch_add(1, Ordering::SeqCst);
            Ok(42u32)
        })
        .await;
        assert_eq!(result, Ok(42));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retries_until_success() {
        let attempts = AtomicUsize::new(0);
        let result: Result<u32, &'static str> = with_backoff("test", fast_config(), || async {
            let n = attempts.fetch_add(1, Ordering::SeqCst) + 1;
            if n < 3 { Err("transient") } else { Ok(7u32) }
        })
        .await;
        assert_eq!(result, Ok(7));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn fails_after_max_attempts() {
        let attempts = AtomicUsize::new(0);
        let result: Result<u32, &'static str> = with_backoff("test", fast_config(), || async {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err("permanent")
        })
        .await;
        assert_eq!(result, Err("permanent"));
        assert_eq!(attempts.load(Ordering::SeqCst), 5);
    }
}
