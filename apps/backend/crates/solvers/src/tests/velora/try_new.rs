//! Unit tests for the Velora solver constructor.
//!
//! These don't require network or mock servers — they exercise the
//! pre-flight validation logic (chain support + partner-fee
//! consistency) which is one of the M1-style hardening features that
//! must not regress.

use {
    crate::{
        domain::eth::ChainId,
        infra::dex::velora::{self, Config, CreationError, Velora},
    },
    alloy::primitives::address,
};

/// Settlement contract on Optimism (identical on every CoW chain —
/// deterministic deployment).
const SETTLEMENT: alloy::primitives::Address =
    address!("0x9008d19f58aabd9ed0d60971565aa8510560ab41");

fn make_config(chain_id: ChainId) -> Config {
    Config {
        base_url: reqwest::Url::parse("https://api.paraswap.io/").unwrap(),
        chain_id,
        settlement_contract: SETTLEMENT,
        partner: Some("ophis-test".to_string()),
        partner_address: None,
        partner_fee_bps: None,
        block_stream: None,
    }
}

#[test]
fn try_new_succeeds_on_optimism() {
    // Velora supports chain 10 (Optimism) — try_new must succeed.
    let config = make_config(ChainId::Optimism);
    let _ = Velora::try_new(config).map_err(|e| panic!("Velora must accept Optimism, got {e:?}"));
}

#[test]
fn try_new_succeeds_on_mainnet() {
    let config = make_config(ChainId::Mainnet);
    assert!(
        Velora::try_new(config).is_ok(),
        "Velora must accept Mainnet"
    );
}

#[test]
fn try_new_succeeds_on_base() {
    let config = make_config(ChainId::Base);
    assert!(Velora::try_new(config).is_ok(), "Velora must accept Base");
}

#[test]
fn try_new_succeeds_on_arbitrum() {
    let config = make_config(ChainId::ArbitrumOne);
    assert!(
        Velora::try_new(config).is_ok(),
        "Velora must accept ArbitrumOne"
    );
}

#[test]
fn try_new_succeeds_on_polygon() {
    let config = make_config(ChainId::Polygon);
    assert!(
        Velora::try_new(config).is_ok(),
        "Velora must accept Polygon"
    );
}

#[test]
fn try_new_succeeds_on_bnb() {
    let config = make_config(ChainId::Bnb);
    assert!(Velora::try_new(config).is_ok(), "Velora must accept Bnb");
}

#[test]
fn try_new_succeeds_on_avalanche() {
    let config = make_config(ChainId::Avalanche);
    assert!(
        Velora::try_new(config).is_ok(),
        "Velora must accept Avalanche"
    );
}

#[test]
fn try_new_succeeds_on_gnosis() {
    let config = make_config(ChainId::Gnosis);
    assert!(Velora::try_new(config).is_ok(), "Velora must accept Gnosis");
}

#[test]
fn try_new_rejects_hyperevm() {
    // Velora does NOT support chain 999 (HyperEVM) — try_new must reject.
    // This guard is the entire reason for fail-fast chain validation:
    // without it the solver would silently return NotFound for every
    // auction and burn solver-competition slots on a dead route.
    //
    // Verified upstream: GET https://api.paraswap.io/tokens/999
    // returns {"error": "Invalid network. Supported chains: 1, 10,
    // 56, 100, 130, 137, 146, 8453, 42161, 43114"}.
    let config = make_config(ChainId::HyperEvm);
    let result = Velora::try_new(config);
    let err = match result {
        Ok(_) => panic!("expected HL to be rejected"),
        Err(e) => e,
    };
    match err {
        CreationError::UnsupportedChain(999) => (),
        other => panic!("expected UnsupportedChain(999), got {other:?}"),
    }
}

#[test]
fn try_new_rejects_linea() {
    // Linea (59144) — present in CoW's ChainId enum but not in Velora.
    let config = make_config(ChainId::Linea);
    let err = match Velora::try_new(config) {
        Ok(_) => panic!("expected Linea to be rejected"),
        Err(e) => e,
    };
    match err {
        CreationError::UnsupportedChain(59144) => (),
        other => panic!("expected UnsupportedChain(59144), got {other:?}"),
    }
}

#[test]
fn try_new_rejects_plasma() {
    // Plasma (9745) — listed in Velora docs but their /tokens/9745
    // endpoint currently 503s ("partially deployed"). Until that stabilizes
    // we treat it as unsupported. If Velora finishes the deployment, add
    // `9745` to VELORA_SUPPORTED_CHAINS.
    let config = make_config(ChainId::Plasma);
    let err = match Velora::try_new(config) {
        Ok(_) => panic!("expected Plasma to be rejected"),
        Err(e) => e,
    };
    match err {
        CreationError::UnsupportedChain(9745) => (),
        other => panic!("expected UnsupportedChain(9745), got {other:?}"),
    }
}

#[test]
fn try_new_rejects_partial_partner_fee_address_only() {
    // partner-fee without bps is ambiguous to Velora (silently ignored).
    // Refuse at startup so the operator sees the misconfig.
    let mut config = make_config(ChainId::Optimism);
    config.partner_address = Some(SETTLEMENT);
    config.partner_fee_bps = None;
    let err = match Velora::try_new(config) {
        Ok(_) => panic!("expected partial partner-fee to be rejected"),
        Err(e) => e,
    };
    assert!(
        matches!(err, CreationError::PartialPartnerFee),
        "expected PartialPartnerFee, got {err:?}"
    );
}

#[test]
fn try_new_rejects_partial_partner_fee_bps_only() {
    let mut config = make_config(ChainId::Optimism);
    config.partner_address = None;
    config.partner_fee_bps = Some(25);
    let err = match Velora::try_new(config) {
        Ok(_) => panic!("expected partial partner-fee to be rejected"),
        Err(e) => e,
    };
    assert!(
        matches!(err, CreationError::PartialPartnerFee),
        "expected PartialPartnerFee, got {err:?}"
    );
}

#[test]
fn try_new_accepts_both_partner_fee_fields() {
    let mut config = make_config(ChainId::Optimism);
    config.partner_address = Some(SETTLEMENT);
    config.partner_fee_bps = Some(25);
    assert!(
        Velora::try_new(config).is_ok(),
        "both fields set — must succeed"
    );
}

#[test]
fn try_new_accepts_neither_partner_fee_field() {
    let config = make_config(ChainId::Optimism);
    // already None / None in default — must succeed.
    assert!(
        Velora::try_new(config).is_ok(),
        "neither fee field set — must succeed"
    );
}

// Smoke check that the public re-exports needed by tests/run.rs are
// reachable from outside the velora module. If a future refactor
// accidentally makes Config / Velora / CreationError pub(crate) only,
// this compiles-as-a-check.
#[test]
fn types_are_public() {
    let _: fn(Config) -> Result<Velora, CreationError> = velora::Velora::try_new;
}
