//! Self-serve partner-fee recipient registry (partner-fees Phase A).
//!
//! Source of record for THIRD-PARTY partner-fee recipients. The Ophis
//! partner-fee Safe is always allowed in code and is not stored here. Rows are
//! auto-activated on insert at the 50 bps default cap (owner decision 16) and
//! are immutable on re-registration (the recipient is the primary key).

use {
    crate::Address,
    chrono::{DateTime, Utc},
    sqlx::PgConnection,
    tracing::instrument,
};

/// Lifecycle of a registered partner-fee recipient. `active` recipients are
/// enforced at ingress and paid by the Phase B accrual pipeline; `suspended` is
/// the instant kill switch that drops a recipient from the active snapshot
/// without deleting its history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]
#[sqlx(type_name = "PartnerFeeStatus", rename_all = "lowercase")]
pub enum PartnerFeeStatus {
    Active,
    Suspended,
}

/// A registered partner-fee recipient row.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct PartnerFeeRecipient {
    pub recipient: Address,
    pub label: String,
    /// Per-partner Volume-policy bps cap (1..=90, default 50).
    pub max_volume_bps: i32,
    pub status: PartnerFeeStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Inserts a new recipient, auto-activated at the DB default cap, and returns
/// the stored row. Fails with a unique-violation `sqlx::Error` if the recipient
/// or label already exists (registration is immutable), and with a
/// check-violation if the label does not match `[a-z0-9_-]{3,64}`.
#[instrument(skip_all)]
pub async fn insert(
    ex: &mut PgConnection,
    recipient: &Address,
    label: &str,
) -> Result<PartnerFeeRecipient, sqlx::Error> {
    const QUERY: &str = r#"
INSERT INTO partner_fee_recipients (recipient, label)
VALUES ($1, $2)
RETURNING recipient, label, max_volume_bps, status, created_at, updated_at;
"#;
    sqlx::query_as(QUERY)
        .bind(recipient)
        .bind(label)
        .fetch_one(ex)
        .await
}

/// Fetches a single recipient by address, or `None` if it is not registered.
#[instrument(skip_all)]
pub async fn fetch(
    ex: &mut PgConnection,
    recipient: &Address,
) -> Result<Option<PartnerFeeRecipient>, sqlx::Error> {
    const QUERY: &str = r#"
SELECT recipient, label, max_volume_bps, status, created_at, updated_at
FROM partner_fee_recipients
WHERE recipient = $1;
"#;
    sqlx::query_as(QUERY)
        .bind(recipient)
        .fetch_optional(ex)
        .await
}

/// Loads the active-recipient snapshot for the in-memory registry: the address
/// and the effective per-partner cap (already clamped to the 90 bps program cap
/// at the SQL layer, so a manually-raised `max_volume_bps` can never exceed the
/// program cap even before the registry re-clamps it). Suspended recipients are
/// excluded, so a suspension drops them from ingress enforcement on the next
/// refresh.
#[instrument(skip_all)]
pub async fn active_recipients(
    ex: &mut PgConnection,
) -> Result<Vec<(Address, i32)>, sqlx::Error> {
    const QUERY: &str = r#"
SELECT recipient, LEAST(max_volume_bps, 90) AS max_volume_bps
FROM partner_fee_recipients
WHERE status = 'active';
"#;
    let rows: Vec<(Address, i32)> = sqlx::query_as(QUERY).fetch_all(ex).await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use {super::*, crate::byte_array::ByteArray, sqlx::Connection};

    #[tokio::test]
    #[ignore]
    async fn postgres_partner_fee_recipient_roundtrip() {
        let mut db = PgConnection::connect("postgresql://").await.unwrap();
        let mut db = db.begin().await.unwrap();
        crate::clear_DANGER_(&mut db).await.unwrap();

        let recipient = ByteArray([0x11; 20]);

        // Not present initially.
        assert!(fetch(&mut db, &recipient).await.unwrap().is_none());

        // Insert auto-activates at the 50 bps default cap.
        let inserted = insert(&mut db, &recipient, "test_partner-1").await.unwrap();
        assert_eq!(inserted.recipient, recipient);
        assert_eq!(inserted.label, "test_partner-1");
        assert_eq!(inserted.max_volume_bps, 50);
        assert_eq!(inserted.status, PartnerFeeStatus::Active);

        // Fetch returns the stored row.
        let fetched = fetch(&mut db, &recipient).await.unwrap().unwrap();
        assert_eq!(fetched, inserted);

        // Active snapshot includes it, capped at 90.
        let active = active_recipients(&mut db).await.unwrap();
        assert_eq!(active, vec![(recipient, 50)]);

        // Re-registration is immutable: a second insert of the same recipient
        // is a unique violation.
        let err = insert(&mut db, &recipient, "another-label").await.unwrap_err();
        assert!(
            err.as_database_error()
                .and_then(|e| e.code())
                .is_some_and(|c| c == "23505"),
            "expected a unique violation, got: {err:?}"
        );

        // A label that violates the format check is rejected by the DB.
        let other = ByteArray([0x22; 20]);
        let err = insert(&mut db, &other, "BAD LABEL").await.unwrap_err();
        assert!(
            err.as_database_error()
                .and_then(|e| e.code())
                .is_some_and(|c| c == "23514"),
            "expected a check violation, got: {err:?}"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn postgres_suspended_recipient_excluded_from_snapshot() {
        let mut db = PgConnection::connect("postgresql://").await.unwrap();
        let mut db = db.begin().await.unwrap();
        crate::clear_DANGER_(&mut db).await.unwrap();

        let recipient = ByteArray([0x33; 20]);
        insert(&mut db, &recipient, "suspendable").await.unwrap();
        sqlx::query("UPDATE partner_fee_recipients SET status = 'suspended' WHERE recipient = $1")
            .bind(recipient)
            .execute(&mut *db)
            .await
            .unwrap();

        // Still fetchable (history preserved) but excluded from the active
        // ingress snapshot.
        assert!(fetch(&mut db, &recipient).await.unwrap().is_some());
        assert!(active_recipients(&mut db).await.unwrap().is_empty());
    }
}
