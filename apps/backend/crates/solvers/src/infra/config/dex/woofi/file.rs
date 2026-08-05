use {
    crate::infra::{blockchain, config::dex::file, dex::woofi},
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    router: alloy::primitives::Address,
}

pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    base.internalize_interactions = false;
    let provider = blockchain::rpc(&base.node_url).provider;
    super::Config {
        woofi: woofi::Config {
            provider,
            settlement: base.contracts.settlement,
            router: config.router,
        },
        base,
    }
}
