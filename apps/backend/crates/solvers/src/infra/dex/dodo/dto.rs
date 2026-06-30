//! DTOs for the DODO route-service aggregator API.
//!
//! Reference: <https://docs.dodoex.io/en/developer/contracts/dodo-route-api>
//!
//! A single endpoint is involved per swap:
//! - `GET /route-service/v2/widget/getdodoroute` — returns the best route, the
//!   router (`to`), the calldata (`data`), the optimistic estimate (`resAmount`,
//!   a float) and the GUARANTEED slippage-applied floor (`minReturnAmount`, a
//!   raw-wei decimal string). DODO often exposes a *separate* ERC-20 approval
//!   target (`targetApproveAddr`) distinct from the router.
//!
//! This is a NON-RFQ classic-swap API: the calldata it returns is executable by
//! an arbitrary caller seconds-to-minutes later, provided `userAddr` is set to
//! the Settlement contract (which we do).

use {
    crate::domain::eth,
    alloy::primitives::U256,
    bytes_hex::BytesHex,
    serde::{Deserialize, Serialize},
    serde_with::serde_as,
};

// ---------------------------------------------------------------------------
// GET /route-service/v2/widget/getdodoroute
// ---------------------------------------------------------------------------

/// Query parameters for `GET .../getdodoroute`.
///
/// DODO's route-service only supports the `exactIn` flow, therefore
/// `from_amount` is the sell amount (raw wei).
#[serde_as]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRequest {
    pub chain_id: u64,
    pub from_token_address: eth::Address,
    pub to_token_address: eth::Address,
    /// Sell amount in raw token wei (decimal string).
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub from_amount: U256,
    /// Slippage tolerance expressed as a PERCENT (not bps). DODO's
    /// `minReturnAmount` is derived from this value: a higher percent lowers the
    /// floor. We pass a clamped, percent-formatted value here.
    pub slippage: String,
    /// Wallet that will execute the swap and receive the tokens (the CoW
    /// settlement contract). Baked into the calldata as both spender source and
    /// receiver, which is what makes the calldata executable by an arbitrary
    /// caller (the settlement) later.
    pub user_addr: eth::Address,
    /// Unix timestamp after which the swap is invalid.
    pub dead_line: u64,
    /// Public DODO widget API key. Used only for rate limiting / attribution on
    /// DODO's side; carries no funds-moving authority. Configurable.
    pub apikey: String,
}

/// Top-level response envelope.
///
/// `status` is `200` on success; failures carry a non-200 `status` and/or a
/// `data` that is a plain string error message rather than a [`RouteData`]
/// object. We model `data` as an `Option<RouteData>` and surface a `None` (or a
/// deserialize miss) as [`super::Error::NotFound`].
#[derive(Clone, Debug, Deserialize)]
pub struct RouteApiResponse {
    pub status: i64,
    /// On success: the route payload. On failure DODO sometimes returns a bare
    /// string here, which fails to deserialize into `RouteData` and lands as
    /// `None` via `#[serde(default)]`.
    #[serde(default)]
    pub data: Option<RouteData>,
}

#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteData {
    /// Router contract to call — the `to` of the settlement interaction.
    /// Validated against the static allowlist before use.
    pub to: eth::Address,

    /// Encoded calldata to call on `to`.
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,

    /// Separate ERC-20 approval target (DODO's ApproveProxy). The router pulls
    /// the sell token via this contract, so it is the allowance spender — NOT
    /// `to`. Validated against the static allowlist before use.
    pub target_approve_addr: eth::Address,

    /// GUARANTEED minimum output in raw wei (decimal string). This is the
    /// slippage-applied floor baked into the calldata; the swap reverts on-chain
    /// if the realized output is below it. This is what we report as the CoW buy
    /// clearing amount. NEVER use `res_amount` (an optimistic float estimate).
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub min_return_amount: U256,

    /// Optimistic output ESTIMATE as a float (e.g. `4.47e-7`). Display/sanity
    /// only — never used as the clearing amount.
    #[serde(default)]
    pub res_amount: f64,

    /// Gas limit hint as a decimal string (often `"0"` when DODO declines to
    /// simulate). Parsed best-effort by the caller with a fixed fallback.
    #[serde(default)]
    pub gas_limit: String,

    /// Native value to attach to the call. For ERC-20 -> ERC-20 swaps this is
    /// `"0"`; CoW settles wrapped tokens so we assert it is zero.
    #[serde(default)]
    pub value: String,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Error envelope used when DODO returns a non-2xx HTTP status. DODO's failure
/// body is loosely shaped: a numeric `status` plus an optional human message
/// that may live under `data` (as a bare string) or `msg`/`message`. We capture
/// the status (for rate-limit detection) and a best-effort message.
#[derive(Debug, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub status: i64,
    #[serde(default, alias = "msg", alias = "data")]
    pub message: Option<String>,
}
