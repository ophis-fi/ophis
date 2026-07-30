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
    #[serde(default = "default_quoter")]
    quoter: eth::Address,
    #[serde(default = "default_wrapped_native")]
    wrapped_native: eth::Address,
    #[serde(default = "default_stablecoin")]
    stablecoin: eth::Address,
}

fn default_quoter() -> eth::Address {
    "0x8dc178efb8111bb0973dd9d722ebeff267c98f94"
        .parse()
        .expect("valid Robinhood V4Quoter")
}

fn default_wrapped_native() -> eth::Address {
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
        .parse()
        .expect("valid Robinhood WETH")
}

fn default_stablecoin() -> eth::Address {
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
        .parse()
        .expect("valid Robinhood USDG")
}

pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    assert_eq!(
        config.chain_id,
        eth::ChainId::Robinhood,
        "direct Uniswap V4 lane is restricted to Robinhood"
    );
    super::Config {
        uniswap_v4: uniswap_v4::Config {
            node_url: base.node_url.clone(),
            quoter: config.quoter,
            adapter: config.adapter,
            wrapped_native: config.wrapped_native,
            stablecoin: config.stablecoin,
        },
        base,
    }
}
