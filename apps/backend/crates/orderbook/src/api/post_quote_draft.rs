//! `POST /api/v1/quote/draft` (api-dx, frozen path per owner decision 9).
//!
//! One call returns a quote PLUS a ready-to-sign unsigned order draft and
//! its EIP-712 signing envelope. The caller signs `signing` (domain / types
//! / primaryType) over `order` and submits via `POST /api/v1/orders`,
//! attaching `fullAppData` (when present) as the order's `appData` string
//! with `appDataHash` as the expected hash.
//!
//! The request is a regular quote request plus `slippageBps` (u16, default
//! 50, capped at 5000): the signed limit side is derived from the quote by
//! that slippage, kind-aware. For `sell` the draft's `buyAmount` is the
//! minimum out, rounded UP so the limit is never one atom below the true
//! slippage floor; for `buy` the draft's `sellAmount` is the maximum in,
//! rounded DOWN. Both formulas mirror `@ophis/sdk`'s
//! `assertLimitWithinSlippage`, so drafts built here pass the SDK/MCP
//! bound checks at the same bips. The signed `feeAmount` is always 0:
//! Ophis orders take the fee from surplus plus the CIP-75 appData partner
//! fee, never a signed feeAmount.
//!
//! When the caller sends no appData (owner decision 14), the draft defaults
//! to the CIP-75 partner-fee document: the revenue-relevant default, so
//! integrators who send nothing still produce fee-bearing orders. The
//! document matches `@ophis/sdk`'s `buildOphisFullAppData` byte for byte
//! (deterministic sorted-key JSON, the 5 bps partner rate) with the
//! effective `slippageBips` recorded in `metadata.quote`. Caller-provided
//! appData passes through untouched, including whatever slippage metadata
//! it does or does not carry.

use {
    super::{AppState, error, get_contract_info::ContractsInfo},
    alloy::primitives::{Address, U256},
    axum::{
        Json,
        extract::State,
        http::StatusCode,
        response::{IntoResponse, Response},
    },
    app_data::AppDataHash,
    model::{
        order::{BuyTokenDestination, OrderCreationAppData, OrderKind, SellTokenSource},
        quote::{OrderQuoteRequest, OrderQuoteResponse},
        signature::SigningScheme,
    },
    number::serialization::HexOrDecimalU256,
    serde::{Deserialize, Serialize},
    serde_json::{Value, json},
    serde_with::serde_as,
    std::sync::Arc,
};

/// Default slippage applied when the caller omits `slippageBps`.
const DEFAULT_SLIPPAGE_BPS: u16 = 50;

/// Hard cap on accepted slippage (50%), matching `@ophis/sdk`'s
/// `MAX_SLIPPAGE_BIPS`: above this a "limit" almost certainly reflects a
/// mistake, not a real trade.
const MAX_SLIPPAGE_BPS: u16 = 5000;

const BPS_BASE: u16 = 10_000;

/// CoW appData schema version, matching `APP_DATA_VERSION` in
/// `packages/sdk/src/order-build.ts` (cow-sdk LATEST_APP_DATA_VERSION).
const APP_DATA_VERSION: &str = "1.14.0";

/// Volume bps of the defaulted partner-fee document: the 5 bps integrator
/// (wholesale) rate, parity with `OPHIS_VOLUME_FEE_BPS` in
/// `packages/sdk/src/partner-fee.ts`. Must clear the ingress floor
/// (`app_data::OPHIS_NON_STABLE_FLOOR_BPS`, enforced on fees to the Ophis
/// recipient), which a test below pins.
const DRAFT_VOLUME_FEE_BPS: u64 = 5;

/// A quote request plus the draft-only `slippageBps` knob.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteDraftRequest {
    #[serde(flatten)]
    pub quote: OrderQuoteRequest,
    /// Max accepted slippage in bps applied to the signed limit side
    /// (default 50, cap 5000).
    #[serde(default)]
    pub slippage_bps: Option<u16>,
}

/// The unsigned, ready-to-sign order draft. Field-for-field the EIP-712
/// `Order` struct (in `signing.types`), with `appData` already the bytes32
/// hash, plus the `signingScheme` echoed from the quote so the eventual
/// `POST /api/v1/orders` body needs no extra decisions.
#[serde_as]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDraft {
    pub sell_token: Address,
    pub buy_token: Address,
    pub receiver: Address,
    #[serde_as(as = "HexOrDecimalU256")]
    pub sell_amount: U256,
    #[serde_as(as = "HexOrDecimalU256")]
    pub buy_amount: U256,
    pub valid_to: u32,
    /// The bytes32 that goes into the signed order: keccak256 of the full
    /// appData document.
    pub app_data: AppDataHash,
    /// Always 0: the fee is taken from surplus plus the appData partner
    /// fee, never a signed feeAmount.
    #[serde_as(as = "HexOrDecimalU256")]
    pub fee_amount: U256,
    pub kind: OrderKind,
    pub partially_fillable: bool,
    pub sell_token_balance: SellTokenSource,
    pub buy_token_balance: BuyTokenDestination,
    pub signing_scheme: SigningScheme,
}

/// EIP-712 typed-data envelope: sign `order` against this.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningEnvelope {
    pub domain: Value,
    pub types: Value,
    pub primary_type: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteDraftResponse {
    /// The exact response `POST /api/v1/quote` would have returned for the
    /// embedded quote request.
    pub quote: OrderQuoteResponse,
    pub order: OrderDraft,
    pub signing: SigningEnvelope,
    /// The full appData document to submit alongside the order. Present
    /// whenever the server knows the document (always when it was
    /// defaulted); absent only when the caller quoted with a bare hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_app_data: Option<String>,
    pub app_data_hash: AppDataHash,
    /// The effective slippage applied to the draft's limit side.
    pub slippage_bps: u16,
}

#[derive(Debug)]
enum DraftError {
    SlippageOutOfRange(u16),
    /// Slippage rounded the minimum buy amount down to zero, which would
    /// sign an accept-any-price order.
    ZeroMinBuyAmount,
    /// The slippage-adjusted amount exceeds uint256.
    AmountOverflow,
}

impl IntoResponse for DraftError {
    fn into_response(self) -> Response {
        let (error_type, description) = match self {
            DraftError::SlippageOutOfRange(bps) => (
                "BadRequest",
                format!("slippageBps must be at most {MAX_SLIPPAGE_BPS} (50%), got {bps}"),
            ),
            DraftError::ZeroMinBuyAmount => (
                "ZeroAmount",
                "the slippage-adjusted minimum buy amount is zero, which would sign an \
                 accept-any-price order; lower slippageBps or trade a larger amount"
                    .to_string(),
            ),
            DraftError::AmountOverflow => (
                "SellAmountOverflow",
                "the slippage-adjusted amount exceeds uint256".to_string(),
            ),
        };
        (StatusCode::BAD_REQUEST, error(error_type, description)).into_response()
    }
}

/// The CIP-75 partner-fee document used when the caller sends no appData
/// (decision 14). Deterministic sorted-key compact JSON, byte-identical to
/// `@ophis/sdk`'s `buildOphisFullAppData(chainId, slippageBips)` output for
/// a fee chain. The workspace `serde_json` orders map keys (no
/// `preserve_order` feature), which the exact-bytes test below pins.
fn default_draft_app_data(slippage_bps: u16) -> String {
    json!({
        "appCode": "ophis",
        "metadata": {
            "orderClass": { "orderClass": "market" },
            "partnerFee": {
                "recipient": app_data::OPHIS_PARTNER_FEE_RECIPIENT.to_string(),
                "volumeBps": DRAFT_VOLUME_FEE_BPS,
            },
            "quote": { "slippageBips": slippage_bps },
        },
        "version": APP_DATA_VERSION,
    })
    .to_string()
}

/// Whether the caller sent no appData: the quote-request deserializer maps
/// an absent field to the zero hash, and a literal zero hash means "no
/// document" as well.
fn app_data_is_absent(app_data: &OrderCreationAppData) -> bool {
    matches!(app_data, OrderCreationAppData::Hash { hash } if *hash == AppDataHash::default())
}

/// Minimum out for a sell draft: the quoted buy amount reduced by
/// `slippage_bps`, rounded UP (never one atom below the true slippage
/// floor; mirrors `@ophis/sdk`).
fn min_buy_amount(quoted_buy: U256, slippage_bps: u16) -> Result<U256, DraftError> {
    let scaled = quoted_buy
        .checked_mul(U256::from(BPS_BASE - slippage_bps))
        .ok_or(DraftError::AmountOverflow)?
        .div_ceil(U256::from(BPS_BASE));
    if scaled.is_zero() {
        return Err(DraftError::ZeroMinBuyAmount);
    }
    Ok(scaled)
}

/// Maximum in for a buy draft: the quoted total sell amount raised by
/// `slippage_bps`, rounded DOWN (mirrors `@ophis/sdk`).
fn max_sell_amount(quoted_sell: U256, slippage_bps: u16) -> Result<U256, DraftError> {
    Ok(quoted_sell
        .checked_mul(U256::from(BPS_BASE + slippage_bps))
        .ok_or(DraftError::AmountOverflow)?
        / U256::from(BPS_BASE))
}

/// Assembles the draft from a computed quote. Pure: everything on-chain or
/// stateful already happened in the quote.
fn build_draft(
    quote_response: OrderQuoteResponse,
    contracts: &ContractsInfo,
    slippage_bps: u16,
) -> Result<QuoteDraftResponse, DraftError> {
    let quote = &quote_response.quote;

    // The signed sell side always carries the quote's fee: the order signs
    // feeAmount 0, so the fee lives inside sellAmount (zero for the
    // fee-from-surplus quotes this orderbook serves today, but the draft
    // must stay correct if a nonzero fee_amount ever reappears).
    let total_sell = quote
        .sell_amount
        .checked_add(quote.fee_amount)
        .ok_or(DraftError::AmountOverflow)?;

    let (sell_amount, buy_amount) = match quote.kind {
        OrderKind::Sell => (total_sell, min_buy_amount(quote.buy_amount, slippage_bps)?),
        OrderKind::Buy => (max_sell_amount(total_sell, slippage_bps)?, quote.buy_amount),
    };

    let app_data_hash = quote.app_data.hash();
    let full_app_data = match &quote.app_data {
        OrderCreationAppData::Full { full } | OrderCreationAppData::Both { full, .. } => {
            Some(full.clone())
        }
        OrderCreationAppData::Hash { .. } => None,
    };

    let order = OrderDraft {
        sell_token: quote.sell_token,
        buy_token: quote.buy_token,
        receiver: quote.receiver.unwrap_or(quote_response.from),
        sell_amount,
        buy_amount,
        valid_to: quote.valid_to,
        app_data: app_data_hash,
        fee_amount: U256::ZERO,
        kind: quote.kind,
        partially_fillable: quote.partially_fillable,
        sell_token_balance: quote.sell_token_balance,
        buy_token_balance: quote.buy_token_balance,
        signing_scheme: quote.signing_scheme,
    };

    let signing = SigningEnvelope {
        domain: json!({
            "name": "Gnosis Protocol",
            "version": "v2",
            "chainId": contracts.chain_id,
            "verifyingContract": contracts.settlement.to_string(),
        }),
        types: order_typed_data_types(),
        primary_type: "Order",
    };

    Ok(QuoteDraftResponse {
        quote: quote_response,
        order,
        signing,
        full_app_data,
        app_data_hash,
        slippage_bps,
    })
}

/// The EIP-712 `Order` struct, mirroring `ORDER_TYPED_DATA_TYPES` in
/// `packages/sdk/src/order-build.ts` (@cowprotocol/contracts
/// ORDER_TYPE_FIELDS).
fn order_typed_data_types() -> Value {
    json!({
        "Order": [
            { "name": "sellToken", "type": "address" },
            { "name": "buyToken", "type": "address" },
            { "name": "receiver", "type": "address" },
            { "name": "sellAmount", "type": "uint256" },
            { "name": "buyAmount", "type": "uint256" },
            { "name": "validTo", "type": "uint32" },
            { "name": "appData", "type": "bytes32" },
            { "name": "feeAmount", "type": "uint256" },
            { "name": "kind", "type": "string" },
            { "name": "partiallyFillable", "type": "bool" },
            { "name": "sellTokenBalance", "type": "string" },
            { "name": "buyTokenBalance", "type": "string" },
        ],
    })
}

pub async fn post_quote_draft_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<QuoteDraftRequest>,
) -> Response {
    let slippage_bps = request.slippage_bps.unwrap_or(DEFAULT_SLIPPAGE_BPS);
    if slippage_bps > MAX_SLIPPAGE_BPS {
        return DraftError::SlippageOutOfRange(slippage_bps).into_response();
    }

    let mut quote_request = request.quote;
    if app_data_is_absent(&quote_request.app_data) {
        quote_request.app_data = OrderCreationAppData::Full {
            full: default_draft_app_data(slippage_bps),
        };
    }

    let quote_response = match state.quotes.calculate_quote(&quote_request).await {
        Ok(response) => response,
        Err(err) => {
            tracing::warn!(%err, ?quote_request, "post_quote_draft quote error");
            return err.into_response();
        }
    };

    match build_draft(quote_response, &state.contracts, slippage_bps) {
        Ok(draft) => (StatusCode::OK, Json(draft)).into_response(),
        Err(err) => err.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::api::{Error, get_contract_info::tests::test_contracts_info, response_body},
        bigdecimal::BigDecimal,
        chrono::{TimeZone, Utc},
        model::{DomainSeparator, quote::OrderQuote},
        std::str::FromStr,
    };

    fn quote_response(
        kind: OrderKind,
        sell_amount: u128,
        buy_amount: u128,
        fee_amount: u128,
        app_data: OrderCreationAppData,
    ) -> OrderQuoteResponse {
        OrderQuoteResponse {
            quote: OrderQuote {
                sell_token: Address::repeat_byte(0x02),
                buy_token: Address::repeat_byte(0x03),
                receiver: None,
                sell_amount: U256::from(sell_amount),
                buy_amount: U256::from(buy_amount),
                valid_to: 1_900_000_000,
                app_data,
                fee_amount: U256::from(fee_amount),
                gas_amount: BigDecimal::from_str("100000").unwrap(),
                gas_price: BigDecimal::from_str("10000000000").unwrap(),
                sell_token_price: BigDecimal::from_str("0.0004").unwrap(),
                kind,
                partially_fillable: false,
                sell_token_balance: SellTokenSource::Erc20,
                buy_token_balance: BuyTokenDestination::Erc20,
                signing_scheme: SigningScheme::Eip712,
            },
            from: Address::repeat_byte(0x01),
            expiration: Utc.timestamp_millis_opt(0).unwrap(),
            id: Some(42),
            verified: true,
            protocol_fee_bps: None,
        }
    }

    fn full_app_data() -> OrderCreationAppData {
        OrderCreationAppData::Full {
            full: default_draft_app_data(DEFAULT_SLIPPAGE_BPS),
        }
    }

    #[test]
    fn deserializes_quote_request_plus_slippage() {
        let request: QuoteDraftRequest = serde_json::from_value(serde_json::json!({
            "from": "0x0101010101010101010101010101010101010101",
            "sellToken": "0x0202020202020202020202020202020202020202",
            "buyToken": "0x0303030303030303030303030303030303030303",
            "kind": "sell",
            "sellAmountBeforeFee": "1337",
            "slippageBps": 75,
        }))
        .unwrap();
        assert_eq!(request.slippage_bps, Some(75));
        assert_eq!(request.quote.from, Address::repeat_byte(0x01));
        assert!(app_data_is_absent(&request.quote.app_data));

        // slippageBps omitted -> None (the handler applies the default);
        // explicit appData passes through.
        let request: QuoteDraftRequest = serde_json::from_value(serde_json::json!({
            "from": "0x0101010101010101010101010101010101010101",
            "sellToken": "0x0202020202020202020202020202020202020202",
            "buyToken": "0x0303030303030303030303030303030303030303",
            "kind": "sell",
            "sellAmountBeforeFee": "1337",
            "appData": "{\"version\":\"1.14.0\"}",
        }))
        .unwrap();
        assert_eq!(request.slippage_bps, None);
        assert!(!app_data_is_absent(&request.quote.app_data));
    }

    #[test]
    fn default_app_data_is_the_sdk_cip75_document_byte_for_byte() {
        // Pins the exact serialization (sorted keys, compact separators, the
        // checksummed recipient, the 5 bps partner rate): parity with
        // @ophis/sdk buildOphisFullAppData(10, 50). A workspace serde_json
        // feature change (preserve_order) or a constant drift breaks this.
        assert_eq!(
            default_draft_app_data(50),
            "{\"appCode\":\"ophis\",\"metadata\":{\"orderClass\":{\"orderClass\":\"market\"},\
             \"partnerFee\":{\"recipient\":\"0x858f0F5eE954846D47155F5203c04aF1819eCeF8\",\
             \"volumeBps\":5},\"quote\":{\"slippageBips\":50}},\"version\":\"1.14.0\"}",
        );
    }

    #[test]
    fn default_app_data_passes_the_backends_own_validator_and_fee_floor() {
        // The defaulted document must survive order ingress: valid JSON,
        // Volume policy, allowlisted recipient.
        let validated = app_data::Validator::new(8192)
            .validate(default_draft_app_data(DEFAULT_SLIPPAGE_BPS).as_bytes())
            .expect("the default draft appData must validate");
        let fee = validated.protocol.partner_fee.iter().next().unwrap();
        assert_eq!(fee.recipient, app_data::OPHIS_PARTNER_FEE_RECIPIENT);
        // The 5 bps draft rate must clear the non-stable ingress floor for
        // fees to the Ophis recipient, or defaulted drafts would build
        // orders the orderbook itself rejects.
        assert!(DRAFT_VOLUME_FEE_BPS >= app_data::OPHIS_NON_STABLE_FLOOR_BPS);
    }

    #[test]
    fn sell_draft_applies_slippage_to_buy_amount_rounding_up() {
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1_000_000, 3_000_001, 0, full_app_data()),
            &test_contracts_info(),
            50,
        )
        .unwrap();
        // sellAmount is exact; buyAmount = ceil(3_000_001 * 9950 / 10000).
        assert_eq!(draft.order.sell_amount, U256::from(1_000_000u64));
        assert_eq!(draft.order.buy_amount, U256::from(2_985_001u64));
        assert_eq!(draft.order.fee_amount, U256::ZERO);
        assert_eq!(draft.order.kind, OrderKind::Sell);
        assert_eq!(draft.slippage_bps, 50);
        // Zero slippage keeps the quote's buy amount exactly.
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1_000_000, 3_000_001, 0, full_app_data()),
            &test_contracts_info(),
            0,
        )
        .unwrap();
        assert_eq!(draft.order.buy_amount, U256::from(3_000_001u64));
    }

    #[test]
    fn buy_draft_applies_slippage_to_sell_amount_rounding_down() {
        let draft = build_draft(
            quote_response(OrderKind::Buy, 1_000_001, 3_000_000, 0, full_app_data()),
            &test_contracts_info(),
            50,
        )
        .unwrap();
        // buyAmount is exact; sellAmount = floor(1_000_001 * 10050 / 10000).
        assert_eq!(draft.order.buy_amount, U256::from(3_000_000u64));
        assert_eq!(draft.order.sell_amount, U256::from(1_005_001u64));
    }

    #[test]
    fn quoted_fee_folds_into_the_signed_sell_amount() {
        // The order signs feeAmount 0, so a nonzero quoted fee must live
        // inside sellAmount on both kinds.
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1_000_000, 3_000_000, 500, full_app_data()),
            &test_contracts_info(),
            0,
        )
        .unwrap();
        assert_eq!(draft.order.sell_amount, U256::from(1_000_500u64));
        assert_eq!(draft.order.fee_amount, U256::ZERO);

        let draft = build_draft(
            quote_response(OrderKind::Buy, 1_000_000, 3_000_000, 500, full_app_data()),
            &test_contracts_info(),
            100,
        )
        .unwrap();
        // floor((1_000_000 + 500) * 10100 / 10000)
        assert_eq!(draft.order.sell_amount, U256::from(1_010_505u64));
    }

    #[test]
    fn receiver_defaults_to_the_quote_owner() {
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1, 100, 0, full_app_data()),
            &test_contracts_info(),
            0,
        )
        .unwrap();
        assert_eq!(draft.order.receiver, Address::repeat_byte(0x01));

        let mut response = quote_response(OrderKind::Sell, 1, 100, 0, full_app_data());
        response.quote.receiver = Some(Address::repeat_byte(0x04));
        let draft = build_draft(response, &test_contracts_info(), 0).unwrap();
        assert_eq!(draft.order.receiver, Address::repeat_byte(0x04));
    }

    #[test]
    fn zero_min_out_is_rejected_and_one_atom_rounds_up_not_down() {
        // A zero quoted buy amount can only produce an accept-any-price
        // draft; reject it.
        let result = build_draft(
            quote_response(OrderKind::Sell, 1_000_000, 0, 0, full_app_data()),
            &test_contracts_info(),
            50,
        );
        assert!(matches!(result, Err(DraftError::ZeroMinBuyAmount)));

        // Ceiling rounding keeps a 1-atom quote at 1 atom instead of
        // flooring it to the zero limit.
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1_000_000, 1, 0, full_app_data()),
            &test_contracts_info(),
            50,
        )
        .unwrap();
        assert_eq!(draft.order.buy_amount, U256::from(1u64));
    }

    #[test]
    fn overflowing_slippage_math_is_rejected() {
        let mut response = quote_response(OrderKind::Buy, 0, 3_000_000, 0, full_app_data());
        response.quote.sell_amount = U256::MAX;
        assert!(matches!(
            build_draft(response, &test_contracts_info(), 50),
            Err(DraftError::AmountOverflow)
        ));

        let mut response = quote_response(OrderKind::Sell, 1, 0, 0, full_app_data());
        response.quote.buy_amount = U256::MAX;
        assert!(matches!(
            build_draft(response, &test_contracts_info(), 50),
            Err(DraftError::AmountOverflow)
        ));
    }

    #[test]
    fn app_data_hash_and_full_document_round_trip() {
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1, 100, 0, full_app_data()),
            &test_contracts_info(),
            0,
        )
        .unwrap();
        let full = draft.full_app_data.as_deref().unwrap();
        assert_eq!(full, default_draft_app_data(DEFAULT_SLIPPAGE_BPS));
        // The signed bytes32 is the keccak256 of exactly that document.
        let expected = OrderCreationAppData::Full {
            full: full.to_string(),
        }
        .hash();
        assert_eq!(draft.order.app_data, expected);
        assert_eq!(draft.app_data_hash, expected);

        // A bare-hash quote yields no full document to submit.
        let hash = AppDataHash([0x11; 32]);
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1, 100, 0, OrderCreationAppData::Hash { hash }),
            &test_contracts_info(),
            0,
        )
        .unwrap();
        assert_eq!(draft.full_app_data, None);
        assert_eq!(draft.order.app_data, hash);
    }

    #[test]
    fn signing_envelope_domain_matches_the_boot_domain_separator() {
        let contracts = test_contracts_info();
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1, 100, 0, full_app_data()),
            &contracts,
            0,
        )
        .unwrap();

        let domain = &draft.signing.domain;
        assert_eq!(domain["name"], "Gnosis Protocol");
        assert_eq!(domain["version"], "v2");
        assert_eq!(draft.signing.primary_type, "Order");
        let types = &draft.signing.types["Order"];
        assert_eq!(types.as_array().unwrap().len(), 12);
        assert_eq!(types[0]["name"], "sellToken");
        assert_eq!(types[6], serde_json::json!({"name": "appData", "type": "bytes32"}));

        // Parity vs model::DomainSeparator::new: signing against the served
        // domain produces signatures this orderbook's settlement accepts.
        let recomputed = DomainSeparator::new(
            domain["chainId"].as_u64().unwrap(),
            domain["verifyingContract"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        );
        assert_eq!(recomputed, contracts.domain_separator);
    }

    #[test]
    fn response_serializes_camel_case_with_decimal_string_amounts() {
        let draft = build_draft(
            quote_response(OrderKind::Sell, 1_000_000, 3_000_000, 0, full_app_data()),
            &test_contracts_info(),
            50,
        )
        .unwrap();
        let value = serde_json::to_value(&draft).unwrap();
        assert_eq!(value["order"]["sellAmount"], "1000000");
        assert_eq!(value["order"]["buyAmount"], "2985000");
        assert_eq!(value["order"]["feeAmount"], "0");
        assert_eq!(value["order"]["kind"], "sell");
        assert_eq!(value["order"]["sellTokenBalance"], "erc20");
        assert_eq!(value["order"]["signingScheme"], "eip712");
        assert_eq!(value["slippageBps"], 50);
        assert_eq!(value["quote"]["id"], 42);
        assert!(value["fullAppData"].is_string());
        assert!(
            value["appDataHash"]
                .as_str()
                .unwrap()
                .starts_with("0x")
        );
    }

    #[tokio::test]
    async fn draft_errors_carry_their_frozen_codes() {
        for (err, expected_type, expected_code) in [
            (
                DraftError::SlippageOutOfRange(5001),
                "BadRequest",
                Some(1000),
            ),
            (DraftError::ZeroMinBuyAmount, "ZeroAmount", Some(4006)),
            (
                DraftError::AmountOverflow,
                "SellAmountOverflow",
                Some(4100),
            ),
        ] {
            let response = err.into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body: Error = serde_json::from_slice(&response_body(response).await).unwrap();
            assert_eq!(body.error_type, expected_type);
            assert_eq!(body.code, expected_code);
        }
    }
}
