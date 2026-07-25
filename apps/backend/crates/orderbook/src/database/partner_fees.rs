//! Orderbook DB access for the partner-fee registry and the accrual feed
//! (partner-fees Phase A).

use {
    alloy::primitives::Address,
    anyhow::{Context, Result},
    database::{byte_array::ByteArray, partner_fee_recipients::PartnerFeeRecipient},
};

/// Failure modes of a self-serve partner registration.
#[derive(Debug)]
pub enum PartnerRegistrationError {
    /// The recipient (or its label) is already registered. Registration is
    /// immutable, so this maps to HTTP 409.
    AlreadyRegistered,
    /// The label failed the DB format check (`[a-z0-9_-]{3,64}`). Maps to 400.
    InvalidLabel,
    /// Any other database error.
    Other(anyhow::Error),
}

impl From<sqlx::Error> for PartnerRegistrationError {
    fn from(err: sqlx::Error) -> Self {
        match err.as_database_error().and_then(|e| e.code()) {
            // unique_violation: recipient PK or label UNIQUE already present.
            Some(code) if code == "23505" => Self::AlreadyRegistered,
            // check_violation: the label format CHECK rejected the value.
            Some(code) if code == "23514" => Self::InvalidLabel,
            _ => Self::Other(err.into()),
        }
    }
}

/// One fee-bearing trade in the accrual feed. Amounts are decimal strings (the
/// on-chain `uint256` values), and `full_app_data` is the raw app-data document
/// so the Phase B pipeline can attribute the fee to its recipient. This is the
/// accrual-ready shape only; no split or payout is computed in Phase A.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerFeeFeedRow {
    pub block_number: i64,
    pub log_index: i64,
    pub order_uid: String,
    pub owner: String,
    pub sell_token: String,
    pub buy_token: String,
    pub sell_amount: String,
    pub buy_amount: String,
    /// The ACTUALLY-APPLIED protocol fee amounts (decimal strings) from
    /// `order_execution`, aligned by `fee_policies.application_order`. The
    /// partner fee is the Volume entry among these; Phase B attributes it using
    /// `full_app_data` + the order's fee policies. This is NOT the trade's
    /// network `fee_amount` (which is unrelated to the partner protocol fee).
    pub protocol_fee_amounts: Vec<String>,
    /// The token of each executed protocol fee, aligned to
    /// `protocol_fee_amounts`.
    pub protocol_fee_tokens: Vec<String>,
    pub full_app_data: Option<String>,
}

impl super::Postgres {
    /// Inserts a new, auto-activated recipient at the default cap and returns
    /// the stored row. Registration is immutable (the recipient is the PK).
    pub async fn insert_partner_fee_recipient(
        &self,
        recipient: &Address,
        label: &str,
    ) -> Result<PartnerFeeRecipient, PartnerRegistrationError> {
        let _timer = super::Metrics::get()
            .database_queries
            .with_label_values(&["insert_partner_fee_recipient"])
            .start_timer();

        let mut ex = self
            .pool
            .acquire()
            .await
            .map_err(|err| PartnerRegistrationError::Other(err.into()))?;
        database::partner_fee_recipients::insert(&mut ex, &ByteArray(recipient.0.0), label)
            .await
            .map_err(PartnerRegistrationError::from)
    }

    /// Fetches a single registered recipient, or `None` if it is not registered.
    pub async fn partner_fee_recipient(
        &self,
        recipient: &Address,
    ) -> Result<Option<PartnerFeeRecipient>> {
        let _timer = super::Metrics::get()
            .database_queries
            .with_label_values(&["partner_fee_recipient"])
            .start_timer();

        let mut ex = self.pool.acquire().await?;
        Ok(database::partner_fee_recipients::fetch(&mut ex, &ByteArray(recipient.0.0)).await?)
    }

    /// Returns the fee-bearing trades from the cursor `(min_block,
    /// min_log_index)` inclusive up to `max_block` inclusive (only orders that
    /// carried a fee policy), oldest first, capped at `limit`. The cursor is
    /// `(block_number, log_index)` so paging resumes WITHIN a block and never
    /// skips trades in a block a page boundary lands inside. Feeds the Phase B
    /// accrual pipeline.
    pub async fn partner_fee_feed(
        &self,
        min_block: i64,
        min_log_index: i64,
        max_block: i64,
        limit: i64,
    ) -> Result<Vec<PartnerFeeFeedRow>> {
        let _timer = super::Metrics::get()
            .database_queries
            .with_label_values(&["partner_fee_feed"])
            .start_timer();

        // trades x orders (tokens + owner) x order_execution (the actually
        // applied protocol fees, aligned by fee_policies.application_order) x
        // app_data (the fee document), restricted to orders that carried a fee
        // policy. The execution is tied to the trade by settlement block so a
        // trade reports its own settlement's fees. Amounts are cast to text so
        // callers never lose precision to a float. The `(block, log_index) >=
        // (min_block, min_log_index)` predicate is the resumable cursor.
        const QUERY: &str = r#"
SELECT
    t.block_number,
    t.log_index,
    t.order_uid,
    o.owner,
    o.sell_token,
    o.buy_token,
    t.sell_amount::text AS sell_amount,
    t.buy_amount::text  AS buy_amount,
    COALESCE(oe.protocol_fee_amounts::text[], '{}'::text[]) AS protocol_fee_amounts,
    COALESCE(oe.protocol_fee_tokens, '{}'::bytea[])         AS protocol_fee_tokens,
    ad.full_app_data
FROM trades t
JOIN orders o ON o.uid = t.order_uid
LEFT JOIN order_execution oe
    ON oe.order_uid = t.order_uid AND oe.block_number = t.block_number
LEFT JOIN app_data ad ON ad.contract_app_data = o.app_data
WHERE t.block_number <= $3
  AND (t.block_number > $1 OR (t.block_number = $1 AND t.log_index >= $2))
  AND EXISTS (SELECT 1 FROM fee_policies fp WHERE fp.order_uid = t.order_uid)
ORDER BY t.block_number ASC, t.log_index ASC
LIMIT $4;
"#;

        let mut ex = self.pool.acquire().await?;
        let rows: Vec<PartnerFeeFeedRawRow> = sqlx::query_as(QUERY)
            .bind(min_block)
            .bind(min_log_index)
            .bind(max_block)
            .bind(limit)
            .fetch_all(&mut *ex)
            .await?;

        rows.into_iter().map(PartnerFeeFeedRow::try_from).collect()
    }
}

/// Raw row as read from Postgres before hex/utf-8 rendering.
#[derive(sqlx::FromRow)]
struct PartnerFeeFeedRawRow {
    block_number: i64,
    log_index: i64,
    order_uid: ByteArray<56>,
    owner: ByteArray<20>,
    sell_token: ByteArray<20>,
    buy_token: ByteArray<20>,
    sell_amount: String,
    buy_amount: String,
    protocol_fee_amounts: Vec<String>,
    protocol_fee_tokens: Vec<ByteArray<20>>,
    full_app_data: Option<Vec<u8>>,
}

impl TryFrom<PartnerFeeFeedRawRow> for PartnerFeeFeedRow {
    type Error = anyhow::Error;

    fn try_from(row: PartnerFeeFeedRawRow) -> Result<Self> {
        let full_app_data = row
            .full_app_data
            .map(|bytes| String::from_utf8(bytes).context("app data is not utf-8"))
            .transpose()?;
        Ok(Self {
            block_number: row.block_number,
            log_index: row.log_index,
            // ByteArray's Display renders 0x-prefixed lowercase hex.
            order_uid: row.order_uid.to_string(),
            owner: row.owner.to_string(),
            sell_token: row.sell_token.to_string(),
            buy_token: row.buy_token.to_string(),
            sell_amount: row.sell_amount,
            buy_amount: row.buy_amount,
            protocol_fee_amounts: row.protocol_fee_amounts,
            protocol_fee_tokens: row
                .protocol_fee_tokens
                .iter()
                .map(ToString::to_string)
                .collect(),
            full_app_data,
        })
    }
}
