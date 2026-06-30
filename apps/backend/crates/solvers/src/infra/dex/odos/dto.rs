//! DTOs for the Odos Smart Order Router (SOR) v2 API.
//!
//! Full documentation: <https://docs.odos.xyz/build/api-docs>.
//!
//! Two endpoints are involved per swap (mirrors KyberSwap's two-step flow):
//! - `POST /sor/quote/v2` — returns a `pathId` plus the optimistic
//!   `outAmounts`. It does NOT return the encoded calldata or the router
//!   address.
//! - `POST /sor/assemble`  — turns that `pathId` into the encoded
//!   `transaction.{to, data, value, …}` ready to execute.
//!
//! There is no HMAC signing and no API key required for anonymous (rate
//! limited) usage. An optional `referralCode` may be supplied via config; it
//! is only used for partner attribution / higher rate limits and never
//! changes the funds path.
//!
//! **There is no dedicated "minimum output" field in either response.** The
//! slippage floor (`outAmount * (1 - slippageLimitPercent/100)`) is baked into
//! the router calldata by `/sor/assemble` and enforced on-chain — the API only
//! ever echoes the optimistic `outAmounts` / `outputTokens`. We reconstruct
//! the floor ourselves from `outAmounts` and the `slippageLimitPercent` we
//! sent (see `odos::min_output_amount`).

use {
    crate::domain::eth,
    alloy::primitives::{Address, U256},
    bytes_hex::BytesHex,
    serde::{Deserialize, Serialize},
    serde_with::serde_as,
};

// ---------------------------------------------------------------------------
// POST /sor/quote/v2
// ---------------------------------------------------------------------------

/// A single input token leg for `POST /sor/quote/v2`.
#[serde_as]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputToken {
    pub token_address: eth::Address,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount: U256,
}

/// A single output token leg for `POST /sor/quote/v2`.
///
/// `proportion` is the fraction of the output value to route into this token.
/// We always request a single output token with `proportion = 1`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputToken {
    pub token_address: eth::Address,
    pub proportion: u8,
}

/// Body for `POST /sor/quote/v2`.
///
/// Odos's SOR is `exactIn`-only: `inputTokens[0].amount` is the sell amount and
/// the solver requests the full output value into the single buy token.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRequest {
    pub chain_id: u64,
    pub input_tokens: Vec<InputToken>,
    pub output_tokens: Vec<OutputToken>,
    /// The CoW settlement contract — quote is generated for this caller so the
    /// assembled calldata is executable by it.
    pub user_addr: Address,
    /// Slippage tolerance as a percentage (e.g. `1.0` = 1%, `0.5` = 0.5%).
    /// This is what Odos bakes into the router calldata as the on-chain
    /// minimum-output floor.
    pub slippage_limit_percent: f64,
    /// Optional referral / partner code. Anonymous usage leaves this `None`.
    /// Never affects the funds path — attribution / rate-limit only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referral_code: Option<u64>,
    /// Exclude RFQ liquidity. RFQ quotes carry short-lived signed offers that
    /// expire before a CoW settlement is broadcast seconds-to-minutes later, so
    /// we always disable them.
    pub disable_rfqs: bool,
    /// Request the compact calldata encoding (smaller `transaction.data`).
    pub compact: bool,
}

/// Response envelope for `POST /sor/quote/v2`.
///
/// `out_amounts` is the OPTIMISTIC quoted output — NOT the slippage floor. The
/// guaranteed minimum is reconstructed by the caller from this value and the
/// `slippage_limit_percent` we sent (which is what Odos bakes into the
/// calldata).
#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    /// Echo of the requested input token addresses.
    #[serde(default)]
    pub in_tokens: Vec<eth::Address>,
    /// Echo of the requested output token addresses.
    #[serde(default)]
    pub out_tokens: Vec<eth::Address>,
    /// Input amounts (decimal strings), one per `in_tokens`.
    #[serde_as(as = "Vec<serde_with::DisplayFromStr>")]
    #[serde(default)]
    pub in_amounts: Vec<U256>,
    /// Optimistic output amounts (decimal strings), one per `out_tokens`.
    /// NOT the slippage floor.
    #[serde_as(as = "Vec<serde_with::DisplayFromStr>")]
    pub out_amounts: Vec<U256>,
    /// Opaque path identifier echoed verbatim to `/sor/assemble`.
    pub path_id: String,
    /// Naive gas estimate.
    #[serde(default)]
    pub gas_estimate: f64,
    /// Block number the quote was generated for.
    #[serde(default)]
    pub block_number: u64,
}

// ---------------------------------------------------------------------------
// POST /sor/assemble
// ---------------------------------------------------------------------------

/// Body for `POST /sor/assemble`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleRequest {
    /// The CoW settlement contract — MUST match the `user_addr` sent to the
    /// quote, otherwise Odos rejects the assembly.
    pub user_addr: Address,
    /// Path identifier returned by `/sor/quote/v2`.
    pub path_id: String,
    /// Run an on-chain simulation. We disable it: the user is a smart contract
    /// (CoW Settlement) with no token balance at simulation time, so Odos's
    /// EOA-style simulation would fail. We pad the quote's gas estimate
    /// ourselves instead.
    pub simulate: bool,
    /// The token recipient. Set to the settlement contract so the swapped
    /// output lands in the settlement buffer for the CoW payout.
    pub receiver: Address,
}

/// Response envelope for `POST /sor/assemble`.
#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleResponse {
    /// The encoded router transaction.
    pub transaction: Transaction,
    /// Optimistic output amounts (decimal strings), one per output token.
    /// Same caveat as `QuoteResponse::out_amounts`: this is NOT the slippage
    /// floor — it is the optimistic value. We never report it as the CoW buy
    /// clearing amount.
    #[serde_as(as = "Vec<serde_with::DisplayFromStr>")]
    #[serde(default)]
    pub output_tokens: Vec<U256>,
}

/// The encoded transaction returned by `/sor/assemble`.
#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    /// The Odos router address — validated against `ODOS_ROUTER_ALLOWLIST`
    /// before it is used as the call target and ERC-20 spender.
    pub to: Address,
    /// Encoded calldata to call on `to`.
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,
    /// Native-token value attached to the tx (Odos returns it as a decimal
    /// string, non-zero only when the sell token is the native sentinel).
    /// Unused by this solver — the native value is already encoded in
    /// `data` — so it is kept untyped (`serde_json::Value`) to tolerate either
    /// a string or numeric form and never fail the whole assemble parse on a
    /// shape we don't depend on.
    #[serde(default)]
    pub value: serde_json::Value,
    /// Suggested gas limit (number).
    #[serde(default)]
    pub gas: u64,
    /// Sanity-check echo of the chain id.
    #[serde(default)]
    pub chain_id: Option<u64>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Odos error envelope. Both endpoints return `{"detail": "...", ...}` on
/// failure (e.g. rate limit, no path). Some failures also carry a numeric
/// `errorCode`.
#[derive(Clone, Debug, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub detail: String,
    #[serde(default, rename = "errorCode")]
    pub error_code: Option<i64>,
}
