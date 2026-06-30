use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::odos},
    },
    serde::Deserialize,
    serde_with::serde_as,
    std::path::Path,
};

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base URL for the Odos SOR API. Defaults to `https://api.odos.xyz/`.
    /// The chain is encoded in the request body (`chainId`), not the URL.
    #[serde(default = "default_endpoint")]
    #[serde_as(as = "serde_with::DisplayFromStr")]
    endpoint: reqwest::Url,

    /// Chain ID. Odos validates it server-side; this solver is deployed for
    /// Unichain (130) but the field is generic.
    chain_id: eth::ChainId,

    /// Optional Odos referral code for higher rate limits / partner
    /// attribution. Anonymous (rate-limited) usage leaves this unset. Never
    /// affects the funds path. Rendered from an env placeholder in the TOML so
    /// no value is hardcoded.
    #[serde(default)]
    referral_code: Option<u64>,
}

fn default_endpoint() -> reqwest::Url {
    "https://api.odos.xyz/"
        .parse()
        .expect("hard-coded Odos endpoint URL is valid")
}

/// Load the Odos solver configuration from a TOML file.
///
/// # Panics
///
/// This method panics if the config is invalid or on I/O errors.
pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;

    super::Config {
        odos: odos::Config {
            base_url: config.endpoint,
            chain_id: config.chain_id,
            settlement_contract: base.contracts.settlement,
            referral_code: config.referral_code,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
