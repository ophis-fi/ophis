use {
    crate::{
        domain::{dex::MarketOutputSimulation, eth},
        infra::{config::dex::file, dex::elfomo},
    },
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    chain_id: eth::ChainId,
}

pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    base.internalize_interactions = false;
    base.output_guard.strict_output_simulation = true;
    base.output_guard.strict_market_output_simulation = MarketOutputSimulation::All;
    super::Config {
        elfomo: elfomo::Config {
            node_url: base.node_url.clone(),
            chain_id: config.chain_id as u64,
            settlement: base.contracts.settlement,
        },
        base,
    }
}
