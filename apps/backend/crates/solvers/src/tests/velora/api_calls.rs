//! Live `#[ignore]`-gated smoke tests against the public Velora aggregator
//! API. These require network access and are run manually:
//!
//!     cargo test -p solvers tests::velora::api_calls -- --ignored
//!
//! They exist to catch upstream API regressions early — Velora has
//! historically renamed endpoints (v5→v6.2), changed default versions,
//! and shifted partner-fee semantics. Run before each prod deploy.

use {
    crate::{
        domain::{dex::*, eth::*, order},
        infra::dex::velora as velora_dex,
    },
    alloy::primitives::{address, U256},
};

/// CoW Settlement contract — same address on every CoW chain.
const SETTLEMENT_CONTRACT: Address =
    address!("0x9008d19f58aabd9ed0d60971565aa8510560ab41");

/// Augustus V6.2 router — same address on every Velora-supported chain.
const AUGUSTUS_V6_2_ROUTER: alloy::primitives::Address =
    address!("0x6a000f20005980200259b80c5102003040001068");

#[ignore]
#[tokio::test]
async fn swap_sell_live_op_mainnet() {
    let config = velora_dex::Config {
        base_url: reqwest::Url::parse("https://api.paraswap.io/").unwrap(),
        chain_id: ChainId::Optimism,
        settlement_contract: SETTLEMENT_CONTRACT,
        partner: Some("ophis-smoketest".to_string()),
        partner_address: None,
        partner_fee_bps: None,
        block_stream: None,
    };

    // WETH → USDC on Optimism. Same canonical pair the KyberSwap smoke
    // test uses — easy to cross-compare quotes.
    let order = Order {
        sell: TokenAddress::from(address!("0x4200000000000000000000000000000000000006")),
        buy: TokenAddress::from(address!("0x0b2c639c533813f4aa9d7837caf62653d097ff85")),
        side: order::Side::Sell,
        amount: Amount::new(U256::from(100_000_000_000_000_000_u128)), // 0.1 WETH
        owner: SETTLEMENT_CONTRACT,
    };

    let slippage = Slippage::one_percent();

    let velora = match velora_dex::Velora::try_new(config) {
        Ok(v) => v,
        Err(e) => panic!("Velora try_new failed: {e:?}"),
    };
    let swap = match velora.swap(&order, &slippage).await {
        Ok(s) => s,
        Err(e) => panic!("Velora swap failed: {e:?}"),
    };

    assert_eq!(swap.input.token, order.sell);
    assert_eq!(swap.output.token, order.buy);
    // M1 hardening: the allowance spender MUST be the Augustus V6.2 router
    // address — any other address is rejected by validate_router_allowlist.
    assert_eq!(swap.allowance.spender, AUGUSTUS_V6_2_ROUTER);
}

#[ignore]
#[tokio::test]
async fn try_new_unsupported_chain_does_not_call_api() {
    // Velora doesn't support chain 999 (HyperEVM). This test confirms
    // the fail-fast guard runs entirely client-side — no network call
    // happens before the rejection. The test passes if try_new returns
    // immediately with UnsupportedChain.
    let start = std::time::Instant::now();
    let config = velora_dex::Config {
        base_url: reqwest::Url::parse("https://api.paraswap.io/").unwrap(),
        chain_id: ChainId::HyperEvm,
        settlement_contract: SETTLEMENT_CONTRACT,
        partner: None,
        partner_address: None,
        partner_fee_bps: None,
        block_stream: None,
    };

    let err = match velora_dex::Velora::try_new(config) {
        Ok(_) => panic!("HL must be rejected"),
        Err(e) => e,
    };
    let elapsed = start.elapsed();

    // The guard is constant-time-ish (linear in VELORA_SUPPORTED_CHAINS,
    // currently 10 entries). 50 ms is a generous ceiling — if we ever
    // see this exceed 50 ms it means a network call slipped in.
    assert!(
        elapsed < std::time::Duration::from_millis(50),
        "try_new took {elapsed:?} — too slow for a pure-CPU validation. \
         A network call may have leaked in."
    );
    match err {
        velora_dex::CreationError::UnsupportedChain(999) => (),
        other => panic!("expected UnsupportedChain(999), got {other:?}"),
    }
}
