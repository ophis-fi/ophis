use {
    crate::{
        domain::competition::order::app_data::AppData,
        tests::{
            setup,
            setup::{Solution, ab_order, ab_pool, ab_solution},
        },
    },
    alloy::primitives::Address,
    app_data::{ProtocolAppData, hash_full_app_data},
    std::sync::Arc,
};

/// Even a funded historical order fetched by hash must be removed before /solve.
/// A regular order in the same auction still passes simulation and settles.
#[tokio::test]
#[ignore]
async fn historical_wrapper_order_filtered_before_solver() {
    let protocol = ProtocolAppData {
        wrappers: vec![app_data::WrapperCall {
            address: Address::repeat_byte(1),
            data: vec![],
            is_omittable: true,
        }],
        ..Default::default()
    };
    let document = serde_json::to_string(&app_data::Root::new(Some(protocol.clone()))).unwrap();
    let data = AppData::Full(Arc::new(app_data::ValidatedAppData {
        hash: app_data::AppDataHash(hash_full_app_data(document.as_bytes())),
        document,
        protocol,
    }));
    let test = setup()
        .pool(ab_pool())
        .order(ab_order())
        .order(
            ab_order()
                .rename("historical-wrapper")
                .app_data(data)
                .filtered(),
        )
        // Use the existing settlement buffers: arbitrary pool/token Custom
        // calls are intentionally disallowed on the local chain.
        .solution(Solution {
            use_buffers: true,
            ..ab_solution()
        })
        .done()
        .await;
    let id = test.solve().await.ok().id();
    test.settle(id)
        .await
        .ok()
        .await
        .ab_order_executed(&test)
        .await;
}

/// The solver can fabricate wrappers even when every order has ordinary app data.
/// Neither an EOA nor a contract target may replace the settlement transaction.
#[tokio::test]
#[ignore]
async fn solver_supplied_wrappers_rejected() {
    let mut solution = Solution {
        use_buffers: true,
        ..ab_solution()
    };
    solution.wrappers = vec![solvers_dto::solution::WrapperCall {
        address: Address::repeat_byte(1),
        data: vec![0xde, 0xad],
    }];
    let test = setup()
        .pool(ab_pool())
        .order(ab_order())
        .solution(solution)
        .done()
        .await;
    test.solve().await.err().kind("SolverFailed");
}
