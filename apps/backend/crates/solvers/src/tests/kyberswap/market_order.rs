//! This test ensures that the KyberSwap solver properly handles market sell
//! orders, turning KyberSwap aggregator responses into CoW Protocol solutions.

use {
    crate::tests::{self, mock},
    serde_json::json,
};

#[tokio::test]
async fn sell() {
    let api = mock::http::setup(vec![
        // Step 1: GET /routes
        mock::http::Expectation::Get {
            path: mock::http::Path::exact(
                "routes?tokenIn=0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2\
                 &tokenOut=0xe41d2489571d322189246dafa5ebde1f4699f498\
                 &amountIn=1000000000000000000\
                 &saveGas=false\
                 &gasInclude=true",
            ),
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
                        "route": [
                            [
                                {
                                    "pool": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                                    "tokenOut": "0xe41d2489571d322189246dafa5ebde1f4699f498",
                                    "swapAmount": "1000000000000000000",
                                    "amountOut": "6556259156432631386442",
                                    "exchange": "uniswap-v3",
                                    "poolType": "uni-v3",
                                    "extra": null
                                }
                            ]
                        ],
                        "routeID": "abc-123",
                        "checksum": "deadbeef",
                        "timestamp": 1700000000
                    },
                    "routerAddress": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"
                }
            }),
        },
        // Step 2: POST /route/build
        mock::http::Expectation::Post {
            path: mock::http::Path::exact("route/build"),
            req: mock::http::RequestBody::Partial(
                json!({
                    "sender": "0x9008d19f58aabd9ed0d60971565aa8510560ab41",
                    "recipient": "0x9008d19f58aabd9ed0d60971565aa8510560ab41",
                    "slippageTolerance": 100,
                    "enableGasEstimation": false,
                    // Echo verbatim — codex 2026-05-13 review: the previous
                    // approach excluded the entire routeSummary from the
                    // assertion, which made the most KyberSwap-specific
                    // invariant (echo correctness) untested. Now we assert
                    // the full routeSummary structure round-trips. Values
                    // mirror step-1's mocked response exactly.
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
                        "route": [
                            [
                                {
                                    "pool": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                                    "tokenIn": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                                    "tokenOut": "0xe41d2489571d322189246dafa5ebde1f4699f498",
                                    "swapAmount": "1000000000000000000",
                                    "amountOut": "6556259156432631386442",
                                    "exchange": "uniswap-v3",
                                    "poolType": "uni-v3",
                                    "extra": null
                                }
                            ]
                        ],
                        "routeID": "abc-123",
                    },
                }),
                // Exclude only the fields the plan permits to vary in echo —
                // timestamp moves between step-1 and step-2 calls, checksum
                // is a hash that depends on KyberSwap's internal state.
                vec![
                    "routeSummary.timestamp",
                    "routeSummary.checksum",
                    "deadline",
                ],
            ),
            res: json!({
                "code": 0,
                "message": "",
                "data": {
                    "amountIn": "1000000000000000000",
                    "amountOut": "6556259156432631386442",
                    "gas": "200000",
                    "data": "0x0d5f0e3b00000000000000000001a0cf2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000015fdc8278903f7f31c10000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000100000000000000000000000014424eeecbff345b38187d0b8b749e56faa68539",
                    "routerAddress": "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"
                }
            }),
        },
    ])
    .await;

    let engine = tests::SolverEngine::new("kyberswap", super::config(&api.address)).await;

    let solution = engine
        .solve(json!({
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
        }))
        .await;

    // 200_000 padded by 50% = 300_000, plus gas_offset of 106_391 = 406_391.
    assert_eq!(
        solution,
        json!({
            "solutions": [
                {
                    "gas": 406391,
                    "id": 0,
                    "interactions": [
                        {
                            "allowances": [
                                {
                                    "amount": "1000000000000000000",
                                    "spender": "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
                                    "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
                                }
                            ],
                            "callData": "0x0d5f0e3b00000000000000000001a0cf2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000015fdc8278903f7f31c10000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000100000000000000000000000014424eeecbff345b38187d0b8b749e56faa68539",
                            "inputs": [
                                {
                                    "amount": "1000000000000000000",
                                    "token": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
                                }
                            ],
                            "internalize": false,
                            "kind": "custom",
                            "outputs": [
                                {
                                    // Guaranteed slippage floor (amountOut 6556259156432631386442
                                    // * (10000 - 100bps) / 10000), not the optimistic quote — the
                                    // settlement pays this exact buy amount, so it must be <= the
                                    // router's realized output. See min_return_amount in kyberswap/mod.rs.
                                    "amount": "6490696564868305072577",
                                    "token": "0xe41d2489571d322189246dafa5ebde1f4699f498"
                                }
                            ],
                            "target": "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
                            "value": "0"
                        }
                    ],
                    "postInteractions": [],
                    "preInteractions": [],
                    "prices": {
                        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "6490696564868305072577",
                        "0xe41d2489571d322189246dafa5ebde1f4699f498": "1000000000000000000"
                    },
                    "trades": [
                        {
                            "executedAmount": "1000000000000000000",
                            "kind": "fulfillment",
                            "order": "0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a"
                        }
                    ]
                }
            ]
        }),
    );
}

#[tokio::test]
async fn buy_not_supported() {
    let api = mock::http::setup(vec![]).await;

    let engine = tests::SolverEngine::new("kyberswap", super::config(&api.address)).await;

    let solution = engine
        .solve(json!({
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
                    "kind": "buy",
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
        }))
        .await;

    // Buy orders (exactOut) are not supported by KyberSwap.
    assert_eq!(solution, json!({ "solutions": [] }),);
}
