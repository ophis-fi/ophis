//! Per-request trace ids (api-dx).
//!
//! Every orderbook response carries an `X-Trace-Id` header with a UUID
//! identifying the request. The id is derived from the OTel trace id of the
//! request span when a valid one is active (so the header correlates
//! directly with distributed traces) and falls back to a random v4 UUID
//! otherwise. Success responses carry the id header-only; error bodies
//! additionally repeat it as a `traceId` field, stamped centrally in
//! [`crate::api::error`] / [`crate::api::rich_error`] through the task-local
//! scoped here, so no individual handler has to thread it through. The same
//! id is logged as `x_trace_id` on the `request_summary` event, so an operator
//! can find a request from the id a client quotes even when no OTel tracing
//! layer is active and the span's `trace_id` field is all zeros.

use {
    axum::{
        body::Body,
        http::{HeaderName, HeaderValue, Request},
        middleware::Next,
        response::Response,
    },
    uuid::Uuid,
};

/// The response header mirroring the request's trace id.
pub const TRACE_ID_HEADER: HeaderName = HeaderName::from_static("x-trace-id");

tokio::task_local! {
    static TRACE_ID: String;
}

/// The trace id of the request currently being handled, or `None` outside a
/// request scope (e.g. background tasks, unit tests calling response
/// builders directly).
pub fn current() -> Option<String> {
    TRACE_ID.try_with(|id| id.clone()).ok()
}

fn request_trace_id() -> String {
    observe::tracing::distributed::current_trace_id_bytes()
        .map(Uuid::from_bytes)
        .unwrap_or_else(Uuid::new_v4)
        .to_string()
}

/// Middleware scoping a task-local trace id around each request and
/// mirroring it on the response as `X-Trace-Id`. Layered inside
/// `TraceLayer` (so the OTel request span is already active when the id is
/// derived) and outside all handlers.
pub async fn with_trace_id(request: Request<Body>, next: Next) -> Response {
    let trace_id = request_trace_id();
    let mut response = TRACE_ID.scope(trace_id.clone(), next.run(request)).await;
    match HeaderValue::from_str(&trace_id) {
        Ok(value) => {
            response.headers_mut().insert(TRACE_ID_HEADER, value);
        }
        // Unreachable for UUID strings; do not fail the response over the
        // observability header.
        Err(err) => tracing::error!(?err, %trace_id, "trace id is not a valid header value"),
    }
    response
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::api::{error, response_body},
        axum::{
            Router,
            http::StatusCode,
            middleware,
            response::IntoResponse,
            routing::get,
        },
        tower::ServiceExt as _,
    };

    fn router() -> Router {
        Router::new()
            .route("/ok", get(|| async { "ok" }))
            .route(
                "/err",
                get(|| async {
                    (StatusCode::BAD_REQUEST, error("BadRequest", "boom")).into_response()
                }),
            )
            .layer(middleware::from_fn(with_trace_id))
    }

    async fn request(path: &str) -> Response {
        router()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    fn header_trace_id(response: &Response) -> String {
        let value = response
            .headers()
            .get(&TRACE_ID_HEADER)
            .expect("X-Trace-Id header missing")
            .to_str()
            .unwrap()
            .to_string();
        Uuid::parse_str(&value).expect("X-Trace-Id is not a UUID");
        value
    }

    #[tokio::test]
    async fn success_responses_carry_the_header_only() {
        let response = request("/ok").await;
        assert_eq!(response.status(), StatusCode::OK);
        header_trace_id(&response);
        // The success body is untouched: no traceId is injected anywhere.
        assert_eq!(response_body(response).await, b"ok");
    }

    #[tokio::test]
    async fn error_bodies_repeat_the_header_trace_id() {
        let response = request("/err").await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let trace_id = header_trace_id(&response);
        let body: crate::api::Error =
            serde_json::from_slice(&response_body(response).await).unwrap();
        assert_eq!(body.trace_id.as_deref(), Some(trace_id.as_str()));
        assert_eq!(body.code, Some(1000));
    }

    #[tokio::test]
    async fn each_request_gets_a_fresh_trace_id() {
        let first = header_trace_id(&request("/ok").await);
        let second = header_trace_id(&request("/ok").await);
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn no_trace_id_outside_a_request_scope() {
        assert_eq!(current(), None);
    }
}
