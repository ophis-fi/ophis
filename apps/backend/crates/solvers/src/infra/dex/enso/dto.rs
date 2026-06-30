//! DTOs for the Enso Shortcuts/Route aggregator API.
//!
//! Full documentation: <https://docs.enso.build>.
//!
//! A single endpoint is used per swap:
//! - `GET /api/v1/shortcuts/route` — returns the best route as a single
//!   executable transaction (`tx.{to,data,value}`) together with the optimistic
//!   `amountOut` and the GUARANTEED `minAmountOut` (the on-chain slippage
//!   floor baked into the calldata).
//!
//! All amounts are returned in wei as decimal strings (parsed as `U256` via
//! `DisplayFromStr`). With `routingStrategy=router`, `tx.to` is the EnsoRouter
//! that the caller approves and that pulls `tokenIn` via `transferFrom` — so it
//! is BOTH the call target AND the ERC-20 spender.

use {
    crate::domain::eth,
    alloy::primitives::U256,
    bytes_hex::BytesHex,
    serde::Deserialize,
    serde_with::serde_as,
};

// ---------------------------------------------------------------------------
// GET /api/v1/shortcuts/route
// ---------------------------------------------------------------------------

/// Successful response envelope for `GET /shortcuts/route`. Extra fields
/// (`route`, `priceImpact`, `createdAt`, `feeAmount`, …) are tolerated.
#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResponse {
    /// The single executable transaction for the route.
    pub tx: Tx,

    /// Optimistic quoted output (wei). NOT reported as the clearing amount —
    /// see `min_amount_out`.
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_out: U256,

    /// GUARANTEED minimum output (wei) the EnsoRouter enforces on-chain. This is
    /// `amountOut * (1 - slippage)` baked into the calldata; the route reverts
    /// if the realized output is below it. Reported as the CoW buy clearing
    /// amount so the settlement's buy payout can never exceed what the router
    /// actually delivers.
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub min_amount_out: U256,

    /// Gas estimate. Enso returns this as a JSON number or decimal string
    /// depending on version; captured untyped and parsed leniently by the
    /// caller (a wrong hint only affects ranking — the driver re-simulates).
    #[serde(default)]
    pub gas: serde_json::Value,
}

/// The executable transaction returned by `/shortcuts/route`.
#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tx {
    /// The EnsoRouter to call — ALSO the ERC-20 spender the Settlement
    /// contract must approve. Validated against the static allowlist by the
    /// caller — NEVER trusted blindly.
    pub to: eth::Address,

    /// Encoded calldata to call on `to`.
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,

    /// Native value (wei) to send with the call. For ERC-20 sells this is `"0"`.
    /// Parsed defensively as a decimal string `U256`.
    #[serde_as(as = "serde_with::DisplayFromStr")]
    #[serde(default = "u256_zero")]
    pub value: U256,
}

fn u256_zero() -> U256 {
    U256::ZERO
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Error envelope returned by Enso on a non-2xx status. All fields optional —
/// Enso's shape varies (`message`, `error`, `statusCode`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    #[serde(default)]
    pub status_code: i64,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub error: String,
}
