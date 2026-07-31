//! Look up a registered partner-fee recipient (partner-fees Phase A).

use {
    crate::api::{AppState, error, post_partner::PartnerResponse},
    alloy::primitives::Address,
    axum::{
        extract::{Path, State},
        http::StatusCode,
        response::{IntoResponse, Json, Response},
    },
    std::sync::Arc,
};

pub async fn get_partner_handler(
    State(state): State<Arc<AppState>>,
    Path(address): Path<Address>,
) -> Response {
    match state.database_read.partner_fee_recipient(&address).await {
        Ok(Some(row)) => Json(PartnerResponse::from(row)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            error("PartnerNotFound", "no partner registered for this address"),
        )
            .into_response(),
        Err(err) => {
            tracing::error!(?err, ?address, "failed to fetch partner-fee recipient");
            crate::api::internal_error_reply()
        }
    }
}
