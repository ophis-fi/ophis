//! Orderbook-native per-client rate limiting (api-dx decision 10).
//!
//! A keyed token bucket in front of every public API route: each client gets
//! `burst` tokens that refill at `requests_per_second`; a request spends one
//! token, and a client with an empty bucket receives HTTP 429 with the frozen
//! code 1029 `RATE_LIMITED` plus a `Retry-After` header, mirroring the 503
//! conventions from the api-dx error taxonomy (a numeric code next to the
//! `errorType`, the trace id in the body, and an integer-seconds
//! `Retry-After`). Doctrine: a 429 is never retryable within the same call;
//! back off for at least `Retry-After` seconds and issue a new attempt.
//!
//! SHIPS DISABLED. `enabled = false` in every checked-in config keeps this
//! middleware completely inert (no counting, no per-client state). The flip
//! and the published limits table land together in a later window, with one
//! consistent set of numbers derived from Cloudflare traffic data, so
//! documented limits can never disagree with enforced ones.
//!
//! Client identity: `CF-Connecting-IP` when `trust_cf_connecting_ip` is set
//! (the production posture, where the host is only reachable through
//! Cloudflare), otherwise the socket peer address. Requests with neither
//! share one `Unknown` bucket -- fail closed: an unidentifiable client is
//! still limited rather than exempt.
//!
//! `/api/v1/version` is exempt (a constant used by deploy probes); the
//! health and metrics endpoints live on the separate metrics port and never
//! pass through this router.

use {
    super::error,
    axum::{
        body::Body,
        extract::{ConnectInfo, State},
        http::{Request, StatusCode, header},
        middleware::Next,
        response::{IntoResponse, Response},
    },
    configs::orderbook::api::RateLimitConfig,
    std::{
        collections::HashMap,
        net::{IpAddr, SocketAddr},
        sync::{Arc, Mutex},
        time::Instant,
    },
};

/// The header carrying the real client IP when Cloudflare fronts the host.
const CF_CONNECTING_IP: &str = "cf-connecting-ip";

/// Paths never rate limited: `/api/v1/version` is a constant read used by
/// deploy probes. Health and metrics are served from the metrics port and do
/// not pass through this router at all.
const EXEMPT_PATHS: &[&str] = &["/api/v1/version"];

/// Hard cap on tracked client buckets. When an insert would exceed it, all
/// idle (fully refilled) buckets are dropped first; if a flood of distinct
/// client keys keeps the map at the cap even after that sweep, the map is
/// cleared outright. Clearing re-grants at most one `burst` of requests per
/// client, so the failure mode of the defense is bounded extra traffic, not
/// unbounded memory.
const MAX_TRACKED_CLIENTS: usize = 64 * 1024;

/// The bucket key for a request.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ClientKey {
    Ip(IpAddr),
    /// No trusted client identity was available (no trusted header, no peer
    /// address). All such requests share one bucket: fail closed.
    Unknown,
}

#[derive(Clone, Copy, Debug)]
struct Bucket {
    /// Fractional tokens remaining; capacity is `burst`.
    tokens: f64,
    refreshed: Instant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Decision {
    Allow,
    /// Denied; the client should wait this many whole seconds (>= 1) before
    /// a NEW call. Never retry within the same call.
    Deny { retry_after_secs: u64 },
}

pub struct RateLimiter {
    config: RateLimitConfig,
    buckets: Mutex<HashMap<ClientKey, Bucket>>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    fn rate_per_second(&self) -> f64 {
        f64::from(self.config.requests_per_second.get())
    }

    fn capacity(&self) -> f64 {
        f64::from(self.config.burst.get())
    }

    /// Spends one token from `key`'s bucket, refilling for the time elapsed
    /// since the last visit first. `now` is injected so tests are
    /// deterministic.
    fn check(&self, key: ClientKey, now: Instant) -> Decision {
        let rate = self.rate_per_second();
        let capacity = self.capacity();
        let mut buckets =
            poison_recovery::lock_or_recover(&self.buckets, "orderbook::api::rate_limit::buckets");

        if buckets.len() >= MAX_TRACKED_CLIENTS && !buckets.contains_key(&key) {
            buckets
                .retain(|_, bucket| refill(bucket.tokens, bucket.refreshed, now, rate) < capacity);
            if buckets.len() >= MAX_TRACKED_CLIENTS {
                tracing::warn!(
                    tracked = buckets.len(),
                    "rate limiter bucket map hit its cap with no idle buckets to evict; \
                     clearing (bounded burst re-grant, prevents unbounded memory growth)"
                );
                buckets.clear();
            }
        }

        let bucket = buckets.entry(key).or_insert(Bucket {
            tokens: capacity,
            refreshed: now,
        });
        bucket.tokens = refill(bucket.tokens, bucket.refreshed, now, rate).min(capacity);
        bucket.refreshed = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Decision::Allow
        } else {
            let missing = 1.0 - bucket.tokens;
            let retry_after_secs = (missing / rate).ceil().max(1.0) as u64;
            Decision::Deny { retry_after_secs }
        }
    }
}

fn refill(tokens: f64, refreshed: Instant, now: Instant, rate: f64) -> f64 {
    tokens + now.saturating_duration_since(refreshed).as_secs_f64() * rate
}

fn client_key(request: &Request<Body>, trust_cf_connecting_ip: bool) -> ClientKey {
    if trust_cf_connecting_ip
        && let Some(ip) = request
            .headers()
            .get(CF_CONNECTING_IP)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
    {
        return ClientKey::Ip(ip);
    }
    // Fallback: the socket peer address (the Cloudflare edge in production,
    // the actual client on a direct deployment). Requires the ConnectInfo
    // wiring in `run::serve_api`; absent (e.g. in-process test routers) the
    // request falls into the shared Unknown bucket.
    match request.extensions().get::<ConnectInfo<SocketAddr>>() {
        Some(ConnectInfo(peer)) => ClientKey::Ip(peer.ip()),
        None => ClientKey::Unknown,
    }
}

/// Axum middleware enforcing the limiter. Layered innermost (all
/// observability layers wrap it) so 429s are logged, counted in the API
/// metrics, and stamped with the trace id like every other error response.
pub async fn enforce(
    State(limiter): State<Arc<RateLimiter>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !limiter.config.enabled || EXEMPT_PATHS.contains(&request.uri().path()) {
        return next.run(request).await;
    }
    let key = client_key(&request, limiter.config.trust_cf_connecting_ip);
    match limiter.check(key, Instant::now()) {
        Decision::Allow => next.run(request).await,
        Decision::Deny { retry_after_secs } => (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, retry_after_secs.to_string())],
            error(
                "RateLimited",
                "the per-client request budget is exhausted. A 429 is never retryable within \
                 the same call: back off for at least the Retry-After delay, then issue a new \
                 attempt",
            ),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::api::{Error, response_body, trace_id},
        axum::{Router, middleware, routing::get},
        std::{num::NonZeroU32, time::Duration},
        tower::ServiceExt as _,
    };

    fn config(enabled: bool, rps: u32, burst: u32, trust_cf: bool) -> RateLimitConfig {
        RateLimitConfig {
            enabled,
            requests_per_second: NonZeroU32::new(rps).unwrap(),
            burst: NonZeroU32::new(burst).unwrap(),
            trust_cf_connecting_ip: trust_cf,
        }
    }

    fn ip(s: &str) -> ClientKey {
        ClientKey::Ip(s.parse().unwrap())
    }

    #[test]
    fn burst_then_deny_then_refill() {
        let limiter = RateLimiter::new(config(true, 5, 3, true));
        let t0 = Instant::now();
        for _ in 0..3 {
            assert_eq!(limiter.check(ip("203.0.113.7"), t0), Decision::Allow);
        }
        // Bucket empty: denied, and at 5 tokens/s the next token is < 1s away,
        // so Retry-After clamps to the 1-second floor.
        assert_eq!(
            limiter.check(ip("203.0.113.7"), t0),
            Decision::Deny {
                retry_after_secs: 1
            }
        );
        // One second later the bucket has refilled 5 tokens (capped at 3).
        let t1 = t0 + Duration::from_secs(1);
        for _ in 0..3 {
            assert_eq!(limiter.check(ip("203.0.113.7"), t1), Decision::Allow);
        }
        assert!(matches!(
            limiter.check(ip("203.0.113.7"), t1),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn retry_after_reflects_the_refill_rate() {
        // With rps = 1 and burst = 1: draining the burst leaves a full-token
        // deficit, so the wait is ceil(1 / 1) = 1s, and any partial deficit
        // still clamps up to the 1-second floor.
        let limiter = RateLimiter::new(config(true, 1, 1, true));
        let t0 = Instant::now();
        assert_eq!(limiter.check(ip("203.0.113.7"), t0), Decision::Allow);
        assert_eq!(
            limiter.check(ip("203.0.113.7"), t0),
            Decision::Deny {
                retry_after_secs: 1
            }
        );
        // 10 seconds later the bucket is full again (capacity 1).
        let t1 = t0 + Duration::from_secs(10);
        assert_eq!(limiter.check(ip("203.0.113.7"), t1), Decision::Allow);
    }

    #[test]
    fn clients_get_separate_buckets_and_unknown_is_shared() {
        let limiter = RateLimiter::new(config(true, 5, 1, true));
        let t0 = Instant::now();
        assert_eq!(limiter.check(ip("203.0.113.1"), t0), Decision::Allow);
        assert_eq!(limiter.check(ip("203.0.113.2"), t0), Decision::Allow);
        assert!(matches!(
            limiter.check(ip("203.0.113.1"), t0),
            Decision::Deny { .. }
        ));
        assert_eq!(limiter.check(ClientKey::Unknown, t0), Decision::Allow);
        assert!(matches!(
            limiter.check(ClientKey::Unknown, t0),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn idle_buckets_are_evicted_at_the_cap() {
        let limiter = RateLimiter::new(config(true, 5, 1, true));
        let t0 = Instant::now();
        {
            let mut buckets = limiter.buckets.lock().unwrap();
            for i in 0..MAX_TRACKED_CLIENTS {
                let addr = IpAddr::from(u32::try_from(i).unwrap().to_be_bytes());
                // Idle: fully refilled by t0.
                buckets.insert(
                    ClientKey::Ip(addr),
                    Bucket {
                        tokens: 1.0,
                        refreshed: t0,
                    },
                );
            }
        }
        assert_eq!(limiter.check(ip("203.0.113.9"), t0), Decision::Allow);
        // The idle population was swept; only the fresh client remains.
        assert_eq!(limiter.buckets.lock().unwrap().len(), 1);
    }

    fn cf_key(request_headers: &[(&str, &str)], trust: bool) -> ClientKey {
        let mut request = Request::get("/api/v1/auction").body(Body::empty()).unwrap();
        for (name, value) in request_headers {
            request.headers_mut().insert(
                axum::http::HeaderName::try_from(*name).unwrap(),
                axum::http::HeaderValue::from_str(value).unwrap(),
            );
        }
        client_key(&request, trust)
    }

    #[test]
    fn cf_connecting_ip_is_only_used_when_trusted() {
        assert_eq!(
            cf_key(&[("cf-connecting-ip", "203.0.113.7")], true),
            ip("203.0.113.7")
        );
        assert_eq!(
            cf_key(&[("cf-connecting-ip", "2001:db8::1")], true),
            ip("2001:db8::1")
        );
        // Untrusted or garbage headers fall through to Unknown (no
        // ConnectInfo in a bare request).
        assert_eq!(
            cf_key(&[("cf-connecting-ip", "203.0.113.7")], false),
            ClientKey::Unknown
        );
        assert_eq!(
            cf_key(&[("cf-connecting-ip", "not-an-ip")], true),
            ClientKey::Unknown
        );
        assert_eq!(cf_key(&[], true), ClientKey::Unknown);
    }

    fn router(limiter: Arc<RateLimiter>) -> Router {
        // Mirrors the production layering: the limiter innermost, the trace
        // id middleware outside it, so 429 bodies carry a traceId.
        Router::new()
            .route("/api/v1/auction", get(|| async { "ok" }))
            .route("/api/v1/version", get(|| async { "version" }))
            .layer(middleware::from_fn_with_state(limiter, enforce))
            .layer(middleware::from_fn(trace_id::with_trace_id))
    }

    async fn request(router: &Router, path: &str, cf_ip: Option<&str>) -> Response {
        let mut builder = Request::get(path);
        if let Some(ip) = cf_ip {
            builder = builder.header(CF_CONNECTING_IP, ip);
        }
        router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn disabled_limiter_is_inert() {
        let limiter = Arc::new(RateLimiter::new(config(false, 1, 1, true)));
        let router = router(limiter.clone());
        for _ in 0..10 {
            let response = request(&router, "/api/v1/auction", Some("203.0.113.7")).await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        // Inert also means no per-client state was kept.
        assert!(limiter.buckets.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn denied_requests_get_429_code_1029_retry_after_and_trace_id() {
        let router = router(Arc::new(RateLimiter::new(config(true, 5, 2, true))));
        for _ in 0..2 {
            let response = request(&router, "/api/v1/auction", Some("203.0.113.7")).await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        let response = request(&router, "/api/v1/auction", Some("203.0.113.7")).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .expect("429 must carry an integer Retry-After");
        assert!(retry_after >= 1);
        let trace_id = response
            .headers()
            .get(&trace_id::TRACE_ID_HEADER)
            .expect("X-Trace-Id missing on 429")
            .to_str()
            .unwrap()
            .to_string();
        let body: Error = serde_json::from_slice(&response_body(response).await).unwrap();
        assert_eq!(body.error_type, "RateLimited");
        assert_eq!(body.code, Some(1029));
        assert_eq!(body.trace_id.as_deref(), Some(trace_id.as_str()));

        // A different client is not affected by the exhausted bucket.
        let response = request(&router, "/api/v1/auction", Some("203.0.113.8")).await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn version_is_exempt() {
        let router = router(Arc::new(RateLimiter::new(config(true, 1, 1, true))));
        for _ in 0..5 {
            let response = request(&router, "/api/v1/version", Some("203.0.113.7")).await;
            assert_eq!(response.status(), StatusCode::OK);
        }
    }
}
