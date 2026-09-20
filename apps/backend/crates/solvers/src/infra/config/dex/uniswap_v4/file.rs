use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::uniswap_v4},
    },
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    chain_id: eth::ChainId,
    #[serde(default)]
    fables: bool,
    adapter: eth::Address,
    quoter: eth::Address,
    wrapped_native: eth::Address,
    stablecoin: eth::Address,
    pool_fee: u32,
    tick_spacing: i32,
}

pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    assert!(
        matches!(
            config.chain_id,
            eth::ChainId::Optimism | eth::ChainId::Robinhood | eth::ChainId::Unichain
        ),
        "direct Uniswap V4 lane is restricted to configured Ophis deployments"
    );
    assert!(
        config.pool_fee < 1_000_000 || (config.fables && config.pool_fee == 0x800000),
        "V4 pool fee must be static and below 100%"
    );
    assert!(
        (1..=32_767).contains(&config.tick_spacing),
        "V4 tick spacing is outside PoolManager bounds"
    );
    assert!(
        !config.fables || config.chain_id == eth::ChainId::Robinhood,
        "Fables is Robinhood-only"
    );
    let mut expected = match config.chain_id {
        eth::ChainId::Optimism => (
            "0x833fa253e3a0cb2be15f14cb0b0ad0c17dd57b12",
            "0x1f3131a13296fb91c90870043742c3cdbff1a8d7",
            "0x4200000000000000000000000000000000000006",
            "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
        ),
        eth::ChainId::Unichain => (
            "0xe490d7ac34cdf92a3bd16cd4ca3bb1f1a6671828",
            "0x333e3c607b141b18ff6de9f258db6e77fe7491e0",
            "0x4200000000000000000000000000000000000006",
            "0x078d782b760474a361dda0af3839290b0ef57ad6",
        ),
        eth::ChainId::Robinhood => (
            "0xb0f223b932b6c2a5cb6e3a6b04aab82b44ea7c29",
            "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
            "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
            "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        ),
        _ => unreachable!("chain was restricted above"),
    };
    if config.fables {
        expected.0 = "0xc35fe0dbabd82f9e347cf6a7d9c795a18c902fbe";
    }
    let parse = |address: &str| address.parse::<eth::Address>().expect("pinned V4 address");
    assert_eq!(config.adapter, parse(expected.0), "unexpected V4 adapter");
    assert_eq!(config.quoter, parse(expected.1), "unexpected V4 quoter");
    assert_eq!(
        config.wrapped_native,
        parse(expected.2),
        "unexpected wrapped-native token"
    );
    assert_eq!(
        config.stablecoin,
        parse(expected.3),
        "unexpected V4 quote token"
    );
    assert_eq!(
        config.pool_fee,
        if config.fables { 0x800000 } else { 500 },
        "unexpected V4 pool fee"
    );
    assert_eq!(config.tick_spacing, 10, "unexpected V4 tick spacing");
    super::Config {
        uniswap_v4: uniswap_v4::Config {
            chain_id: config.chain_id as u64,
            node_url: base.node_url.clone(),
            quoter: config.quoter,
            adapter: config.adapter,
            wrapped_native: config.wrapped_native,
            stablecoin: config.stablecoin,
            pool_fee: config.pool_fee,
            tick_spacing: config.tick_spacing,
            hook: if config.fables {
                parse("0x06a889870C8f83640D6816319f72e2aA579b6080")
            } else {
                eth::Address::ZERO
            },
            metric: if config.fables {
                crate::infra::metrics::Dex::Fables
            } else {
                crate::infra::metrics::Dex::UniswapV4
            },
        },
        base,
    }
}
