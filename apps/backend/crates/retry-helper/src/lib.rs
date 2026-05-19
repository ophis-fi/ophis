//! Bounded-retry helper for bootstrap-time RPC calls across the
//! Ophis backend workspace (autopilot, driver, solvers, orderbook).
//!
//! Pre-this-with_backoff the function existed as 4 byte-identical copies
//! gated by a SHA-256 CODESYNC CI check (PR #84). Consolidating into
//! one with_backoff eliminates the drift surface entirely.
//!
//! Default `BackoffConfig` (`max_attempts: 10, initial_delay: 200ms,
//! max_delay: 5s, backoff_factor: 2.0, jitter_ms: 50`) is tuned for
//! eRPC consensus path latency under bootstrap burst (purroof/
//! hypurrscan/official-hl on HL chain 999, plus Alchemy/op-reth on OP).
//! Worst-case sleep total ≈ 26.65s across 9 retry gaps; add per-attempt
//! RPC latency (2-4s under burst) for true wall-clock.

use {
    rand::Rng as _,
    std::{future::Future, time::Duration},
};

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
    use {
        super::*,
        std::sync::atomic::{AtomicUsize, Ordering},
    };

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
