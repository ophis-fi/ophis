use {
    crate::{
        domain::{dex::MarketOutputSimulation, eth},
        infra::{config::dex::file, dex::metric},
    },
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    chain_id: eth::ChainId,
}

/// Router, quoter, pools and tokens are pinned in `shared::metric`; the file
/// can only select the chain those deployments belong to.
pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    assert!(
        config.chain_id == eth::ChainId::Robinhood,
        "Metric lane is restricted to Robinhood"
    );
    assert_eq!(
        base.contracts.settlement,
        "0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD"
            .parse::<eth::Address>()
            .unwrap(),
        "unexpected Metric settlement"
    );
    // The driver binds this lane to one direct interaction; every MARKET sell
    // proves delivery in simulation rather than trusting buffer reports.
    base.internalize_interactions = false;
    base.output_guard.strict_output_simulation = true;
    base.output_guard.strict_market_output_simulation = MarketOutputSimulation::All;
    super::Config {
        metric: metric::Config {
            node_url: base.node_url.clone(),
            settlement: base.contracts.settlement,
        },
        base,
    }
}
