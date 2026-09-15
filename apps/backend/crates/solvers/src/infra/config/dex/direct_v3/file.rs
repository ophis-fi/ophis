use {
    crate::{
        domain::eth,
        infra::{config::dex::file, dex::direct_v3, metrics},
    },
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    chain_id: eth::ChainId,
    venue: String,
}

pub async fn load(path: &Path) -> super::Config {
    let (mut base, config) = file::load::<Config>(path).await;
    // Sources: PancakeSwap developer v3 addresses; Ramses official contract-addresses;
    // Velodrome slipstream README. No quote response can introduce a target.
    let (factory, quoter, router, tick_spacing, tiers, metric, settlement) =
        match (config.chain_id, config.venue.as_str()) {
            (eth::ChainId::Robinhood, "pancakeswap") => (
                "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
                "0x8553AA1615549A86882151784b329B017aA7c832",
                "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
                false,
                vec![100, 500, 2500, 10000],
                metrics::Dex::PancakeSwap,
                "0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD",
            ),
            (eth::ChainId::Robinhood, "ramses") => (
                "0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8",
                "0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6",
                "0xFCBBe2Af83F94e7E2a9C35a535B3A04719aFD2Ae",
                true,
                vec![1, 5, 10, 50, 60, 100, 200],
                metrics::Dex::Ramses,
                "0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD",
            ),
            (eth::ChainId::Optimism, "velodrome-slipstream") => (
                "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F",
                "0x89D8218ed5fF1e46d8dcd33fb0bbeE3be1621466",
                "0x0792a633F0c19c351081CF4B211F68F79bCc9676",
                true,
                vec![1, 5, 10, 50, 60, 100, 200, 2000],
                metrics::Dex::Velodrome,
                "0x310784c7FCE12d578dA6f53460777bAc9718B859",
            ),
            _ => panic!("unsupported direct V3 venue/chain"),
        };
    let parse = |s: &str| s.parse::<eth::Address>().expect("pinned direct V3 address");
    assert_eq!(
        base.contracts.settlement,
        parse(settlement),
        "unexpected direct V3 settlement"
    );
    base.internalize_interactions = false;
    super::Config {
        direct_v3: direct_v3::Config {
            chain_id: config.chain_id as u64,
            node_url: base.node_url.clone(),
            settlement: base.contracts.settlement,
            factory: parse(factory),
            quoter: parse(quoter),
            router: parse(router),
            tick_spacing,
            tiers,
            metric,
        },
        base,
    }
}
