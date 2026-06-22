use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::kyberswap},
    },
    serde::Deserialize,
    serde_with::serde_as,
    std::path::Path,
};

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base URL for the KyberSwap aggregator API including the chain slug.
    /// Defaults to `https://aggregator-api.kyberswap.com/{chain_slug}/api/v1/`
    /// where `chain_slug` is derived from `chain-id`.
    #[serde(default)]
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    endpoint: Option<reqwest::Url>,

    /// Chain ID. KyberSwap supports a fixed set of EVM chains (see
    /// [`chain_slug`]).
    chain_id: eth::ChainId,

    /// Optional `x-client-id` header sent with every request. Recommended to
    /// avoid aggressive rate limiting.
    #[serde(default)]
    client_id: Option<String>,
}

/// Maps a CoW [`eth::ChainId`] to KyberSwap's URL path component.
///
/// Reference: <https://docs.kyberswap.com/Aggregator/aggregator-api#chain>.
fn chain_slug(chain_id: eth::ChainId) -> &'static str {
    match chain_id {
        eth::ChainId::Mainnet => "ethereum",
        eth::ChainId::Optimism => "optimism",
        eth::ChainId::ArbitrumOne => "arbitrum",
        eth::ChainId::Base => "base",
        eth::ChainId::Polygon => "polygon",
        eth::ChainId::Bnb => "bsc",
        eth::ChainId::Avalanche => "avalanche",
        eth::ChainId::Linea => "linea",
        // KyberSwap slug for Hyperliquid HyperEVM — verified live 2026-05-15:
        // GET https://aggregator-api.kyberswap.com/hyperevm/api/v1/routes
        // returns real routes for WHYPE→USD₮0.
        eth::ChainId::HyperEvm => "hyperevm",
        // KyberSwap slug for Unichain — verified live 2026-06-22:
        // GET https://aggregator-api.kyberswap.com/unichain/api/v1/routes
        // returns real Uniswap-v4 routes for USDC→WETH on chain 130.
        eth::ChainId::Unichain => "unichain",
        // KyberSwap doesn't deploy on Gnosis / Goerli / Plasma / Ink in v1 —
        // panic clearly rather than silently picking a wrong slug.
        other => panic!("unsupported KyberSwap chain: {other:?}"),
    }
}

fn default_endpoint(chain_id: eth::ChainId) -> reqwest::Url {
    format!(
        "https://aggregator-api.kyberswap.com/{}/api/v1/",
        chain_slug(chain_id)
    )
    .parse()
    .expect("hard-coded KyberSwap endpoint URL is valid")
}

/// Load the KyberSwap solver configuration from a TOML file.
///
/// # Panics
///
/// This method panics if the config is invalid or on I/O errors.
pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    let endpoint = config
        .endpoint
        .unwrap_or_else(|| default_endpoint(config.chain_id));

    super::Config {
        kyberswap: kyberswap::Config {
            base_url: endpoint,
            chain_id: config.chain_id,
            settlement_contract: base.contracts.settlement,
            client_id: config.client_id,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
