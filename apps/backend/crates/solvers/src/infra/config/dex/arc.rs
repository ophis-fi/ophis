use {
    super::file,
    crate::{domain::eth, infra::dex::arc::Venue},
    serde::Deserialize,
    std::path::Path,
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct File {
    chain_id: eth::ChainId,
    venue: Venue,
}

pub async fn load(path: &Path) -> (super::Config, Venue) {
    let (mut base, config) = file::load::<File>(path).await;
    assert_eq!(
        config.chain_id,
        eth::ChainId::Arc,
        "Arc direct routes are Arc-only"
    );
    assert!(
        !base.contracts.settlement.is_zero(),
        "missing Arc settlement"
    );
    assert_eq!(
        base.wrapped_native,
        shared::arc_routes::USDC,
        "Arc uses native USDC, not WETH"
    );
    base.internalize_interactions = false;
    (base, config.venue)
}
