use {
    crate::{
        domain::eth,
        infra::{blockchain, config::dex::file, dex::pons},
    },
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    weth: eth::Address,
    factories: Vec<eth::Address>,
    v3_factory: eth::Address,
    router: eth::Address,
    quoter: eth::Address,
}

pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    let provider = blockchain::rpc(&base.node_url).provider;
    super::Config {
        pons: pons::Config {
            provider,
            settlement: base.contracts.settlement,
            weth: config.weth,
            factories: config.factories,
            v3_factory: config.v3_factory,
            router: config.router,
            quoter: config.quoter,
        },
        base,
    }
}
