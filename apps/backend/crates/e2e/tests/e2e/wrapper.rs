use {
    ::alloy::primitives::U256,
    e2e::setup::*,
    ethrpc::alloy::CallBuilderExt,
    model::{
        order::{OrderCreation, OrderCreationAppData, OrderKind},
        signature::EcdsaSigningScheme,
    },
    number::units::EthUnit,
    shared::web3::Web3,
};

#[tokio::test]
#[ignore]
async fn local_node_unsupported_wrappers() {
    run_test(unsupported_wrappers).await;
}

async fn unsupported_wrappers(web3: Web3) {
    let mut onchain = OnchainComponents::deploy(web3).await;
    let [solver] = onchain.make_solvers(100u64.eth()).await;
    let [trader] = onchain.make_accounts(100u64.eth()).await;
    let [token] = onchain
        .deploy_tokens_with_weth_uni_v2_pools(300_000u64.eth(), 1_000u64.eth())
        .await;
    let weth = &onchain.contracts().weth;
    weth.deposit()
        .from(trader.address())
        .value(20u64.eth())
        .send_and_watch()
        .await
        .unwrap();
    weth.approve(onchain.contracts().allowance, U256::MAX)
        .from(trader.address())
        .send_and_watch()
        .await
        .unwrap();
    let services = Services::new(&onchain).await;
    services.start_protocol(solver).await;
    let order = OrderCreation {
        sell_token: *weth.address(),
        sell_amount: 10u64.eth(),
        buy_token: *token.address(),
        buy_amount: 5u64.eth(),
        valid_to: model::time::now_in_epoch_seconds() + 300,
        kind: OrderKind::Sell,
        ..Default::default()
    };
    for omittable in [false, true] {
        let document = serde_json::json!({"metadata":{"wrappers":[{
            "address": trader.address(), "data":"0x", "isOmittable":omittable
        }]}})
        .to_string();
        let wrapped = OrderCreation {
            app_data: OrderCreationAppData::Full { full: document },
            ..order.clone()
        }
        .sign(
            EcdsaSigningScheme::Eip712,
            &onchain.contracts().domain_separator,
            &trader.signer,
        );
        let (status, body) = services.create_order(&wrapped).await.unwrap_err();
        assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
        assert!(body.contains("wrappers are not supported"), "{body}");
    }
    // A failed wrapper submission must not disrupt regular driver -> solver -> settlement.
    let order = order.sign(
        EcdsaSigningScheme::Eip712,
        &onchain.contracts().domain_separator,
        &trader.signer,
    );
    let uid = services.create_order(&order).await.unwrap();
    onchain.mint_block().await;
    wait_for_condition(TIMEOUT, || async {
        onchain.mint_block().await;
        !services
            .get_trades(&uid)
            .await
            .unwrap_or_default()
            .is_empty()
    })
    .await
    .unwrap();
    assert!(token.balanceOf(trader.address()).call().await.unwrap() >= 5u64.eth());
}
