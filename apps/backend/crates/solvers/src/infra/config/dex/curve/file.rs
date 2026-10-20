use {
    crate::{
        domain::eth,
        infra::{blockchain, config::dex::file, dex::curve},
    },
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Pool {
    address: eth::Address,
    coins: Vec<eth::Address>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    pools: Vec<Pool>,
}

pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    // Curve swaps must execute: the reported floor is enforced by pool
    // calldata and cannot be replaced with a Settlement buffer transfer.
    base.internalize_interactions = false;
    let provider = blockchain::rpc(&base.node_url).provider;
    super::Config {
        curve: curve::Config {
            provider,
            pools: config
                .pools
                .into_iter()
                .map(|pool| curve::Pool {
                    address: pool.address,
                    coins: pool.coins,
                })
                .collect(),
        },
        base,
    }
}
