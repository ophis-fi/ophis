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
            // First-party deployment references (2026-09-22):
            // https://developers.uniswap.org/deployments.json (chainId 5042, v3)
            // https://docs.synthra.org/docs/contract-addresses
            // https://docs.achswap.app/technical/contract-addresses/
            (eth::ChainId::Arc, "uniswap-v3") => (
                "0xf0db7b58379503491d857dB50AC9ece64c653918",
                "0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468",
                "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77",
                false,
                // The 100 tier carries cirBTC; 3000 carries WETH. Pool
                // discovery is cached, and quotes always use a fresh snapshot.
                vec![100, 500, 3000, 10000],
                metrics::Dex::UniswapV3,
                "",
            ),
            // https://archery.wtf/docs/security — Arc Mainnet, not its QA deployment.
            (eth::ChainId::Arc, "archery") => (
                "0xc481038c013fe96f38ce7a2dc417b2b1b78b16a4",
                "0xc6b5c6056c4be2de1c014695a7ccb75087a1c574",
                "0x3b37e67c973683f7fe8a0f304dedfaf475fec138",
                true,
                vec![1, 10, 50],
                metrics::Dex::Archery,
                "",
            ),
            (eth::ChainId::Arc, "synthra") => (
                "0x6307fc239C7964942c1BfFE51930E55606619c74",
                "0x9c179A7335B3fc841F59Aa6a62daf6d5c61b65D7",
                "0xa50eDe66a573eE5bB37E28AF5789B76aE5FEb828",
                false,
                vec![100, 500],
                metrics::Dex::Synthra,
                "",
            ),
            (eth::ChainId::Arc, "achswap") => (
                "0xaE54BF4C8078BaAAf7e17f8e01659Ea470a989FC",
                "0x659Da32F3F10566bDB6B55Ad84c182f1D00Ba058",
                "0xEA0129203FBB99ebEea3f78B2d05b924f17FB556",
                false,
                vec![100, 500],
                metrics::Dex::AchSwap,
                "",
            ),
            _ => panic!("unsupported direct V3 venue/chain"),
        };
    let parse = |s: &str| s.parse::<eth::Address>().expect("pinned direct V3 address");
    if config.chain_id == eth::ChainId::Arc {
        // The driver independently binds calldata to its configured settlement.
        assert!(
            !base.contracts.settlement.is_zero(),
            "missing Arc settlement"
        );
    } else {
        assert_eq!(
            base.contracts.settlement,
            parse(settlement),
            "unexpected direct V3 settlement"
        );
    }
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
            legacy_router: config.chain_id == eth::ChainId::Arc && config.venue == "achswap",
            tiers,
            metric,
        },
        base,
    }
}
