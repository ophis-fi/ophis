use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::openocean},
    },
    serde::Deserialize,
    serde_with::serde_as,
    std::path::Path,
};

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base URL for the OpenOcean v4 API including the chain id segment and a
    /// trailing slash. Defaults to
    /// `https://open-api.openocean.finance/v4/{chain_id}/`.
    #[serde(default)]
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    endpoint: Option<reqwest::Url>,

    /// Chain ID. OpenOcean v4 keys its endpoints by numeric chain id; this
    /// solver is verified on Unichain (130).
    chain_id: eth::ChainId,

    /// Optional OpenOcean `referrer` address for fee attribution. Keyless:
    /// rendered from an env placeholder, never hardcoded. Left unset (no
    /// referral fee) when omitted.
    #[serde(default)]
    referrer: Option<eth::Address>,
}

fn default_endpoint(chain_id: eth::ChainId) -> reqwest::Url {
    // OpenOcean v4 endpoints are keyed by the numeric chain id.
    format!(
        "https://open-api.openocean.finance/v4/{}/",
        chain_id as u64
    )
    .parse()
    .expect("hard-coded OpenOcean endpoint URL is valid")
}

/// Load the OpenOcean solver configuration from a TOML file.
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
        openocean: openocean::Config {
            base_url: endpoint,
            chain_id: config.chain_id,
            settlement_contract: base.contracts.settlement,
            referrer: config.referrer,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
