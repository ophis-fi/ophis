use {
    crate::{
        api::{AppState, error},
        orderbook::OrderCancellationError,
    },
    anyhow::anyhow,
    axum::{
        Json,
        body,
        extract::State,
        http::StatusCode,
        response::{IntoResponse, Response},
    },
    model::order::{ORDER_UID_LIMIT, SignedOrderCancellations},
    std::sync::Arc,
};

pub async fn cancel_orders_handler(
    State(state): State<Arc<AppState>>,
    body: body::Bytes,
) -> Response {
    // Phase 2 audit MED M15: pre-this-PR a deserialization failure
    // returned a bare 400 with no body and no log — clients had no hint
    // what was wrong, ops had no signal. Now we log at warn (sanitized:
    // body bytes are user-controlled — never echo them to journald) and
    // return a small structured error body the client can parse.
    let cancellations = match serde_json::from_slice::<SignedOrderCancellations>(&body) {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(
                error = %err,
                body_len = body.len(),
                "cancel_orders: failed to deserialize request body"
            );
            return (
                StatusCode::BAD_REQUEST,
                error(
                    "InvalidRequestBody",
                    "could not deserialize SignedOrderCancellations (expected JSON \
                     with `data.order_uids` and `signature` fields)",
                ),
            )
                .into_response();
        }
    };

    // Explicitly limit the number of orders cancelled in a batch as the request
    // size limit *does not* provide a proper bound for this
    if cancellations.data.order_uids.len() > ORDER_UID_LIMIT {
        return Err::<&'static str, _>(OrderCancellationError::Other(anyhow!(
            "too many orders ({} > 1024)",
            cancellations.data.order_uids.len()
        )))
        .into_response();
    }

    state
        .orderbook
        .cancel_orders(cancellations)
        .await
        .map(|_| Json("Cancelled"))
        .into_response()
}
