//! Module containing all the necessary pieces to trace logs across
//! multiple services by passing open telemetry information via HTTP headers.

pub mod axum;
pub mod headers;
pub mod request_id;
pub mod trace_id_format;

use {
    opentelemetry::trace::{TraceContextExt, TraceId},
    tracing::Span,
    tracing_opentelemetry::OpenTelemetrySpanExt,
};

/// Returns the 16 raw bytes of the OTel trace id carried by the current
/// tracing span, or `None` when no valid (non-zero) OTel trace context is
/// active. Lets services derive request-scoped identifiers that correlate
/// with distributed traces without depending on OTel crates themselves.
pub fn current_trace_id_bytes() -> Option<[u8; 16]> {
    let trace_id = Span::current().context().span().span_context().trace_id();
    (trace_id != TraceId::INVALID).then(|| trace_id.to_bytes())
}
