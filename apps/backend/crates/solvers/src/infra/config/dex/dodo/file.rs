use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::dodo},
    },
    serde::Deserialize,
    serde_with::serde_as,
    std::path::Path,
};

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base endpoint for the DODO route-service `getdodoroute` call. Defaults to
    /// the public DODO route-service endpoint; the chain is selected per-request
    /// via the `chainId` query parameter, so a single endpoint serves all
    /// chains.
    #[serde(default)]
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    endpoint: Option<reqwest::Url>,

    /// Chain ID. DODO route-service supports a fixed set of EVM chains; on
    /// Ophis this is 130 (Unichain).
    chain_id: eth::ChainId,

    /// Optional public DODO widget API key. Rate-limit / attribution only,
    /// carries no funds-moving authority. Defaults to DODO's public widget key
    /// ([`dodo::DEFAULT_APIKEY`]) when omitted. Render this from an env
    /// placeholder in the TOML if you want to supply your own; never hardcode a
    /// private key.
    #[serde(default)]
    apikey: Option<String>,
}

/// Default DODO route-service endpoint (the full `getdodoroute` path). The chain
/// is selected per-request via the `chainId` query parameter.
fn default_endpoint() -> reqwest::Url {
    "https://api.dodoex.io/route-service/v2/widget/getdodoroute"
        .parse()
        .expect("hard-coded DODO endpoint URL is valid")
}

/// Convert the configured [`eth::ChainId`] to its numeric value for the
/// `chainId` query parameter.
fn numeric_chain_id(chain_id: eth::ChainId) -> u64 {
    chain_id
        .network_id()
        .parse::<u64>()
        .expect("ChainId::network_id is always a decimal integer")
}

/// Load the DODO solver configuration from a TOML file.
///
/// # Panics
///
/// This method panics if the config is invalid or on I/O errors.
pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    let endpoint = config.endpoint.unwrap_or_else(default_endpoint);

    super::Config {
        dodo: dodo::Config {
            base_url: endpoint,
            chain_id: numeric_chain_id(config.chain_id),
            settlement_contract: base.contracts.settlement,
            apikey: config.apikey,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
