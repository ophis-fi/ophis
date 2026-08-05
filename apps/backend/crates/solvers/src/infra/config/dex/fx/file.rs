use {
    crate::{
        domain::eth,
        infra::{blockchain, config::dex::file, dex::fx},
    },
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    fxusd: eth::Address,
    #[serde(default = "default_balance_slot")]
    balance_slot: eth::U256,
}

pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    // F(x) redemption must execute onchain so its minOut protects the actual
    // fulfillment. Buffer internalization would skip the call and is therefore
    // never valid for this lane, regardless of the shared default.
    base.internalize_interactions = false;
    let provider = blockchain::rpc(&base.node_url).provider;
    super::Config {
        fx: fx::Config {
            provider,
            settlement: base.contracts.settlement,
            fxusd: config.fxusd,
            balance_slot: config.balance_slot,
        },
        base,
    }
}

fn default_balance_slot() -> eth::U256 {
    eth::U256::from(151)
}
