use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::velora},
    },
    alloy::primitives::Address,
    serde::Deserialize,
    serde_with::serde_as,
    std::path::Path,
};

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base URL for the Velora API. Defaults to `https://api.paraswap.io/`.
    /// Despite the rebrand from ParaSwap to Velora, the API host remains
    /// `paraswap.io` (the SDK constant has not been updated and there's no
    /// redirect from api.velora.xyz). Pin explicitly.
    #[serde(default = "default_endpoint")]
    #[serde_as(as = "serde_with::DisplayFromStr")]
    endpoint: reqwest::Url,

    /// Chain ID. Validated against VELORA_SUPPORTED_CHAINS at Velora::try_new.
    chain_id: eth::ChainId,

    /// Optional `partner` identifier for analytics / partner-fee. Defaults
    /// to `ophis`.
    #[serde(default)]
    partner: Option<String>,

    /// Optional partner-fee recipient. Must be set together with
    /// `partner-fee-bps` (Velora silently ignores half-config; we refuse
    /// it at solver startup for clarity).
    #[serde(default)]
    partner_address: Option<Address>,

    /// Optional partner-fee in basis points (1 bp = 0.01%). Velora caps
    /// at 200 bps in Delta-intent context.
    #[serde(default)]
    partner_fee_bps: Option<u32>,
}

fn default_endpoint() -> reqwest::Url {
    "https://api.paraswap.io/"
        .parse()
        .expect("hard-coded Velora endpoint URL is valid")
}

/// Load the Velora solver configuration from a TOML file.
///
/// # Panics
///
/// This method panics if the config is invalid or on I/O errors.
pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;

    super::Config {
        velora: velora::Config {
            base_url: config.endpoint,
            chain_id: config.chain_id,
            settlement_contract: base.contracts.settlement,
            partner: config.partner,
            partner_address: config.partner_address,
            partner_fee_bps: config.partner_fee_bps,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
