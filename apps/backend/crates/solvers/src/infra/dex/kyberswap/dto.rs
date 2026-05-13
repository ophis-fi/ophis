//! DTOs for the KyberSwap aggregator API.
//!
//! Full documentation: <https://docs.kyberswap.com/Aggregator/aggregator-api>.
//!
//! Two endpoints are involved per swap:
//! - `GET  /routes`       — fetch the best route summary and the router address
//! - `POST /route/build`  — turn that route summary into encoded calldata

use {
    crate::domain::eth,
    alloy::primitives::U256,
    bytes_hex::BytesHex,
    serde::{Deserialize, Serialize},
    serde_with::serde_as,
};

// ---------------------------------------------------------------------------
// GET /routes
// ---------------------------------------------------------------------------

/// Query parameters for `GET /routes`.
///
/// KyberSwap's aggregator only supports the `exactIn` flow, therefore
/// `amount_in` is the sell amount.
#[serde_as]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesRequest {
    pub token_in: eth::Address,
    pub token_out: eth::Address,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_in: U256,
    /// When set, the route optimizes for gas cost rather than output amount.
    pub save_gas: bool,
    /// When `true`, the response includes a `gas` estimate in `routeSummary`.
    pub gas_include: bool,
}

/// Top-level response envelope for `GET /routes` and `POST /route/build`.
#[derive(Clone, Debug, Deserialize)]
pub struct RoutesApiResponse {
    pub code: i64,
    #[serde(default)]
    pub message: String,
    pub data: Option<RoutesData>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesData {
    pub route_summary: RouteSummary,
    /// Router address acting as the ERC-20 spender — used as the allowance
    /// target on the resulting swap.
    pub router_address: eth::Address,
}

/// Opaque route descriptor returned by `/routes` and echoed verbatim to
/// `/route/build`.
///
/// The nested `route` field is a deeply nested array-of-arrays of pool steps
/// that we do not need to introspect. Modeling it as `serde_json::Value`
/// guarantees that we round-trip every field even if KyberSwap adds new ones
/// over time.
#[serde_as]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteSummary {
    pub token_in: eth::Address,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_in: U256,
    #[serde(default)]
    pub amount_in_usd: String,
    pub token_out: eth::Address,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_out: U256,
    #[serde(default)]
    pub amount_out_usd: String,
    #[serde(default)]
    pub gas: String,
    #[serde(default)]
    pub gas_price: String,
    #[serde(default)]
    pub gas_usd: String,
    /// Opaque nested array of pool steps — echo verbatim to `/route/build`.
    pub route: serde_json::Value,
    /// KyberSwap historically used `routeID`; new responses also use `routeId`.
    /// Serde rename matches whatever the upstream actually sends and echoes it
    /// back unchanged.
    #[serde(default, rename = "routeID", skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_fee: Option<serde_json::Value>,
    /// Capture any additional fields KyberSwap might add in the future so we
    /// can echo them back unchanged in `/route/build`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// POST /route/build
// ---------------------------------------------------------------------------

/// Body for `POST /route/build`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    /// Route summary returned by `/routes`, echoed verbatim.
    pub route_summary: RouteSummary,
    /// Wallet that will execute the swap (the CoW settlement contract).
    pub sender: eth::Address,
    /// Wallet that should receive the swapped tokens (same as `sender`).
    pub recipient: eth::Address,
    /// Slippage tolerance in basis points (0–2000).
    pub slippage_tolerance: u16,
    /// Unix timestamp after which the swap is invalid. `None` lets the API
    /// pick its default (~20 min ahead).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<u64>,
    /// We use the gas estimate from `/routes` and add our own 50% padding,
    /// so always ask the API to skip its own simulation.
    pub enable_gas_estimation: bool,
}

/// Top-level response envelope for `POST /route/build`.
#[derive(Clone, Debug, Deserialize)]
pub struct BuildApiResponse {
    pub code: i64,
    #[serde(default)]
    pub message: String,
    pub data: Option<BuildData>,
}

#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildData {
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_in: U256,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_out: U256,
    /// Decimal string e.g. `"210000"`. Parsed by the caller (trim + decimal).
    pub gas: String,
    /// Encoded calldata to call on `router_address`.
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,
    /// Should match the address returned by `/routes`. We treat any
    /// mismatch as an API error in the caller.
    pub router_address: eth::Address,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Shared error envelope used when KyberSwap returns a non-2xx HTTP status or
/// otherwise fails to produce a result payload.
#[derive(Debug, Deserialize)]
pub struct ApiError {
    pub code: i64,
    #[serde(default)]
    pub message: String,
}
