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
            eth::ChainId::Optimism | eth::ChainId::Robinhood
        ),
        "direct Uniswap V4 lane is restricted to configured Ophis deployments"
    );
    assert!(
        config.pool_fee < 1_000_000,
        "V4 pool fee must be static and below 100%"
    );
    assert!(
        (1..=32_767).contains(&config.tick_spacing),
        "V4 tick spacing is outside PoolManager bounds"
    );
    let expected = match config.chain_id {
        eth::ChainId::Optimism => (
            "0xd882da9cb91eb458337413e5846824cdcadb2ddc",
            "0x1f3131a13296fb91c90870043742c3cdbff1a8d7",
            "0x4200000000000000000000000000000000000006",
            "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
        ),
        eth::ChainId::Robinhood => (
            "0x8573c5fcf5bd890f4edd4a41e783eac552b307ae",
            "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
            "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
            "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
        ),
        _ => unreachable!("chain was restricted above"),
    };
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
    assert_eq!(config.pool_fee, 500, "unexpected V4 pool fee");
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
        },
        base,
    }
}
