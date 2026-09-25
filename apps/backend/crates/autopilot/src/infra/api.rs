use {
    alloy::primitives::Address,
    axum::{
        Router,
        extract::{Path, Query, State as AxumState},
        http::StatusCode,
        response::{IntoResponse, Json, Response},
        routing::get,
    },
    model::quote::NativeTokenPrice,
    observe::tracing::distributed::axum::{make_span, record_trace_id},
    price_estimation::{PriceEstimationError, native::NativePriceEstimating},
    serde::Deserialize,
    std::{
        net::SocketAddr,
        ops::RangeInclusive,
        sync::Arc,
        time::{Duration, Instant},
    },
    tokio::sync::oneshot,
};

/// Minimum allowed timeout for price estimation requests.
/// Values below this are not useful as they don't give estimators enough time.
const MIN_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct State {
    estimator: Arc<dyn NativePriceEstimating>,
    allowed_timeout: RangeInclusive<Duration>,
}

#[derive(Debug, Deserialize)]
struct NativePriceQuery {
    /// Optional timeout in milliseconds for the price estimation request.
    /// If not provided, uses the default timeout configured for autopilot.
    /// Values below 250ms are automatically clamped to the minimum (250ms).
    /// Values exceeding the configured maximum are clamped to the maximum.
    #[serde(default)]
    timeout_ms: Option<u64>,
}

pub async fn serve(
    addr: SocketAddr,
    estimator: Arc<dyn NativePriceEstimating>,
    max_timeout: Duration,
    shutdown: oneshot::Receiver<()>,
) -> Result<(), std::io::Error> {
    let state = State {
        estimator,
        allowed_timeout: MIN_TIMEOUT..=max_timeout,
    };

    let app = Router::new()
        .route("/native_price/{token}", get(get_native_price))
        .with_state(state)
        .layer(
            tower::ServiceBuilder::new()
                .layer(tower_http::trace::TraceLayer::new_for_http().make_span_with(make_span))
                .map_request(record_trace_id),
        );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(?addr, "serving HTTP API");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            shutdown.await.ok();
        })
        .await
}

async fn get_native_price(
    Path(token): Path<Address>,
    Query(query): Query<NativePriceQuery>,
    AxumState(state): AxumState<State>,
) -> Response {
    let timeout = query
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(*state.allowed_timeout.end())
        .clamp(*state.allowed_timeout.start(), *state.allowed_timeout.end());

    let start = Instant::now();
    match state.estimator.estimate_native_price(token, timeout).await {
        Ok(price) => Json(NativeTokenPrice { price }).into_response(),
        Err(err) => {
            let elapsed = start.elapsed();
            tracing::warn!(
                ?err,
                ?token,
                ?timeout,
                ?elapsed,
                "failed to estimate native token price"
            );
            error_to_response(err)
        }
    }
}

fn error_to_response(err: PriceEstimationError) -> Response {
    match err {
        PriceEstimationError::NoLiquidity => {
            (StatusCode::NOT_FOUND, "No liquidity").into_response()
        }
        // The forwarder caches 404 as NoLiquidity. RPC/estimator failures must
        // remain retryable instead of hiding a liquid token for the cache TTL.
        PriceEstimationError::EstimatorInternal(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Price temporarily unavailable",
        )
            .into_response(),
        PriceEstimationError::UnsupportedToken { token: _, reason } => (
            StatusCode::BAD_REQUEST,
            format!("Unsupported token, reason: {reason}"),
        )
            .into_response(),
        PriceEstimationError::RateLimited => {
            (StatusCode::TOO_MANY_REQUESTS, "Rate limited").into_response()
        }
        PriceEstimationError::TradingOutsideAllowedWindow { message }
        | PriceEstimationError::TokenTemporarilySuspended { message }
        | PriceEstimationError::InsufficientLiquidity { message }
        | PriceEstimationError::CustomSolverError { message } => {
            (StatusCode::BAD_REQUEST, message).into_response()
        }
        PriceEstimationError::UnsupportedOrderType(reason) => (
            StatusCode::BAD_REQUEST,
            format!("Unsupported order type, reason: {reason}"),
        )
            .into_response(),
        PriceEstimationError::ProtocolInternal(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transient_failure_is_not_cached_as_missing_liquidity() {
        use {
            futures::FutureExt,
            price_estimation::{
                native::{Forwarder, MockNativePriceEstimating},
                native_price_cache::{Cache, CachingNativePriceEstimator},
            },
        };

        let failure =
            PriceEstimationError::EstimatorInternal(anyhow::anyhow!("private RPC detail"));
        let response = error_to_response(failure.clone());
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"Price temporarily unavailable");
        assert_eq!(
            error_to_response(PriceEstimationError::NoLiquidity).status(),
            StatusCode::NOT_FOUND
        );

        let mut estimator = MockNativePriceEstimating::new();
        let mut sequence = mockall::Sequence::new();
        estimator
            .expect_estimate_native_price()
            .times(1)
            .in_sequence(&mut sequence)
            .returning(move |_, _| futures::future::ready(Err(failure.clone())).boxed());
        estimator
            .expect_estimate_native_price()
            .times(1)
            .in_sequence(&mut sequence)
            .returning(|_, _| futures::future::ready(Ok(2.0)).boxed());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/native_price/{token}", get(get_native_price))
            .with_state(State {
                estimator: Arc::new(estimator),
                allowed_timeout: MIN_TIMEOUT..=Duration::from_secs(2),
            });
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let cache = CachingNativePriceEstimator::new(
            Box::new(Forwarder::new(
                reqwest::Client::builder().no_proxy().build().unwrap(),
                format!("http://{address}/").parse().unwrap(),
            )),
            Cache::new(Duration::from_secs(600), Default::default()),
            1,
            Default::default(),
            Duration::from_secs(2),
        );
        let token = Address::repeat_byte(1);
        assert!(matches!(
            cache
                .estimate_native_price(token, Duration::from_secs(2))
                .await,
            Err(PriceEstimationError::ProtocolInternal(_))
        ));
        assert_eq!(
            cache
                .estimate_native_price(token, Duration::from_secs(2))
                .await
                .unwrap(),
            2.0
        );
        assert_eq!(
            cache
                .estimate_native_price(token, Duration::from_secs(2))
                .await
                .unwrap(),
            2.0
        );
        server.abort();
    }

    async fn assert_bad_request_message(err: PriceEstimationError, expected_message: &str) {
        let response = error_to_response(err);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let body = response.into_body();
        let body = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        assert_eq!(std::str::from_utf8(&body).unwrap(), expected_message);
    }

    #[tokio::test]
    async fn maps_custom_solver_errors_to_bad_request_with_message() {
        assert_bad_request_message(
            PriceEstimationError::TradingOutsideAllowedWindow {
                message: "outside window".to_string(),
            },
            "outside window",
        )
        .await;

        assert_bad_request_message(
            PriceEstimationError::TokenTemporarilySuspended {
                message: "token suspended".to_string(),
            },
            "token suspended",
        )
        .await;

        assert_bad_request_message(
            PriceEstimationError::InsufficientLiquidity {
                message: "insufficient".to_string(),
            },
            "insufficient",
        )
        .await;

        assert_bad_request_message(
            PriceEstimationError::CustomSolverError {
                message: "custom".to_string(),
            },
            "custom",
        )
        .await;
    }
}
