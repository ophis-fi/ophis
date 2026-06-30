use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::lifi},
    },
    serde::Deserialize,
    serde_with::serde_as,
    std::path::Path,
};

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base URL for the LI.FI API including a trailing slash. Defaults to
    /// `https://li.quest/v1/`. The chain is sent per-request (fromChain /
    /// toChain), not encoded in the URL.
    #[serde(default)]
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    endpoint: Option<reqwest::Url>,

    /// Chain ID. LI.FI keys routes by numeric chain id; this solver is verified
    /// on Unichain (130).
    chain_id: eth::ChainId,

    /// Required LI.FI `integrator` string (LI.FI rejects quotes without one).
    /// Identifies our integration and does not affect calldata correctness;
    /// defaults to `"ophis"`.
    #[serde(default = "default_integrator")]
    integrator: String,
}

fn default_endpoint() -> reqwest::Url {
    "https://li.quest/v1/"
        .parse()
        .expect("hard-coded LI.FI endpoint URL is valid")
}

fn default_integrator() -> String {
    "ophis".to_string()
}

/// Load the LI.FI solver configuration from a TOML file.
///
/// # Panics
///
/// This method panics if the config is invalid or on I/O errors.
pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    let endpoint = config.endpoint.unwrap_or_else(default_endpoint);

    // Coerce an empty `integrator` back to the default. `#[serde(default)]` only
    // fills the ABSENT case; a TOML that renders `integrator` from an env
    // placeholder yields `integrator = ""` via envsubst when the var is unset,
    // and LI.FI 404s every quote without a non-empty integrator: a silent,
    // total lane outage that looks like "no routes" rather than a config error.
    let integrator = if config.integrator.trim().is_empty() {
        default_integrator()
    } else {
        config.integrator
    };

    super::Config {
        lifi: lifi::Config {
            base_url: endpoint,
            chain_id: config.chain_id,
            settlement_contract: base.contracts.settlement,
            integrator,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
