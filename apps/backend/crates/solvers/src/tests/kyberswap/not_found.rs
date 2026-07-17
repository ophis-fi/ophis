//! Tests that KyberSwap "no route" responses are translated into empty
//! solutions.

use {
    crate::tests::{self, mock},
    serde_json::json,
};

/// Helper that returns the standard sell-order auction payload used by all
/// "no route" assertions in this file.
fn auction() -> serde_json::Value {
    json!({
        "id": "1",
        "tokens": {
            "0xe41d2489571d322189246dafa5ebde1f4699f498": {
                "decimals": 18,
                "symbol": "ZRX",
                "referencePrice": "4327903683155778",
                "availableBalance": "1583034704488033979459",
                "trusted": true,
            },
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": {
                "decimals": 18,
                "symbol": "WETH",
                "referencePrice": "1000000000000000000",
                "availableBalance": "482725140468789680",
                "trusted": true,
            },
        },
        "orders": [
            {
                "uid": "0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a\
                          2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a\
                          2a2a2a2a",
                "sellToken": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                "buyToken": "0xe41d2489571d322189246dafa5ebde1f4699f498",
                "sellAmount": "1000000000000000000",
                "buyAmount": "200000000000000000000",
                "fullSellAmount": "1000000000000000000",
                "fullBuyAmount": "200000000000000000000",
                "kind": "sell",
                "partiallyFillable": false,
                "class": "market",
                "sellTokenSource": "erc20",
                "buyTokenDestination": "erc20",
                "preInteractions": [],
                "postInteractions": [],
                "owner": "0x5b1e2c2762667331bc91648052f646d1b0d35984",
                "validTo": 0,
                "appData": "0x0000000000000000000000000000000000000000000000000000000000000000",
                "signingScheme": "presign",
                "signature": "0x",
            }
        ],
        "liquidity": [],
        "effectiveGasPrice": "15000000000",
        "deadline": "2106-01-01T00:00:00.000Z",
        "surplusCapturingJitOrderOwners": []
    })
}

const ROUTES_PATH: &str = "routes?tokenIn=0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2\
     &tokenOut=0xe41d2489571d322189246dafa5ebde1f4699f498\
     &amountIn=1000000000000000000\
     &saveGas=false\
     &gasInclude=true";

#[tokio::test]
async fn routes_no_route() {
    let api = mock::http::setup(vec![mock::http::Expectation::Get {
        path: mock::http::Path::exact(ROUTES_PATH),
        res: json!({
            "code": 4008,
            "message": "Route not found",
            "data": null
        }),
    }])
    .await;

    let engine = tests::SolverEngine::new("kyberswap", super::config(&api.address)).await;
    let solution = engine.solve(auction()).await;
    assert_eq!(solution, json!({ "solutions": [] }));
}

#[tokio::test]
async fn routes_no_pools() {
    let api = mock::http::setup(vec![mock::http::Expectation::Get {
        path: mock::http::Path::exact(ROUTES_PATH),
        res: json!({
            "code": 4010,
            "message": "No eligible pools found",
            "data": null
        }),
    }])
    .await;

    let engine = tests::SolverEngine::new("kyberswap", super::config(&api.address)).await;
    let solution = engine.solve(auction()).await;
    assert_eq!(solution, json!({ "solutions": [] }));
}

#[tokio::test]
async fn build_fails_after_route() {
    let api = mock::http::setup(vec![
        // Step 1 succeeds.
        mock::http::Expectation::Get {
            path: mock::http::Path::exact(ROUTES_PATH),
            res: json!({
                "code": 0,
                "message": "",
                "data": {
                    "routeSummary": {
                        "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                        "amountIn": "1000000000000000000",
                        "amountInUsd": "3315.55",
                        "tokenOut": "0xe41d2489571d322189246dafa5ebde1f4699f498",
                        "amountOut": "6556259156432631386442",
                        "amountOutUsd": "3308.16",
                        "gas": "200000",
                        "gasPrice": "6756286873",
                        "gasUsd": "0.45",
                        "route": [[]],
                        "routeID": "abc-123",
                        "checksum": "deadbeef",
                        "timestamp": 1700000000
                    },
                    "routerAddress": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"
                }
            }),
        },
        // Step 2 fails — KyberSwap returns 4008 even after producing a route.
        mock::http::Expectation::Post {
            path: mock::http::Path::exact("route/build"),
            req: mock::http::RequestBody::Any,
            res: json!({
                "code": 4008,
                "message": "Route expired or unbuildable",
                "data": null
            }),
        },
    ])
    .await;

    let engine = tests::SolverEngine::new("kyberswap", super::config(&api.address)).await;
    let solution = engine.solve(auction()).await;
    assert_eq!(solution, json!({ "solutions": [] }));
}
