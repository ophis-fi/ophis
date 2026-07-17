//! DTOs for the OpenOcean v4 aggregator API.
//!
//! Full documentation: <https://docs.openocean.finance/dev/aggregator-api-and-sdk/aggregator-api-v4>.
//!
//! A single endpoint is used per swap:
//! - `GET /v4/{chainId}/swap` — returns the best route as encoded calldata
//!   together with the router (`to`), the optimistic quote (`outAmount`) and
//!   the GUARANTEED slippage-floored output (`minOutAmount`).
//!
//! Unlike KyberSwap (which works in wei via `DisplayFromStr` over `U256`),
//! OpenOcean's `amount` query parameter is in **human-readable decimal token
//! units** (e.g. `"1.5"` for 1.5 USDC), so the caller converts the order's wei
//! amount using the sell-token decimals before building the request. The
//! amounts inside the RESPONSE (`outAmount`, `minOutAmount`) are returned in
//! wei (base units) and are parsed as `U256`.

use {
    crate::domain::eth, alloy::primitives::U256, bytes_hex::BytesHex, serde::Deserialize,
    serde_with::serde_as,
};

// ---------------------------------------------------------------------------
// GET /v4/{chainId}/swap
// ---------------------------------------------------------------------------

/// Top-level response envelope for `GET /v4/{chainId}/swap`.
///
/// OpenOcean returns `code: 200` on success and a non-200 code with a
/// human-readable `message`/`error` on failure. `data` is absent on error.
#[derive(Clone, Debug, Deserialize)]
pub struct SwapApiResponse {
    pub code: i64,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub error: String,
    pub data: Option<SwapData>,
}

/// The `data` payload of a successful `/swap` response.
#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapData {
    /// Router address to call (the OpenOceanExchangeProxy entrypoint). This is
    /// ALSO the ERC-20 spender the Settlement contract must approve. Validated
    /// against the static allowlist by the caller — NEVER trusted blindly.
    pub to: eth::Address,

    /// Encoded calldata to call on `to`.
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,

    /// Native value (wei) to send with the call. For ERC-20 sells this is `0`;
    /// for native-ETH sells it equals the sold amount. Parsed defensively as a
    /// decimal string `U256`.
    #[serde_as(as = "serde_with::DisplayFromStr")]
    #[serde(default = "u256_zero")]
    pub value: U256,

    /// Optimistic quoted output (wei). NOT reported as the clearing amount —
    /// see `min_out_amount`.
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub out_amount: U256,

    /// GUARANTEED minimum output (wei) the router enforces on-chain. This is
    /// `outAmount * (1 - slippage)` baked into the calldata; the swap reverts
    /// if the realized output is below it. Reported as the CoW buy clearing
    /// amount so the settlement's buy payout can never exceed what the router
    /// actually delivers.
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub min_out_amount: U256,

    /// Gas estimate. OpenOcean returns this as a JSON number; capture it as a
    /// `u64` and let the caller pad it.
    #[serde(default)]
    pub estimated_gas: u64,

    /// Chain id echoed back by the API. Used as a defensive cross-check that
    /// the response is for the chain we requested.
    #[serde(default)]
    pub chain_id: u64,

    /// Off-chain expiry (unix seconds) of an RFQ-backed route; `0` for plain
    /// AMM routes. We request `disableRfq=true`, but a non-zero value here means
    /// the API returned an RFQ route anyway — the caller rejects it because such
    /// a quote can expire before the deferred CoW settlement lands.
    #[serde(default)]
    pub rfq_deadline: i64,
}

fn u256_zero() -> U256 {
    U256::ZERO
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Shared error envelope used when OpenOcean returns a non-2xx HTTP status or
/// otherwise fails to produce a result payload.
#[derive(Debug, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub code: i64,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub error: String,
}
