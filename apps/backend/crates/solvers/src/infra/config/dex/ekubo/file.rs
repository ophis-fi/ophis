use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::ekubo},
    },
    serde::Deserialize,
    std::path::Path,
};
const ROUTER: &str = "0x7B2aA7Ecc0B5936b7C52E6259A19C3BA557d0748";
const WETH: &str = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    chain_id: eth::ChainId,
    api: reqwest::Url,
    router: eth::Address,
    wrapped_native: eth::Address,
}
pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    assert_eq!(config.chain_id, eth::ChainId::Robinhood);
    assert_eq!(
        config.router,
        ROUTER.parse::<eth::Address>().unwrap(),
        "unexpected Ekubo router"
    );
    assert_eq!(config.wrapped_native, WETH.parse::<eth::Address>().unwrap(), "unexpected Robinhood WETH");
    base.internalize_interactions = false;
    super::Config {
        ekubo: ekubo::Config {
            api: config.api,
            chain_id: 4663,
            settlement: base.contracts.settlement,
            router: config.router,
            wrapped_native: config.wrapped_native,
        },
        base,
    }
}
