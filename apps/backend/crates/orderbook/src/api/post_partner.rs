//! Self-serve partner-fee recipient registration (partner-fees Phase A).
//!
//! Auto-activates a registration at the default per-partner cap (owner decision
//! 16) after verifying that the caller controls the recipient key: the request
//! carries an EIP-191 `personal_sign` over a fixed message that names the
//! recipient and an issue timestamp, and the recovered signer must equal the
//! recipient. A 300 s replay window bounds signature reuse; registration is
//! immutable (a second registration of the same recipient is a 409).
//!
//! SHIPS DISABLED: when `partner_fee_registration_enabled` is false (the default
//! and every checked-in config) the endpoint returns 403 and nothing is written,
//! so the registry stays empty and only the always-allowed Ophis Safe passes
//! partner-fee validation.

use {
    crate::{
        api::{AppState, error},
        database::partner_fees::PartnerRegistrationError,
    },
    alloy::primitives::{Address, Signature},
    axum::{
        Json,
        extract::State,
        http::StatusCode,
        response::{IntoResponse, Response},
    },
    database::partner_fee_recipients::{PartnerFeeRecipient, PartnerFeeStatus},
    serde::{Deserialize, Serialize},
    std::{
        sync::Arc,
        time::{SystemTime, UNIX_EPOCH},
    },
};

/// Signature freshness window in seconds (both directions, to tolerate clock
/// skew between the signer and this server).
const REPLAY_WINDOW_SECS: i64 = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPartnerRequest {
    /// The fee-recipient address; must equal the signature's recovered signer.
    recipient: Address,
    /// Human-readable label, `[a-z0-9_-]{3,64}`.
    label: String,
    /// Unix seconds the registration message was issued at (replay window).
    issued_at: i64,
    /// EIP-191 `personal_sign` signature over the registration message, as a
    /// 0x-prefixed 65-byte hex string (r || s || v).
    signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerResponse {
    recipient: Address,
    label: String,
    status: &'static str,
    max_volume_bps: i32,
}

impl From<PartnerFeeRecipient> for PartnerResponse {
    fn from(row: PartnerFeeRecipient) -> Self {
        Self {
            recipient: Address::from(row.recipient.0),
            label: row.label,
            status: status_str(row.status),
            max_volume_bps: row.max_volume_bps,
        }
    }
}

fn status_str(status: PartnerFeeStatus) -> &'static str {
    match status {
        PartnerFeeStatus::Active => "active",
        PartnerFeeStatus::Suspended => "suspended",
    }
}

/// The exact message the recipient key must `personal_sign`. Binds the
/// `recipient`, the `label`, and the issue timestamp, so a relayer or separate
/// submitter cannot substitute a different label (recipient and label are both
/// immutable and unique, so a wrong-label registration would be permanent).
/// Kept deterministic (lowercase 0x address, decimal timestamp) so any wallet
/// reproduces it.
fn registration_message(recipient: &Address, label: &str, issued_at: i64) -> String {
    format!(
        "Ophis Partner Fee registration\nRecipient: {recipient:#x}\nLabel: {label}\nIssued: \
         {issued_at}"
    )
}

/// Whether `label` matches `[a-z0-9_-]{3,64}` (mirrors the DB CHECK; validated
/// here first so a bad label is a clean 400 rather than a DB round trip).
fn label_is_valid(label: &str) -> bool {
    (3..=64).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

pub async fn post_partner_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RegisterPartnerRequest>,
) -> Response {
    // Flag-off posture: the endpoint is inert until the owner flips it on.
    if !state.partner_fee_registration_enabled {
        return (
            StatusCode::FORBIDDEN,
            error(
                "PartnerRegistrationDisabled",
                "self-serve partner-fee registration is not enabled",
            ),
        )
            .into_response();
    }

    if !label_is_valid(&request.label) {
        return (
            StatusCode::BAD_REQUEST,
            error(
                "InvalidPartnerLabel",
                "label must match [a-z0-9_-]{3,64}",
            ),
        )
            .into_response();
    }

    // Replay window: reject stale or far-future timestamps. Saturating
    // arithmetic so a crafted extreme `issuedAt` (e.g. i64::MIN) cannot overflow
    // the subtraction or `.abs()` and slip past the window.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or_default();
    if now.saturating_sub(request.issued_at).saturating_abs() > REPLAY_WINDOW_SECS {
        return (
            StatusCode::BAD_REQUEST,
            error(
                "PartnerRegistrationExpired",
                format!(
                    "issuedAt must be within {REPLAY_WINDOW_SECS}s of the server clock"
                ),
            ),
        )
            .into_response();
    }

    // Verify the caller controls the recipient key, and that they signed for
    // THIS label (binds the immutable label to the signature).
    let message =
        registration_message(&request.recipient, &request.label, request.issued_at);
    let signature = match request.signature.parse::<Signature>() {
        Ok(signature) => signature,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                error(
                    "InvalidPartnerSignature",
                    "signature must be a 0x-prefixed 65-byte hex string",
                ),
            )
                .into_response();
        }
    };
    let recovered = match signature.recover_address_from_msg(message.as_bytes()) {
        Ok(recovered) => recovered,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                error("InvalidPartnerSignature", "could not recover signer"),
            )
                .into_response();
        }
    };
    if recovered != request.recipient {
        return (
            StatusCode::BAD_REQUEST,
            error(
                "InvalidPartnerSignature",
                "recovered signer does not match the recipient",
            ),
        )
            .into_response();
    }

    // Phase B sanctions screening hook: a payout-time list screen lands with the
    // Phase B payout pipeline (owner decision 21). Registration stays open here
    // by design; the Safe never pays an address that fails the screen.

    match state
        .database_write
        .insert_partner_fee_recipient(&request.recipient, &request.label)
        .await
    {
        Ok(row) => (StatusCode::CREATED, Json(PartnerResponse::from(row))).into_response(),
        Err(PartnerRegistrationError::AlreadyRegistered) => (
            StatusCode::CONFLICT,
            error(
                "PartnerAlreadyRegistered",
                "this recipient or label is already registered (registration is immutable)",
            ),
        )
            .into_response(),
        Err(PartnerRegistrationError::InvalidLabel) => (
            StatusCode::BAD_REQUEST,
            error("InvalidPartnerLabel", "label must match [a-z0-9_-]{3,64}"),
        )
            .into_response(),
        Err(PartnerRegistrationError::Other(err)) => {
            tracing::error!(?err, "failed to register partner-fee recipient");
            crate::api::internal_error_reply()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_validation_matches_the_db_check() {
        assert!(label_is_valid("abc"));
        assert!(label_is_valid("my-partner_1"));
        assert!(label_is_valid(&"a".repeat(64)));
        assert!(!label_is_valid("ab")); // too short
        assert!(!label_is_valid(&"a".repeat(65))); // too long
        assert!(!label_is_valid("Bad")); // uppercase
        assert!(!label_is_valid("has space"));
        assert!(!label_is_valid("dots.not.allowed"));
    }

    #[test]
    fn registration_message_is_deterministic_and_binds_recipient_label_and_time() {
        let recipient = "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
            .parse::<Address>()
            .unwrap();
        let message = registration_message(&recipient, "my-partner_1", 1_700_000_000);
        assert_eq!(
            message,
            "Ophis Partner Fee registration\n\
             Recipient: 0x858f0f5ee954846d47155f5203c04af1819ecef8\n\
             Label: my-partner_1\n\
             Issued: 1700000000"
        );
    }

    #[test]
    fn message_binds_the_label_so_a_substituted_label_recovers_a_different_signer() {
        // Signing for one label then submitting a different label must NOT verify:
        // the recovered signer differs from the recipient because the message the
        // signer signed included the original label.
        use {alloy_signer::SignerSync, alloy_signer_local::PrivateKeySigner};

        let signer = PrivateKeySigner::random();
        let recipient = signer.address();
        let issued_at = 1_700_000_000i64;

        let signed = registration_message(&recipient, "intended-label", issued_at);
        let signature = signer.sign_message_sync(signed.as_bytes()).unwrap();

        // A submitter swaps the label; the server rebuilds the message with the
        // submitted label and recovers a DIFFERENT address.
        let tampered = registration_message(&recipient, "substituted-label", issued_at);
        let recovered = signature
            .recover_address_from_msg(tampered.as_bytes())
            .unwrap();
        assert_ne!(
            recovered, recipient,
            "a substituted label must not recover the recipient"
        );
    }

    #[test]
    fn recovers_the_signer_from_a_personal_sign_signature() {
        use {alloy_signer::SignerSync, alloy_signer_local::PrivateKeySigner};

        let signer = PrivateKeySigner::random();
        let recipient = signer.address();
        let issued_at = 1_700_000_000i64;
        let message = registration_message(&recipient, "my-partner_1", issued_at);

        let signature = signer.sign_message_sync(message.as_bytes()).unwrap();
        let recovered = signature
            .recover_address_from_msg(message.as_bytes())
            .unwrap();
        assert_eq!(recovered, recipient);
    }
}
