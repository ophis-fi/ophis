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

    /// Optional Odos referral code for partner attribution / volume
    /// monetization. Never affects the funds path.
    #[serde(default)]
    referral_code: Option<u64>,

    /// Optional Odos API key, sent as the `x-api-key` header. The anonymous
    /// tier is too rate-limited to participate, so a free-plan key is
    /// effectively required. SECRET — render from `${ODOS_API_KEY}` (in the
    /// gitignored VM .env), never hardcode a value. Never affects the funds
    /// path (auth / rate-limit only).
    #[serde(default)]
    api_key: Option<String>,
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
            // Treat an empty `api-key` as absent. The TOML renders the key from
            // ${ODOS_API_KEY}; if that env var is unset, envsubst yields
            // `api-key = ""`, which would otherwise send an empty `x-api-key`
            // header (worse than the anonymous path). Coerce "" -> None so a
            // missing key falls back cleanly to the anonymous tier.
            api_key: config.api_key.filter(|k| !k.is_empty()),
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
