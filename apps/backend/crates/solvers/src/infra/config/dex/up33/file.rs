use {
    crate::{
        domain::eth,
        infra::{blockchain, config::dex::file, dex::up33},
    },
    serde::Deserialize,
    std::path::Path,
};

const FACTORY: &str = "0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28";
const ROUTER: &str = "0xf5198743240fAC98db71868F34c70139b1eb0474";
const WETH: &str = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    chain_id: eth::ChainId,
    weth: eth::Address,
    factory: eth::Address,
    router: eth::Address,
}

pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    assert_eq!(config.chain_id, eth::ChainId::Robinhood);
    assert_eq!(
        config.factory,
        FACTORY.parse::<eth::Address>().unwrap(),
        "unexpected UP33 factory"
    );
    assert_eq!(
        config.router,
        ROUTER.parse::<eth::Address>().unwrap(),
        "unexpected UP33 router"
    );
    assert_eq!(config.weth, WETH.parse::<eth::Address>().unwrap(), "unexpected Robinhood WETH");
    base.internalize_interactions = false;
    let provider = blockchain::rpc(&base.node_url).provider;
    super::Config {
        up33: up33::Config {
            provider,
            settlement: base.contracts.settlement,
            weth: config.weth,
            factory: config.factory,
            router: config.router,
        },
        base,
    }
}
