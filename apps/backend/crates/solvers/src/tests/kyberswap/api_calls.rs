//! Live `#[ignore]`-gated smoke tests against the public KyberSwap aggregator
//! API. These require network access and are run manually.

use {
    crate::{
        domain::{dex::*, eth::*},
        infra::dex::kyberswap as kyberswap_dex,
    },
    alloy::primitives::address,
};

/// Settlement contract on Optimism (identical on every L2 — deterministic
/// deployment).
const SETTLEMENT_CONTRACT: Address = address!("0x9008d19f58aabd9ed0d60971565aa8510560ab41");

/// KyberSwap MetaAggregationRouterV2 on Optimism mainnet.
const OP_MAINNET_ROUTER: Address = address!("0x6131b5fae19ea4f9d964eac0408e4408b66337b5");

#[ignore]
#[tokio::test]
async fn swap_sell_live_op_mainnet() {
    let config = kyberswap_dex::Config {
        base_url: reqwest::Url::parse("https://aggregator-api.kyberswap.com/optimism/api/v1/")
            .unwrap(),
        chain_id: crate::domain::eth::ChainId::Optimism,
        settlement_contract: SETTLEMENT_CONTRACT,
        client_id: Some("ophis-solver-smoketest".to_string()),
        block_stream: None,
    };

    // WETH → USDC on Optimism.
    let order = Order {
        sell: TokenAddress::from(address!("0x4200000000000000000000000000000000000006")),
        buy: TokenAddress::from(address!("0x0b2c639c533813f4aa9d7837caf62653d097ff85")),
        side: crate::domain::order::Side::Sell,
        amount: Amount::new(U256::from(100_000_000_000_000_000_u128)), // 0.1 WETH
        buy_limit: Default::default(),
        owner: SETTLEMENT_CONTRACT,
    };

    let slippage = Slippage::one_percent();

    let kyberswap = kyberswap_dex::KyberSwap::try_new(config).unwrap();
    let swap = kyberswap.swap(&order, &slippage, false).await.unwrap();

    assert_eq!(swap.input.token, order.sell);
    assert_eq!(swap.output.token, order.buy);
    assert_eq!(swap.allowance.spender, OP_MAINNET_ROUTER);
}

#[ignore]
#[tokio::test]
async fn swap_sell_live_op_sepolia() {
    // OP Sepolia chain ID 11155420 is not in `eth::ChainId`, so we bypass the
    // `chain_slug()` mapping by setting `base_url` explicitly and reusing
    // `ChainId::Optimism` as a placeholder (the value is unused beyond
    // bookkeeping inside the solver).
    let config = kyberswap_dex::Config {
        base_url: reqwest::Url::parse(
            "https://aggregator-api.kyberswap.com/optimism-sepolia/api/v1/",
        )
        .unwrap(),
        chain_id: crate::domain::eth::ChainId::Optimism,
        settlement_contract: SETTLEMENT_CONTRACT,
        client_id: Some("ophis-solver-smoketest".to_string()),
        block_stream: None,
    };

    let kyberswap = kyberswap_dex::KyberSwap::try_new(config).unwrap();
    // Just confirm the client builds; an OP Sepolia sell-order assertion would
    // require known testnet token addresses that are stable over time.
    let _ = kyberswap;
}
