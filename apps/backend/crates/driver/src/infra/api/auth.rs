//! Inter-service auth middleware for the driver's solver-namespaced routes.
//!
//! F7 (2026-05-21 whole-repo audit, audit-context-building HIGH H2):
//! the driver's `/solve`, `/reveal`, `/settle`, `/quote` endpoints had
//! NO authentication. Mitigation in production today is docker-network
//! isolation (host ports bind 127.0.0.1, only autopilot reaches them
//! on the internal network). But a compromised co-tenant container on
//! the same docker network — or anything new added to the network per
//! Spec 8 — could drive settlements directly.
//!
//! This module provides an OPTIONAL Bearer-token check. When the env
//! var `OPHIS_INTER_SERVICE_AUTH_TOKEN` is set on the driver, the
//! middleware enforces `Authorization: Bearer <token>` on every
//! protected request. When unset, the middleware is never applied —
//! a warning logs at startup to surface the un-hardened posture, and
//! the routes accept all traffic (preserves the pre-F7 behavior for
//! transitional rollout).
//!
//! Token comparison uses `subtle::ConstantTimeEq` to prevent timing-
//! leak attacks. Length-leak is acknowledged but harmless: tokens
//! are a fixed-size operator-generated value (recommended: 32 random
//! bytes = 64 hex chars via `openssl rand -hex 32`).

use {
    axum::{
        extract::{Request, State},
        http::{StatusCode, header::AUTHORIZATION},
        middleware::Next,
        response::{IntoResponse, Response},
    },
    std::sync::Arc,
    subtle::ConstantTimeEq,
};

/// Axum middleware. Apply via:
/// ```text
/// router.layer(axum::middleware::from_fn_with_state(token, require_inter_service_auth))
/// ```
pub async fn require_inter_service_auth(
    State(token): State<Arc<String>>,
    request: Request,
    next: Next,
) -> Response {
    let provided = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    let Some(provided) = provided else {
        tracing::warn!(
            // Log only the path, not the full URI, to avoid leaking query
            // strings on GET routes (Codex Cyber LOW, PR #206 review).
            uri_path = %request.uri().path(),
            "F7 inter-service auth: missing or malformed Authorization header"
        );
        return (
            StatusCode::UNAUTHORIZED,
            "missing inter-service auth",
        )
            .into_response();
    };
    let expected_bytes = token.as_bytes();
    let provided_bytes = provided.as_bytes();
    let valid = expected_bytes.len() == provided_bytes.len()
        && expected_bytes.ct_eq(provided_bytes).unwrap_u8() == 1;
    if !valid {
        tracing::warn!(
            // Log only the path, not the full URI, to avoid leaking query
            // strings on GET routes (Codex Cyber LOW, PR #206 review).
            uri_path = %request.uri().path(),
            "F7 inter-service auth: token mismatch"
        );
        return (
            StatusCode::UNAUTHORIZED,
            "invalid inter-service auth",
        )
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Request, routing::get};
    use tower::ServiceExt; // for `oneshot`

    async fn ok_handler() -> &'static str {
        "ok"
    }

    fn router_with_auth(token: &str) -> Router {
        let token = Arc::new(token.to_owned());
        Router::new()
            .route("/protected", get(ok_handler))
            .layer(axum::middleware::from_fn_with_state(
                token,
                require_inter_service_auth,
            ))
    }

    async fn status_for(req: Request<Body>, token: &str) -> StatusCode {
        let app = router_with_auth(token);
        app.oneshot(req).await.unwrap().status()
    }

    #[tokio::test]
    async fn rejects_missing_header() {
        let req = Request::builder()
            .uri("/protected")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_for(req, "secret-token").await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_non_bearer() {
        // GitHub secret-scanning false-positive 2026-05-21: a previous
        // version of this test used `Basic dXNlcjpwYXNz` (base64 of
        // literal "user:pass") as the non-Bearer fixture. Generic secret
        // scanners flag any base64-looking string in an Authorization
        // header. Switched to an obviously-fake string so future scans
        // don't re-trigger.
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", "Basic NOT-A-REAL-CREDENTIAL-test-fixture")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_for(req, "secret-token").await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_wrong_token() {
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", "Bearer not-the-right-token")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_for(req, "secret-token").await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_token_length_mismatch_without_panic() {
        // ConstantTimeEq panics on length mismatch in some versions.
        // Our wrapper short-circuits the length check first.
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", "Bearer shorter")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_for(req, "secret-token-longer").await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn accepts_valid_bearer() {
        let req = Request::builder()
            .uri("/protected")
            .header("Authorization", "Bearer secret-token")
            .body(Body::empty())
            .unwrap();
        assert_eq!(status_for(req, "secret-token").await, StatusCode::OK);
    }
}
