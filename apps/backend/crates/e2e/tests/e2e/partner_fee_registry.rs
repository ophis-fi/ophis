use {
    ::alloy::primitives::{Address, U256},
    configs::{partner_fee_registry::PartnerFeeRegistryConfig, test_util::TestDefault},
    e2e::setup::*,
    ethrpc::alloy::CallBuilderExt,
    model::{
        fee_policy::FeePolicy,
        order::{OrderCreation, OrderCreationAppData, OrderKind},
        signature::EcdsaSigningScheme,
    },
    number::units::EthUnit,
    reqwest::StatusCode,
    serde_json::json,
    shared::web3::Web3,
    std::time::Duration,
};

#[tokio::test]
#[ignore]
async fn local_node_provisioned_registry() {
    run_test(provisioned_registry).await;
}

async fn provisioned_registry(web3: Web3) {
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
    let recipient = Address::repeat_byte(0xab);
    let suspended = Address::repeat_byte(0xcd);
    let unregistered = Address::repeat_byte(0xef);
    for (address, label, status) in [
        (recipient, "provisioned-partner", "active"),
        (suspended, "suspended-partner", "suspended"),
    ] {
        sqlx::query(
            "INSERT INTO partner_fee_recipients (recipient, label, max_volume_bps, status) \
             VALUES ($1, $2, 75, $3::PartnerFeeStatus)",
        )
        .bind(address.as_slice())
        .bind(label)
        .bind(status)
        .execute(services.db())
        .await
        .unwrap();
    }
    let registry = PartnerFeeRegistryConfig {
        refresh_interval: Duration::from_millis(100),
        registry_enabled: true,
        registration_enabled: false,
        ..Default::default()
    };
    services
        .start_protocol_with_args(
            configs::autopilot::Configuration {
                partner_fee_registry: registry.clone(),
                ..configs::autopilot::Configuration::test("test_solver", solver.address())
            },
            configs::orderbook::Configuration {
                partner_fee_registry: registry,
                ..configs::orderbook::Configuration::test_default()
            },
            solver,
        )
        .await;

    let partners = format!("{API_HOST}/api/v1/partners");
    let registered = services
        .client()
        .get(format!("{partners}/{recipient:#x}"))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), StatusCode::OK);
    let registered: serde_json::Value = registered.json().await.unwrap();
    assert_eq!(registered["maxVolumeBps"], 75);
    let response = services
        .client()
        .post(&partners)
        .json(&json!({
            "recipient": unregistered, "label": "must-not-register",
            "issuedAt": model::time::now_in_epoch_seconds(), "signature": "0x"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["errorType"],
        "PartnerRegistrationDisabled"
    );
    assert_eq!(
        services
            .client()
            .get(format!("{partners}/{unregistered:#x}"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    let document = |recipient: Address, bps: u64| {
        json!({"metadata":{"partnerFee":[{
            "recipient":recipient,"volumeBps":bps
        }]}})
        .to_string()
    };
    let allowed = document(recipient, 75);
    services.put_app_data(None, &allowed).await.unwrap();
    for rejected in [
        document(recipient, 76),
        document(suspended, 75),
        document(unregistered, 75),
    ] {
        assert_eq!(
            services.put_app_data(None, &rejected).await.unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }
    let order = OrderCreation {
        sell_token: *weth.address(),
        sell_amount: 10u64.eth(),
        buy_token: *token.address(),
        buy_amount: 5u64.eth(),
        valid_to: model::time::now_in_epoch_seconds() + 300,
        kind: OrderKind::Sell,
        app_data: OrderCreationAppData::Full { full: allowed },
        ..Default::default()
    }
    .sign(
        EcdsaSigningScheme::Eip712,
        &onchain.contracts().domain_separator,
        &trader.signer,
    );
    let uid = services.create_order(&order).await.unwrap();
    // Prove autopilot's live snapshot reaches the driver and actual settlement,
    // rather than merely accepting the recipient at orderbook ingress.
    wait_for_condition(TIMEOUT, || async {
        onchain.mint_block().await;
        services
            .get_trades(&uid)
            .await
            .unwrap_or_default()
            .iter()
            .any(|trade| {
                trade.executed_protocol_fees.iter().any(|fee| {
                    fee.policy == FeePolicy::Volume { factor: 0.0075 } && fee.amount > U256::ZERO
                })
            })
    })
    .await
    .unwrap();
    assert!(token.balanceOf(trader.address()).call().await.unwrap() >= 5u64.eth());

    sqlx::query("UPDATE partner_fee_recipients SET status = 'suspended' WHERE recipient = $1")
        .bind(recipient.as_slice())
        .execute(services.db())
        .await
        .unwrap();
    wait_for_condition(TIMEOUT, || async {
        services
            .put_app_data(None, &document(recipient, 74))
            .await
            .is_err_and(|(status, _)| status == StatusCode::BAD_REQUEST)
    })
    .await
    .unwrap();
}
