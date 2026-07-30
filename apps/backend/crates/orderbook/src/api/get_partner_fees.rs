//! WAF-gated partner-fee accrual feed (partner-fees Phase A).
//!
//! Returns the fee-bearing trades in a block window with the full app-data, so
//! the Phase B payout pipeline can attribute each fee to its recipient and
//! accrue the 80/20 split. This endpoint only exposes the accrual-ready data
//! shapes; no split, USD pricing, or payout is computed here. Lives under
//! `/restricted/` so infra/WAF rules gate access to authenticated consumers.

use {
    crate::{api::AppState, database::partner_fees::PartnerFeeFeedRow},
    axum::{
        extract::{Query, State},
        response::{IntoResponse, Json, Response},
    },
    serde::{Deserialize, Serialize},
    std::sync::Arc,
};

/// Default and maximum page sizes. The cap bounds a single query's cost.
const DEFAULT_LIMIT: i64 = 1_000;
const MAX_LIMIT: i64 = 10_000;

// Field names are snake_case (NOT renamed) to match the documented query
// parameters `min_block` / `min_log_index` / `max_block` / `limit`, so a
// spec-following consumer's params are honored rather than silently ignored.
#[derive(Debug, Deserialize)]
pub struct FeedQuery {
    #[serde(default)]
    min_block: i64,
    /// Cursor within `min_block`: only trades at `log_index >= min_log_index` in
    /// that block are returned (higher blocks are unaffected). Default 0.
    #[serde(default)]
    min_log_index: i64,
    max_block: Option<i64>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedResponse {
    trades: Vec<PartnerFeeFeedRow>,
    /// Cursor block to resume from (set `min_block` to this value). Present only
    /// when the page was full; absent means the window is drained.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_block: Option<i64>,
    /// Cursor log index to resume from within `next_block` (set `min_log_index`
    /// to this value). Together `(next_block, next_log_index)` resumes strictly
    /// after the last returned row, so no trade in a partially-returned block is
    /// ever skipped.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_log_index: Option<i64>,
}

pub async fn get_partner_fees_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FeedQuery>,
) -> Response {
    let max_block = query.max_block.unwrap_or(i64::MAX);
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    match state
        .database_read
        .partner_fee_feed(query.min_block, query.min_log_index, max_block, limit)
        .await
    {
        Ok(trades) => {
            // A full page means more rows may exist; resume at the position just
            // AFTER the last returned row, `(last.block, last.log_index + 1)`, so
            // the remaining trades of a partially-returned block are picked up on
            // the next call rather than skipped. A short page means the window is
            // drained.
            let full_page = i64::try_from(trades.len()).is_ok_and(|len| len == limit);
            let cursor = full_page
                .then(|| trades.last())
                .flatten()
                .map(|row| (row.block_number, row.log_index.saturating_add(1)));
            let (next_block, next_log_index) = match cursor {
                Some((block, log_index)) => (Some(block), Some(log_index)),
                None => (None, None),
            };
            Json(FeedResponse {
                trades,
                next_block,
                next_log_index,
            })
            .into_response()
        }
        Err(err) => {
            tracing::error!(?err, "failed to load partner-fee accrual feed");
            crate::api::internal_error_reply()
        }
    }
}
