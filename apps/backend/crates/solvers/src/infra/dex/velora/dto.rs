//! DTOs for the Velora (formerly ParaSwap) aggregator API v6.2.
//!
//! Full documentation: <https://developers.velora.xyz/api/velora-api>.
//!
//! Endpoints involved per swap:
//! - `GET  /prices`               — best route + router (`contractAddress`)
//! - `POST /transactions/{chain}` — encoded calldata + the `to` address
//!
//! The `priceRoute` blob returned by `/prices` is HMAC-integrity-protected
//! and must be echoed BYTE-IDENTICAL to `/transactions`. We model it as
//! `serde_json::Value` so any unknown / future fields round-trip unchanged.

use {
    crate::domain::eth,
    alloy::primitives::{Address, U256},
    bytes_hex::BytesHex,
    serde::{Deserialize, Serialize},
    serde_with::serde_as,
};

// ---------------------------------------------------------------------------
// GET /prices
// ---------------------------------------------------------------------------

/// Successful `/prices` payload. The fields below are extracted for our
/// own use; `raw` holds the entire `priceRoute` object so we can echo it
/// back to `/transactions` byte-identically.
#[serde_as]
#[derive(Clone, Debug)]
pub struct PriceRoute {
    pub src_amount: U256,
    pub src_decimals: u8,
    pub dest_amount: U256,
    pub dest_decimals: u8,
    /// Augustus V6.2 router address — must match VELORA_ROUTER_ALLOWLIST.
    pub contract_address: Address,
    /// Spender for ERC-20 allowance. In v6.2 always equals
    /// `contract_address`. We validate equality at the call site.
    pub token_transfer_proxy: Address,
    /// Decimal gas estimate (string in Velora's response).
    pub gas_cost: String,
    /// Full `priceRoute` object — echoed verbatim to `/transactions` to
    /// preserve Velora's integrity HMAC.
    pub raw: serde_json::Value,
}

/// Top-level `/prices` response envelope.
#[derive(Clone, Debug, Deserialize)]
pub struct PricesResponse {
    /// Present on success. `null` for un-routable pairs (Velora returns
    /// 200 + null priceRoute for those rather than an error).
    #[serde(default, rename = "priceRoute")]
    pub price_route: Option<PriceRoute>,
    /// Present on explicit errors (`{"error": "..."}`).
    #[serde(default)]
    pub error: Option<ApiError>,
}

// Custom Deserialize for PriceRoute so we can both extract the typed fields
// AND keep the raw JSON for round-tripping to /transactions.
impl<'de> serde::Deserialize<'de> for PriceRoute {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Deserialize into a generic Value first — preserves field order
        // and unknown fields.
        let raw = serde_json::Value::deserialize(deserializer)?;
        let obj = raw
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("priceRoute must be an object"))?;

        fn req<'a>(
            obj: &'a serde_json::Map<String, serde_json::Value>,
            key: &str,
        ) -> Result<&'a serde_json::Value, serde::de::value::Error> {
            obj.get(key)
                .ok_or_else(|| serde::de::Error::custom(format!("missing field: {key}")))
        }

        fn parse_u256(v: &serde_json::Value) -> Result<U256, serde::de::value::Error> {
            v.as_str()
                .ok_or_else(|| serde::de::Error::custom("expected stringified U256"))?
                .parse::<U256>()
                .map_err(|e| serde::de::Error::custom(format!("invalid U256: {e}")))
        }

        fn parse_addr(v: &serde_json::Value) -> Result<Address, serde::de::value::Error> {
            v.as_str()
                .ok_or_else(|| serde::de::Error::custom("expected address string"))?
                .parse::<Address>()
                .map_err(|e| serde::de::Error::custom(format!("invalid address: {e}")))
        }

        fn parse_u8(v: &serde_json::Value) -> Result<u8, serde::de::value::Error> {
            v.as_u64()
                .ok_or_else(|| serde::de::Error::custom("expected u64 for decimals"))?
                .try_into()
                .map_err(|_| serde::de::Error::custom("decimals > 255"))
        }

        let src_amount = parse_u256(req(obj, "srcAmount").map_err(serde::de::Error::custom)?)
            .map_err(serde::de::Error::custom)?;
        let dest_amount = parse_u256(req(obj, "destAmount").map_err(serde::de::Error::custom)?)
            .map_err(serde::de::Error::custom)?;
        let src_decimals = parse_u8(req(obj, "srcDecimals").map_err(serde::de::Error::custom)?)
            .map_err(serde::de::Error::custom)?;
        let dest_decimals = parse_u8(req(obj, "destDecimals").map_err(serde::de::Error::custom)?)
            .map_err(serde::de::Error::custom)?;
        let contract_address =
            parse_addr(req(obj, "contractAddress").map_err(serde::de::Error::custom)?)
                .map_err(serde::de::Error::custom)?;
        let token_transfer_proxy =
            parse_addr(req(obj, "tokenTransferProxy").map_err(serde::de::Error::custom)?)
                .map_err(serde::de::Error::custom)?;
        let gas_cost = req(obj, "gasCost")
            .map_err(serde::de::Error::custom)?
            .as_str()
            .ok_or_else(|| serde::de::Error::custom("gasCost not a string"))?
            .to_string();

        Ok(PriceRoute {
            src_amount,
            src_decimals,
            dest_amount,
            dest_decimals,
            contract_address,
            token_transfer_proxy,
            gas_cost,
            raw,
        })
    }
}

// ---------------------------------------------------------------------------
// POST /transactions/{chain}
// ---------------------------------------------------------------------------

/// Body for `POST /transactions/{chainId}?ignoreChecks=true`.
#[serde_as]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRequest {
    pub src_token: eth::Address,
    pub src_decimals: u8,
    pub dest_token: eth::Address,
    pub dest_decimals: u8,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub src_amount: U256,
    /// Slippage in bps (e.g. `50` = 0.5%).
    pub slippage: u32,
    /// Settlement contract (`from`).
    pub user_address: Address,
    /// Settlement contract (`to`).
    pub receiver: Address,
    /// Project ID for analytics + fee attribution.
    pub partner: String,
    /// Partner fee recipient address — `None` disables partner fee.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partner_address: Option<Address>,
    /// Partner fee in bps — `None` disables partner fee.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partner_fee_bps: Option<u32>,
    /// Bake fee transfer into the swap tx (atomic delivery to
    /// `partner_address`). Required when the partner has no claim infra.
    pub is_direct_fee_transfer: bool,
    /// Whether to capture positive-slippage surplus. We default `false`
    /// because the CoW driver already handles surplus distribution at
    /// the protocol level — double-capturing is incorrect accounting.
    pub take_surplus: bool,
    /// The `priceRoute` echoed BYTE-IDENTICAL from `/prices` (HMAC-protected).
    pub price_route: serde_json::Value,
}

/// `/transactions` response — either the encoded tx or an error envelope.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum TransactionApiResponse {
    Success(TransactionResponse),
    Error(ApiError),
}

#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionResponse {
    /// Augustus V6.2 router — must equal the `contractAddress` from /prices.
    pub to: Address,
    #[serde_as(as = "BytesHex")]
    pub data: Vec<u8>,
    /// Native-token value attached to the tx (non-zero only when sell
    /// token is the native sentinel `0xeeee...eeee`).
    #[serde(default)]
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    pub value: Option<U256>,
    /// Sanity-check echo of the chain id from the path param.
    #[serde(default)]
    pub chain_id: Option<u64>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Velora's error envelope. Unlike KyberSwap (numeric codes), Velora
/// returns string-typed messages — we pattern-match in
/// `Velora::classify_error`.
#[derive(Clone, Debug, Deserialize)]
pub struct ApiError {
    pub error: String,
}
