use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::enso},
    },
    serde::Deserialize,
    serde_with::serde_as,
    std::path::Path,
};

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base URL for the Enso API including a trailing slash. Defaults to
    /// `https://api.enso.build/api/v1/`.
    #[serde(default)]
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    endpoint: Option<reqwest::Url>,

    /// Chain ID. Enso keys its endpoints by `chainId`; this solver is verified
    /// on Unichain (130).
    chain_id: eth::ChainId,

    /// Enso Bearer API key. REQUIRED (no anonymous tier). SECRET — rendered
    /// from `${ENSO_API_KEY}` in the gitignored VM .env, never hardcoded. Only
    /// authenticates / lifts rate limits; never the funds path.
    api_key: String,
}

fn default_endpoint() -> reqwest::Url {
    "https://api.enso.build/api/v1/"
        .parse()
        .expect("hard-coded Enso endpoint URL is valid")
}

/// Load the Enso solver configuration from a TOML file.
///
/// # Panics
///
/// This method panics if the config is invalid or on I/O errors.
pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    let endpoint = config.endpoint.unwrap_or_else(default_endpoint);

    super::Config {
        enso: enso::Config {
            base_url: endpoint,
            chain_id: config.chain_id,
            settlement_contract: base.contracts.settlement,
            api_key: config.api_key,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
