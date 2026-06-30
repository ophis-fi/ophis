//! DTOs for the LI.FI (li.quest) aggregator API.
//!
//! Full documentation: <https://docs.li.fi/api-reference>.
//!
//! A single endpoint is used per swap:
//! - `GET /v1/quote` (with `fromChain == toChain == 130`) — returns the best
//!   SAME-CHAIN route as `transactionRequest` (encoded calldata + router `to`),
//!   plus `estimate.toAmount` (optimistic) and `estimate.toAmountMin` (the
//!   GUARANTEED, on-chain-enforced slippage floor — the value baked into the
//!   calldata's `minAmount` arg, which the router reverts below).
//!
//! LI.FI works in **wei** (`fromAmount` and the response amounts are base
//! units), so — unlike OpenOcean — the caller needs no token decimals.
//!
//! The response carries many more fields than we model; we deliberately do NOT
//! `deny_unknown_fields` on the response DTOs so LI.FI can evolve its payload
//! without breaking deserialization.

use {
    crate::domain::eth,
    alloy::primitives::U256,
    bytes_hex::BytesHex,
    serde::Deserialize,
    serde_with::serde_as,
};

// ---------------------------------------------------------------------------
// GET /v1/quote
// ---------------------------------------------------------------------------

/// Top-level response for `GET /v1/quote`. On a successful quote LI.FI returns
/// `estimate` + `transactionRequest` + `action` + `includedSteps`; on failure
/// it returns the [`ApiError`] envelope instead (no `estimate`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub estimate: Estimate,
    pub transaction_request: TransactionRequest,
    /// The route's chain context — used to reject any cross-chain (bridge)
    /// route defensively.
    #[serde(default)]
    pub action: Action,
    /// The individual steps composing this route (e.g. a fee-collection
    /// `protocol` step + a DEX `swap` step). We reject any route containing a
    /// bridge-like step — its calldata is not deferred-settlement-safe.
    #[serde(default)]
    pub included_steps: Vec<Step>,
}

#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    /// Optimistic quoted output (wei). NOT reported as the clearing amount —
    /// see `to_amount_min`.
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub to_amount: U256,

    /// GUARANTEED minimum output (wei) the router enforces on-chain. This is
    /// `toAmount * (1 - slippage)` baked into the calldata as the `minAmount`
    /// arg; the swap reverts if the realized output is below it. Reported as
    /// the CoW buy clearing amount so the settlement's buy payout can never
    /// exceed what the router actually delivers (the #726 buffer-siphon fix).
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub to_amount_min: U256,

    /// The ERC-20 approval target the Settlement must approve to spend the sell
    /// token. For LI.FI same-chain swaps this equals the LiFiDiamond
    /// (`transaction_request.to`). Validated against the static allowlist.
    pub approval_address: eth::Address,

    /// Gas-cost breakdown. The first entry's `estimate` is the gas-units
    /// estimate we pad by 50%.
    #[serde(default)]
    pub gas_costs: Vec<GasCost>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GasCost {
    /// Gas-units estimate (decimal string).
    #[serde(default)]
    pub estimate: String,
}

#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRequest {
    /// Router to call — the LiFiDiamond entrypoint. Validated against the
    /// static allowlist by the caller; NEVER trusted blindly.
    pub to: eth::Address,

    /// Encoded calldata to call on `to` (LI.FI returns a `0x`-prefixed hex
    /// string).
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,

    /// Native value to attach to the call, a hex string (e.g. `"0x0"`). For
    /// ERC-20 -> ERC-20 swaps this is zero; the caller rejects a non-zero
    /// value (the wrapped-settlement guard). Kept as a string and parsed
    /// defensively so an unexpected shape never fails the whole quote parse.
    #[serde(default)]
    pub value: String,

    /// Chain id echoed back (defensive cross-check).
    #[serde(default)]
    pub chain_id: u64,
}

/// The `action` block — carries the from/to chain ids so we can reject any
/// cross-chain (bridge) route even if it somehow slipped past the same-chain
/// request params.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    #[serde(default)]
    pub from_chain_id: u64,
    #[serde(default)]
    pub to_chain_id: u64,
}

/// One step of a route. `step_type` is the discriminant — `"swap"` /
/// `"protocol"` are same-chain-safe; `"cross"` / `"bridge"` are NOT (their
/// calldata bridges funds and cannot be settled later by the Settlement).
#[derive(Clone, Debug, Deserialize)]
pub struct Step {
    #[serde(rename = "type", default)]
    pub step_type: String,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// LI.FI error envelope (`{ message, code, errors }`). We only depend on
/// `message`; `code` varies (string/number) across error classes so it is not
/// modeled, keeping the error parse robust.
#[derive(Debug, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub message: String,
}
