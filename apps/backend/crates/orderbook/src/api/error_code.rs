//! Numeric Ophis API error codes (api-dx, v1 table).
//!
//! Every error body served by this orderbook carries, next to the existing
//! `errorType` string, a numeric `code` from the table below. The v1 table is
//! frozen on owner sign-off: codes are added within their band, existing
//! codes never change meaning, and renaming is a breaking change.
//!
//! Bands:
//! - 1xxx generic API errors (1000 `API_ERROR` is the catch-all for coded
//!   but unclassified request errors; 1001 `NOT_FOUND`; 1029 `RATE_LIMITED`,
//!   emitted on 429 responses by the orderbook-native limiter in
//!   [`super::rate_limit`] together with a `Retry-After` header -- the
//!   limiter ships disabled in every config, so production serves no 1029
//!   until the coordinated docs-table + limiter flip; a 429 is never
//!   retryable within the same call).
//! - 2xxx routing + quoting. 2000 `NO_ROUTE`, 2001 `UNSUPPORTED_TOKEN` and
//!   2002 `INSUFFICIENT_LIQUIDITY` form the unroutable class: they are final
//!   answers ("this trade has no route right now"), not failures, and carry
//!   `data.class = "unroutable"`. 2003-2006 and 2100-2101 are quoting errors.
//! - 3xxx retryable upstream failures. Served as HTTP 503 with a
//!   `Retry-After` header; clients may retry after the indicated delay.
//! - 4xxx order errors: 4001-4018 signature/field validation, 4100-4106
//!   balance + limits, 4200-4204 order lifecycle, 4400 access.
//! - 5xxx internal errors.
//!
//! CoW-hosted chains never return these codes; only the self-hosted
//! orderbook serves them, and SDK clients fall back to `errorType` strings
//! when `code` is absent.

/// The `data.class` marker attached to responses in the unroutable class
/// (codes 2000-2002). Unroutable is an answer, not a failure: the HTTP
/// status stays CoW-client compatible (404 for `NoLiquidity`) and the class
/// is carried in the body instead.
pub const UNROUTABLE_CLASS: &str = "unroutable";

/// The frozen v1 `errorType` -> code table. Multiple `errorType` strings may
/// share a code when they name the same condition (e.g. the `InvalidAppData`
/// and `AppDataInvalid` spellings both map to 4013).
const CODES: &[(&str, u16)] = &[
    // 1xxx: generic API errors.
    ("BadRequest", 1000),
    ("InvalidRequestBody", 1000),
    ("InvalidTradeFilter", 1000),
    ("InvalidLimit", 1000),
    ("MethodNotAllowed", 1000),
    ("SellAmountDoesNotCoverFee", 1000),
    ("OldOrderActivelyBidOn", 1000),
    ("NotFound", 1001),
    ("OrderNotFound", 1001),
    ("RateLimited", 1029),
    // 2xxx: routing + quoting. 2000-2002 form the unroutable class.
    ("NoLiquidity", 2000),
    ("UnsupportedToken", 2001),
    ("InsufficientLiquidity", 2002),
    ("UnsupportedOrderType", 2003),
    ("TradingOutsideAllowedWindow", 2004),
    ("TokenTemporarilySuspended", 2005),
    ("CustomSolverError", 2006),
    ("QuoteNotFound", 2100),
    ("QuoteNotVerified", 2101),
    // 3xxx: retryable upstream failures (503 + Retry-After).
    ("InternalServiceError", 3000),
    ("UpstreamRateLimited", 3100),
    // 4001-4018: signature + field validation.
    ("MissingFrom", 4001),
    ("WrongOwner", 4002),
    ("InvalidSignature", 4003),
    ("InvalidEip1271Signature", 4004),
    ("IncompatibleSigningScheme", 4005),
    ("ZeroAmount", 4006),
    ("SameBuyAndSellToken", 4007),
    ("InvalidNativeSellToken", 4008),
    ("UnsupportedBuyTokenDestination", 4009),
    ("UnsupportedSellTokenSource", 4010),
    ("InsufficientValidTo", 4011),
    ("ExcessiveValidTo", 4012),
    ("InvalidAppData", 4013),
    ("AppDataInvalid", 4013),
    ("AppDataHashMismatch", 4014),
    ("AppDataMismatch", 4015),
    ("AppdataFromMismatch", 4016),
    ("NonZeroFee", 4017),
    ("InvalidQuote", 4018),
    // 4100-4106: balance + limits.
    ("SellAmountOverflow", 4100),
    ("InsufficientBalance", 4101),
    ("InsufficientAllowance", 4102),
    ("TransferSimulationFailed", 4103),
    ("TooManyLimitOrders", 4104),
    ("TooMuchGas", 4105),
    ("PartnerFeeBelowFloor", 4106),
    // 4200-4204: order lifecycle.
    ("DuplicatedOrder", 4200),
    ("AlreadyCancelled", 4201),
    ("OrderFullyExecuted", 4202),
    ("OrderExpired", 4203),
    ("OnChainOrder", 4204),
    // 4400: access.
    ("Forbidden", 4400),
    // 5xxx: internal errors.
    ("InternalServerError", 5000),
    ("MetadataSerializationFailed", 5001),
];

/// The numeric code for an `errorType` string, or `None` for strings outside
/// the v1 table (clients fall back to the string). Only ever called on the
/// error path, so the linear scan is fine.
pub fn code_for(error_type: &str) -> Option<u16> {
    CODES
        .iter()
        .find(|(name, _)| *name == error_type)
        .map(|(_, code)| *code)
}

/// Whether a code belongs to the unroutable class (2000-2002): a final
/// "no route" answer rather than a retryable failure.
pub fn is_unroutable(code: u16) -> bool {
    matches!(code, 2000..=2002)
}

#[cfg(test)]
mod tests {
    use {super::*, std::collections::HashMap};

    /// Every enum member declared under an `errorType:` property anywhere in
    /// openapi.yml.
    fn openapi_error_types() -> Vec<String> {
        let openapi = include_str!("../../openapi.yml");
        let mut out = Vec::new();
        let mut lines = openapi.lines().peekable();
        while let Some(line) = lines.next() {
            if line.trim() != "errorType:" {
                continue;
            }
            while let Some(next) = lines.peek() {
                let trimmed = next.trim();
                if trimmed == "type: string" || trimmed == "enum:" {
                    lines.next();
                } else if let Some(member) = trimmed.strip_prefix("- ") {
                    out.push(member.to_string());
                    lines.next();
                } else {
                    break;
                }
            }
        }
        out
    }

    #[test]
    fn every_openapi_error_type_has_a_code() {
        let error_types = openapi_error_types();
        // Guard against the parser silently matching nothing after an
        // openapi.yml reshuffle: the three error schemas declare 40+ members.
        assert!(
            error_types.len() >= 40,
            "expected to find the openapi errorType enums, got {error_types:?}",
        );
        for error_type in &error_types {
            assert!(
                code_for(error_type).is_some(),
                "openapi errorType {error_type:?} has no entry in the v1 code table",
            );
        }
    }

    #[test]
    fn frozen_anchor_codes() {
        for (error_type, code) in [
            ("NotFound", 1001),
            ("RateLimited", 1029),
            ("NoLiquidity", 2000),
            ("UnsupportedToken", 2001),
            ("InsufficientLiquidity", 2002),
            ("InternalServiceError", 3000),
            ("UpstreamRateLimited", 3100),
            ("InsufficientBalance", 4101),
            ("InsufficientAllowance", 4102),
            ("Forbidden", 4400),
            ("InternalServerError", 5000),
        ] {
            assert_eq!(code_for(error_type), Some(code), "{error_type} anchor");
        }
        assert_eq!(code_for("SomethingNeverSeen"), None);
    }

    #[test]
    fn no_duplicate_error_types_and_codes_stay_in_their_bands() {
        let mut seen = HashMap::new();
        for (error_type, code) in CODES {
            assert!(
                seen.insert(*error_type, *code).is_none(),
                "errorType {error_type:?} appears twice in the table",
            );
            let in_band = matches!(
                code,
                1000 | 1001
                    | 1029
                    | 2000..=2006
                    | 2100..=2101
                    | 3000
                    | 3100
                    | 4001..=4018
                    | 4100..=4106
                    | 4200..=4204
                    | 4400
                    | 5000..=5001
            );
            assert!(in_band, "{error_type} -> {code} is outside the frozen v1 bands");
        }
    }

    #[test]
    fn unroutable_class_is_exactly_the_2000_2002_set() {
        let unroutable: Vec<_> = CODES
            .iter()
            .filter(|(_, code)| is_unroutable(*code))
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            unroutable,
            ["NoLiquidity", "UnsupportedToken", "InsufficientLiquidity"],
        );
        assert!(!is_unroutable(2003));
        assert!(!is_unroutable(1000));
    }
}
