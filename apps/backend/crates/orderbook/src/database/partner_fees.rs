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
    /// Policy kind for each executed fee slot, aligned to amounts/tokens. This
    /// lets consumers distinguish config-derived price-improvement fees from
    /// appData-derived partner Volume fees without positional guessing.
    pub protocol_fee_kinds: Vec<String>,
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
        // policy. Amounts are cast to text so callers never lose precision to a
        // float. The `(block, log_index) >= (min_block, min_log_index)` predicate
        // is the resumable cursor.
        //
        // The execution row is tied to the trade's SETTLING AUCTION, not merely
        // its block: `order_execution`'s primary key is (order_uid, auction_id),
        // and a partially-fillable order can settle in TWO auctions in the SAME
        // block, so joining on block_number alone is non-unique and multiplies
        // rows / mis-attributes fees. Instead the LATERAL picks the one
        // settlement whose Settlement event is the first at a higher log_index
        // than the trade (the settlement that emitted this trade; this is the
        // canonical trade -> auction linkage, mirroring `database::trades`), then
        // the join on the (order_uid, auction_id) PRIMARY KEY yields at most one
        // execution row. The result is therefore exactly one row per trade (with
        // empty fee arrays when no settlement/execution is found), so the
        // (block, log_index) cursor can never drop a duplicated trade key.
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
    COALESCE(ARRAY(
        SELECT fp.kind::text
        FROM fee_policies fp
        WHERE fp.order_uid = t.order_uid
          AND fp.auction_id = settlement.auction_id
        ORDER BY fp.application_order ASC
    ), '{}'::text[]) AS protocol_fee_kinds,
    ad.full_app_data
FROM trades t
JOIN orders o ON o.uid = t.order_uid
LEFT OUTER JOIN LATERAL (
    SELECT s.auction_id
    FROM settlements s
    WHERE s.block_number = t.block_number
      AND s.log_index > t.log_index
    ORDER BY s.log_index ASC
    LIMIT 1
) settlement ON true
LEFT JOIN order_execution oe
    ON oe.order_uid = t.order_uid AND oe.auction_id = settlement.auction_id
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
    protocol_fee_kinds: Vec<String>,
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
            protocol_fee_kinds: row.protocol_fee_kinds,
            full_app_data,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::database::{Config, Postgres};

    /// A partially-fillable order that settles in TWO auctions in the SAME block
    /// must yield exactly ONE fee-attributed row per trade (each trade attributed
    /// to its own settling auction's executed protocol fee), with no row
    /// multiplication and no row dropped across a LIMIT boundary placed inside
    /// the block. This is the regression test for the non-unique
    /// (order_uid, block_number) join.
    #[tokio::test]
    #[ignore]
    async fn postgres_same_block_two_auctions_is_one_row_per_trade() {
        let db = Postgres::try_new("postgresql://", Config::default()).unwrap();
        database::clear_DANGER(&db.pool).await.unwrap();

        // Fixture identifiers.
        let uid = "\\x0101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101";
        let app_hash = "\\xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let fee_token = "\\x3333333333333333333333333333333333333333";

        // One partially-fillable order carrying a fee policy, plus its app-data.
        sqlx::query(&format!(
            "INSERT INTO orders (uid, owner, creation_timestamp, sell_token, buy_token, \
             sell_amount, buy_amount, valid_to, fee_amount, kind, partially_fillable, signature, \
             app_data, signing_scheme, settlement_contract, sell_token_balance, buy_token_balance, \
             class, true_valid_to) VALUES ('{uid}', \
             '\\x1111111111111111111111111111111111111111', now(), \
             '\\x2222222222222222222222222222222222222222', '{fee_token}', 1000000, 999000, \
             2000000000, 5, 'sell', true, '\\x00', '{app_hash}', 'eip712', \
             '\\x4444444444444444444444444444444444444444', 'erc20', 'erc20', 'market', 2000000000);"
        ))
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(&format!(
            "INSERT INTO app_data (contract_app_data, full_app_data) VALUES ('{app_hash}', \
             '{{\"metadata\":{{\"partnerFee\":{{\"volumeBps\":50}}}}}}');"
        ))
        .execute(&db.pool)
        .await
        .unwrap();

        // Two settlements in block 100 (auctions 1 and 2), at log_index 5 and 11.
        sqlx::query(
            "INSERT INTO settlements (block_number, log_index, solver, tx_hash, auction_id) \
             VALUES (100, 5, '\\x5555555555555555555555555555555555555555', '\\xaa', 1), \
             (100, 11, '\\x5555555555555555555555555555555555555555', '\\xbb', 2);",
        )
        .execute(&db.pool)
        .await
        .unwrap();

        // Two trades for the order in block 100: log_index 4 (emitted by the
        // settlement at log 5 -> auction 1) and log_index 10 (emitted by the
        // settlement at log 11 -> auction 2).
        sqlx::query(&format!(
            "INSERT INTO trades (block_number, log_index, order_uid, sell_amount, buy_amount, \
             fee_amount) VALUES (100, 4, '{uid}', 500000, 499500, 7), (100, 10, '{uid}', 500000, \
             499500, 7);"
        ))
        .execute(&db.pool)
        .await
        .unwrap();

        // One execution row per auction, with distinct executed protocol fees.
        sqlx::query(&format!(
            "INSERT INTO order_execution (order_uid, auction_id, reward, block_number, \
             executed_fee_token, protocol_fee_tokens, protocol_fee_amounts) VALUES \
             ('{uid}', 1, 0, 100, '{fee_token}', ARRAY['{fee_token}'::bytea], \
             ARRAY[100]::numeric(78,0)[]), \
             ('{uid}', 2, 0, 100, '{fee_token}', ARRAY['{fee_token}'::bytea], \
             ARRAY[200]::numeric(78,0)[]);"
        ))
        .execute(&db.pool)
        .await
        .unwrap();
        // Fee policies exist for both auctions (the EXISTS gate).
        sqlx::query(&format!(
            "INSERT INTO fee_policies (auction_id, order_uid, kind, volume_factor) VALUES \
             (1, '{uid}', 'volume', 0.005), (2, '{uid}', 'volume', 0.005);"
        ))
        .execute(&db.pool)
        .await
        .unwrap();

        // Full scan: exactly two rows (one per trade), each attributed to its own
        // auction's executed protocol fee. The old block-only join returned four.
        let rows = db.partner_fee_feed(0, 0, i64::MAX, 1000).await.unwrap();
        assert_eq!(rows.len(), 2, "expected exactly one row per trade, got {rows:?}");
        assert_eq!(rows[0].log_index, 4);
        assert_eq!(rows[0].protocol_fee_amounts, vec!["100".to_string()]);
        assert_eq!(rows[1].log_index, 10);
        assert_eq!(rows[1].protocol_fee_amounts, vec!["200".to_string()]);

        // LIMIT boundary inside block 100: page 1 (limit 1) returns log_index 4;
        // resuming at (block 100, log_index 5) returns log_index 10, so no trade
        // in the block is dropped.
        let page1 = db.partner_fee_feed(100, 0, i64::MAX, 1).await.unwrap();
        assert_eq!(page1.len(), 1);
        assert_eq!(page1[0].log_index, 4);
        let page2 = db
            .partner_fee_feed(100, page1[0].log_index + 1, i64::MAX, 1)
            .await
            .unwrap();
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].log_index, 10);
    }
}
