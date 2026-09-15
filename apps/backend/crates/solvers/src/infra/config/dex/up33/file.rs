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
    let (factory, router, weth, leaf, metric) = match config.chain_id {
        eth::ChainId::Robinhood => (
            FACTORY,
            ROUTER,
            WETH,
            false,
            crate::infra::metrics::Dex::Up33,
        ),
        eth::ChainId::Optimism => (
            "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a",
            "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858",
            "0x4200000000000000000000000000000000000006",
            false,
            crate::infra::metrics::Dex::Velodrome,
        ),
        eth::ChainId::Unichain => (
            "0x31832f2a97Fd20664D76Cc421207669b55CE4BC0",
            "0x3a63171DD9BebF4D07BC782FECC7eb0b890C2A45",
            "0x4200000000000000000000000000000000000006",
            true,
            crate::infra::metrics::Dex::Velodrome,
        ),
        _ => panic!("unsupported direct Solidly chain"),
    };
    assert_eq!(
        config.factory,
        factory.parse::<eth::Address>().unwrap(),
        "unexpected UP33 factory"
    );
    assert_eq!(
        config.router,
        router.parse::<eth::Address>().unwrap(),
        "unexpected UP33 router"
    );
    assert_eq!(
        config.weth,
        weth.parse::<eth::Address>().unwrap(),
        "unexpected Robinhood WETH"
    );
    base.internalize_interactions = false;
    let provider = blockchain::rpc(&base.node_url).provider;
    super::Config {
        up33: up33::Config {
            provider,
            settlement: base.contracts.settlement,
            weth: config.weth,
            factory: config.factory,
            router: config.router,
            leaf,
            metric,
        },
        base,
    }
}
