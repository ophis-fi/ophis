use {
    crate::{PriceEstimating, PriceEstimationError, Query},
    alloy::primitives::Address,
    bigdecimal::{BigDecimal, ToPrimitive},
    futures::FutureExt,
    model::order::OrderKind,
    number::nonzero::NonZeroU256,
    std::{
        sync::{Arc, LazyLock},
        time::{Duration, Instant},
    },
    tracing::instrument,
};

mod coingecko;
mod eip4626;
pub mod fallback;
mod forwarder;
mod oneinch;
mod uniswap_v3;

pub use self::{
    coingecko::CoinGecko, eip4626::Eip4626, fallback::FallbackNativePriceEstimator,
    forwarder::Forwarder, oneinch::OneInch, uniswap_v3::UniswapV3,
};

pub type NativePrice = f64;
pub type NativePriceEstimateResult = Result<NativePrice, PriceEstimationError>;

/// Convert from normalized price to floating point price
pub fn from_normalized_price(price: BigDecimal) -> Option<f64> {
    static ONE_E18: LazyLock<BigDecimal> = LazyLock::new(|| BigDecimal::try_from(1e18).unwrap());

    // Divide by 1e18 to reverse the multiplication by 1e18
    let normalized_price = price / ONE_E18.clone();

    // Convert U256 to f64
    let normalized_price = normalized_price.to_f64()?;

    // Ensure the price is in the normal float range
    normalized_price.is_normal().then_some(normalized_price)
}

/// Convert from floating point price to normalized price
pub fn to_normalized_price(price: f64) -> Option<alloy::primitives::U256> {
    let uint_max = 2.0_f64.powi(256);

    let price_in_eth = 1e18 * price;
    (price_in_eth.is_normal() && price_in_eth >= 1. && price_in_eth < uint_max)
        .then_some(alloy::primitives::U256::saturating_from(price_in_eth))
}

#[cfg_attr(any(test, feature = "test-util"), mockall::automock)]
pub trait NativePriceEstimating: Send + Sync {
    /// Like `PriceEstimating::estimate`.
    ///
    /// Prices are denominated in native token (i.e. the amount of native token
    /// that is needed to buy 1 unit of the specified token).
    fn estimate_native_price(
        &self,
        token: Address,
        timeout: Duration,
    ) -> futures::future::BoxFuture<'_, NativePriceEstimateResult>;
}

/// Wrapper around price estimators specialized to estimate a token's price
/// compared to the current chain's native token.
pub struct NativePriceEstimator {
    inner: Arc<dyn PriceEstimating>,
    native_token: Address,
    price_estimation_amount: NonZeroU256,
    native_token_unit_scale: u64,
}

impl NativePriceEstimator {
    pub fn new(
        inner: Arc<dyn PriceEstimating>,
        native_token: Address,
        price_estimation_amount: NonZeroU256,
        native_token_unit_scale: u64,
    ) -> Self {
        Self {
            inner,
            native_token,
            price_estimation_amount,
            native_token_unit_scale,
        }
    }

    /// Why SELL not BUY: aggregator solvers (KyberSwap, OKX, ParaSwap V6,
    /// Velora) are exactIn-only and refuse any BUY-side query with
    /// `OrderNotSupported`. Upstream CoW preferred BUY for conservative
    /// "shallow liquidity" pricing, but on aggregator-only chains (HyperEVM,
    /// future LL-style L1s) that approach yields zero native prices and
    /// breaks every quote. SELL direction is the only path that works
    /// against aggregator APIs. For chains that DO have AMM-shape pools
    /// (UniV3 reader, CoinGecko), SELL quotes are still accurate within
    /// 0.5% — the TODO's "shallow liquidity" advantage was theoretical.
    fn query(&self, token: &Address, timeout: Duration) -> Query {
        // Arc's configured amount is in six-decimal USDC. Spend that native
        // token amount so an 18-decimal asset is not priced with a dust sale.
        let (sell_token, buy_token) = if self.native_token_unit_scale != 1 {
            (self.native_token, *token)
        } else {
            (*token, self.native_token)
        };
        Query {
            sell_token,
            buy_token,
            in_amount: self.price_estimation_amount,
            kind: OrderKind::Sell,
            verification: Default::default(),
            block_dependent: false,
            timeout,
        }
    }
}

impl NativePriceEstimating for NativePriceEstimator {
    #[instrument(skip_all)]
    fn estimate_native_price(
        &self,
        token: Address,
        timeout: Duration,
    ) -> futures::future::BoxFuture<'_, NativePriceEstimateResult> {
        async move {
            let started = Instant::now();
            let scaled_native = self.native_token_unit_scale != 1;
            // Arc first sizes a token sale with a native-USDC probe. Reserve
            // half the deadline for that sale, independently for each driver.
            let mut query =
                Arc::new(self.query(&token, if scaled_native { timeout / 2 } else { timeout }));
            let mut estimate = if scaled_native {
                tokio::time::timeout(query.timeout, self.inner.estimate(query.clone()))
                    .await
                    .map_err(|_| {
                        PriceEstimationError::EstimatorInternal(anyhow::anyhow!(
                            "native price sizing probe timed out"
                        ))
                    })?
            } else {
                self.inner.estimate(query.clone()).await
            };
            if scaled_native {
                let in_amount = match estimate {
                    Ok(estimate) => {
                        NonZeroU256::try_from(estimate.out_amount).unwrap_or(NonZeroU256::ONE)
                    }
                    Err(PriceEstimationError::NoLiquidity) => NonZeroU256::ONE,
                    Err(error) => return Err(error),
                };
                let remaining = timeout.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    return Err(PriceEstimationError::NoLiquidity);
                }
                // Always value liquidation proceeds. This avoids quantization
                // from inverting coarse outputs and preserves max-price ranking.
                // ponytail: two quotes per cold price; the native-price cache
                // amortizes them without another metadata RPC or retry loop.
                query = Arc::new(Query {
                    sell_token: token,
                    buy_token: self.native_token,
                    in_amount,
                    timeout: remaining,
                    ..(*query).clone()
                });
                estimate = tokio::time::timeout(remaining, self.inner.estimate(query.clone()))
                    .await
                    .map_err(|_| {
                        PriceEstimationError::EstimatorInternal(anyhow::anyhow!(
                            "native price reverse probe timed out"
                        ))
                    })?;
            }
            let estimate = estimate?;
            let ratio = estimate.price_in_buy_token_f64(&query);
            let price = ratio * self.native_token_unit_scale as f64;
            if is_price_malformed(price) {
                let err = anyhow::anyhow!("estimator returned malformed price: {price}");
                Err(PriceEstimationError::EstimatorInternal(err))
            } else {
                Ok(price)
            }
        }
        .boxed()
    }
}

pub(crate) fn is_price_malformed(price: f64) -> bool {
    !price.is_normal()
        || price <= 0.
        // To convert the f64 native price into a format usable in the auction
        // the autopilot calls `to_normalized_price()`. Orders placed using a
        // native price that fails this conversion will likely time out because
        // the autopilot will not put them into the auction. To prevent that we
        // already check the conversion here.
        || to_normalized_price(price).is_none()
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{Estimate, HEALTHY_PRICE_ESTIMATION_TIME, MockPriceEstimating},
        crate::{
            competition::{CompetitionEstimator, PriceRanking},
            sanitized::SanitizedPriceEstimator,
        },
        alloy::primitives::{Address, U256},
        bad_tokens::list_based::DenyListedTokens,
        std::str::FromStr,
    };

    #[tokio::test]
    async fn arc_prices_are_native_atoms_per_erc20_atom() {
        let mut inner = MockPriceEstimating::new();
        inner.expect_estimate().times(2).returning(|query| {
            assert_ne!(query.sell_token, query.buy_token);
            assert_eq!(query.in_amount.get(), U256::from(1_000_000));
            assert_eq!(query.kind, OrderKind::Sell);
            async {
                Ok(Estimate {
                    out_amount: U256::from(1_000_000),
                    gas: 0,
                    solver: Address::repeat_byte(1),
                    verified: false,
                    execution: Default::default(),
                })
            }
            .boxed()
        });
        let estimator = NativePriceEstimator::new(
            Arc::new(inner),
            Address::with_last_byte(7),
            NonZeroU256::try_from(U256::from(1_000_000)).unwrap(),
            chain::Chain::Arc.native_token_unit_scale(),
        );
        let price = estimator
            .estimate_native_price(Address::with_last_byte(3), HEALTHY_PRICE_ESTIMATION_TIME)
            .await
            .unwrap();
        assert_eq!(price, 1e12);
        let normalized = to_normalized_price(price).unwrap();
        let expected = U256::from(10).pow(U256::from(30));
        // Reference prices use f64; allow rounding, never a 10^12 unit error.
        assert!(normalized.abs_diff(expected) < U256::from(10).pow(U256::from(15)));
    }

    #[tokio::test]
    async fn arc_prices_mixed_decimals_and_rejects_invalid_outputs() {
        // One USDC buys two 6-decimal tokens, 1,000 satoshis, or 0.0005 WETH.
        for (output, expected) in [
            (U256::from(2_000_000), Some(5e11)),
            (U256::from(1_000), Some(1e15)),
            (U256::from(500_000_000_000_000u64), Some(2e3)),
            (U256::ZERO, None),
            (U256::MAX, None),
        ] {
            let mut inner = MockPriceEstimating::new();
            inner.expect_estimate().times(2).returning(move |query| {
                let native_input = query.sell_token == Address::with_last_byte(7);
                assert_eq!(
                    query.in_amount.get(),
                    if native_input {
                        U256::from(1_000_000)
                    } else {
                        output.max(U256::ONE)
                    }
                );
                async move {
                    Ok(Estimate {
                        out_amount: if native_input || output.is_zero() {
                            output
                        } else {
                            U256::from(1_000_000)
                        },
                        gas: 0,
                        solver: Address::repeat_byte(1),
                        verified: false,
                        execution: Default::default(),
                    })
                }
                .boxed()
            });
            let estimator = NativePriceEstimator::new(
                Arc::new(inner),
                Address::with_last_byte(7),
                NonZeroU256::try_from(U256::from(1_000_000)).unwrap(),
                chain::Chain::Arc.native_token_unit_scale(),
            );
            let result = estimator
                .estimate_native_price(Address::with_last_byte(3), HEALTHY_PRICE_ESTIMATION_TIME)
                .await;
            match expected {
                Some(expected) => assert!((result.unwrap() / expected - 1.).abs() < 1e-12),
                None => assert!(matches!(
                    result,
                    Err(PriceEstimationError::EstimatorInternal(_))
                )),
            }
        }
    }

    #[tokio::test]
    async fn arc_prices_low_decimal_tokens_with_one_bounded_fallback() {
        for zero_output in [false, true] {
            let mut inner = MockPriceEstimating::new();
            inner
                .expect_estimate()
                .times(1)
                .withf(|query| query.sell_token == Address::with_last_byte(7))
                .returning(move |_| {
                    async move {
                        if zero_output {
                            Ok(Estimate::default())
                        } else {
                            Err(PriceEstimationError::NoLiquidity)
                        }
                    }
                    .boxed()
                });
            inner
                .expect_estimate()
                .times(1)
                .withf(|query| query.sell_token == Address::with_last_byte(3))
                .returning(|query| {
                    assert_eq!(query.buy_token, Address::with_last_byte(7));
                    assert_eq!(query.in_amount, NonZeroU256::ONE);
                    assert!(query.timeout <= HEALTHY_PRICE_ESTIMATION_TIME);
                    async {
                        Ok(Estimate {
                            out_amount: U256::from(10_000_000),
                            ..Default::default()
                        })
                    }
                    .boxed()
                });
            let estimator = NativePriceEstimator::new(
                Arc::new(inner),
                Address::with_last_byte(7),
                NonZeroU256::try_from(U256::from(1_000_000)).unwrap(),
                chain::Chain::Arc.native_token_unit_scale(),
            );
            let price = estimator
                .estimate_native_price(Address::with_last_byte(3), HEALTHY_PRICE_ESTIMATION_TIME)
                .await
                .unwrap();
            assert_eq!(price, 1e19); // One indivisible token costs ten native USDC.
        }
    }

    #[tokio::test]
    async fn arc_does_not_retry_rate_limits_or_exhausted_deadlines() {
        for timeout in [Duration::ZERO, HEALTHY_PRICE_ESTIMATION_TIME] {
            let mut inner = MockPriceEstimating::new();
            inner.expect_estimate().times(1).returning(move |_| {
                async move {
                    Err(if timeout.is_zero() {
                        PriceEstimationError::NoLiquidity
                    } else {
                        PriceEstimationError::RateLimited
                    })
                }
                .boxed()
            });
            let estimator = NativePriceEstimator::new(
                Arc::new(inner),
                Address::with_last_byte(7),
                NonZeroU256::ONE,
                chain::Chain::Arc.native_token_unit_scale(),
            );
            let result = estimator
                .estimate_native_price(Address::with_last_byte(3), timeout)
                .await;
            assert!(matches!(
                result,
                Err(PriceEstimationError::NoLiquidity | PriceEstimationError::RateLimited)
            ));
        }
    }

    fn arc_driver(inner: MockPriceEstimating) -> Arc<dyn NativePriceEstimating> {
        Arc::new(NativePriceEstimator::new(
            Arc::new(SanitizedPriceEstimator::new(
                Arc::new(inner),
                Address::with_last_byte(7),
                DenyListedTokens::new(vec![]),
                true,
            )),
            Address::with_last_byte(7),
            NonZeroU256::try_from(U256::from(1_000_000)).unwrap(),
            chain::Chain::Arc.native_token_unit_scale(),
        ))
    }

    #[tokio::test]
    async fn arc_competes_on_reverse_prices_and_handles_coarse_outputs() {
        for (outputs, reverse_outputs, expected) in [
            ([500_000u64, 1_000_000], [400_000u64, 900_000], 9e11),
            ([1, 1], [500_000, 600_000], 6e17),
            ([998, 999], [899_100, 999_000], 1e15),
            ([0, 0], [9_000_000, 10_000_000], 1e19),
        ] {
            let drivers = outputs
                .into_iter()
                .zip(reverse_outputs)
                .enumerate()
                .map(|(i, (output, reverse_output))| {
                    let mut inner = MockPriceEstimating::new();
                    inner.expect_estimate().times(2).returning(move |query| {
                        let native_input = query.sell_token == Address::with_last_byte(7);
                        assert_eq!(
                            query.in_amount.get(),
                            U256::from(if native_input {
                                1_000_000
                            } else {
                                output.max(1)
                            })
                        );
                        assert!(query.timeout <= HEALTHY_PRICE_ESTIMATION_TIME);
                        async move {
                            Ok(Estimate {
                                out_amount: U256::from(if native_input {
                                    output
                                } else {
                                    reverse_output
                                }),
                                gas: 100,
                                ..Default::default()
                            })
                        }
                        .boxed()
                    });
                    (i.to_string(), arc_driver(inner))
                })
                .collect();
            let estimator = CompetitionEstimator::new(vec![drivers], PriceRanking::MaxOutAmount);
            assert_eq!(
                estimator
                    .estimate_native_price(
                        Address::with_last_byte(3),
                        HEALTHY_PRICE_ESTIMATION_TIME
                    )
                    .await
                    .unwrap(),
                expected
            );
            // Native USDC identity never calls a driver.
            assert_eq!(
                estimator
                    .estimate_native_price(
                        Address::with_last_byte(7),
                        HEALTHY_PRICE_ESTIMATION_TIME
                    )
                    .await
                    .unwrap(),
                1e12
            );
        }
    }

    #[tokio::test]
    async fn arc_reverse_probes_survive_other_lane_errors_and_preserve_stages() {
        for scenario in 0..4 {
            let mut good = MockPriceEstimating::new();
            good.expect_estimate().times(2).returning(|query| {
                async move {
                    Ok(Estimate {
                        out_amount: if query.sell_token == Address::with_last_byte(7) {
                            U256::ZERO
                        } else {
                            U256::from(600_000)
                        },
                        ..Default::default()
                    })
                }
                .boxed()
            });
            let mut other = MockPriceEstimating::new();
            if scenario == 3 {
                other.expect_estimate().times(0);
            } else {
                other.expect_estimate().times(1).returning(move |query| {
                    async move {
                        match scenario {
                            0 => Err(PriceEstimationError::RateLimited),
                            1 => Err(PriceEstimationError::EstimatorInternal(anyhow::anyhow!(
                                "failed"
                            ))),
                            _ => {
                                // Even an estimator ignoring its timeout is bounded.
                                tokio::time::sleep(query.timeout * 4).await;
                                Err(PriceEstimationError::NoLiquidity)
                            }
                        }
                    }
                    .boxed()
                });
            }
            let good = ("good".to_string(), arc_driver(good));
            let other = ("other".to_string(), arc_driver(other));
            let stages = if scenario == 3 {
                vec![vec![good], vec![other]]
            } else {
                vec![vec![good, other]]
            };
            let mut estimator = CompetitionEstimator::new(stages, PriceRanking::MaxOutAmount);
            if scenario == 3 {
                estimator = estimator.with_early_return(1.try_into().unwrap());
            }
            assert_eq!(
                estimator
                    .estimate_native_price(Address::with_last_byte(3), Duration::from_millis(100))
                    .await
                    .unwrap(),
                6e17
            );
        }
    }

    #[tokio::test]
    async fn arc_never_uses_forward_price_when_reverse_fails() {
        for stalled in [false, true] {
            let mut inner = MockPriceEstimating::new();
            inner.expect_estimate().times(2).returning(move |query| {
                async move {
                    if query.sell_token == Address::with_last_byte(7) {
                        Ok(Estimate {
                            out_amount: U256::from(1_000_000),
                            ..Default::default()
                        })
                    } else if stalled {
                        tokio::time::sleep(query.timeout * 4).await;
                        Ok(Estimate {
                            out_amount: U256::from(1_000_000),
                            ..Default::default()
                        })
                    } else {
                        Err(PriceEstimationError::RateLimited)
                    }
                }
                .boxed()
            });
            let result = arc_driver(inner)
                .estimate_native_price(Address::with_last_byte(3), Duration::from_millis(100))
                .await;
            if stalled {
                assert!(matches!(
                    result,
                    Err(PriceEstimationError::EstimatorInternal(_))
                ));
            } else {
                assert!(matches!(result, Err(PriceEstimationError::RateLimited)));
            }
        }
    }

    #[tokio::test]
    async fn arc_rejects_unresolved_prices_when_deadline_is_exhausted() {
        let mut inner = MockPriceEstimating::new();
        inner.expect_estimate().times(1).returning(|_| {
            async {
                Ok(Estimate {
                    out_amount: U256::ONE,
                    ..Default::default()
                })
            }
            .boxed()
        });
        let estimator = NativePriceEstimator::new(
            Arc::new(inner),
            Address::with_last_byte(7),
            NonZeroU256::try_from(U256::from(1_000_000)).unwrap(),
            chain::Chain::Arc.native_token_unit_scale(),
        );
        assert!(matches!(
            estimator
                .estimate_native_price(Address::with_last_byte(3), Duration::ZERO)
                .await,
            Err(PriceEstimationError::NoLiquidity)
        ));
    }

    #[tokio::test]
    async fn prices_dont_get_modified() {
        let mut inner = MockPriceEstimating::new();
        inner.expect_estimate().times(1).returning(|query| {
            assert!(query.buy_token == Address::with_last_byte(7));
            assert!(query.sell_token == Address::with_last_byte(3));
            async {
                Ok(Estimate {
                    out_amount: U256::from(123_456_789_000_000_000u128),
                    gas: 0,
                    solver: Address::repeat_byte(1),
                    verified: false,
                    execution: Default::default(),
                })
            }
            .boxed()
        });

        let native_price_estimator = NativePriceEstimator {
            inner: Arc::new(inner),
            native_token: Address::with_last_byte(7),
            native_token_unit_scale: 1,
            price_estimation_amount: NonZeroU256::try_from(U256::from(10).pow(U256::from(18)))
                .unwrap(),
        };

        let result = native_price_estimator
            .estimate_native_price(Address::with_last_byte(3), HEALTHY_PRICE_ESTIMATION_TIME)
            .await;
        // sell_amount = 10^18 token-units, out_amount = 1.23456789 × 10^17
        // → price_in_buy_token = out / in = 0.123456789. Pre-BUY→SELL refactor
        // the impl returned the inverse (≈ 8.1); the assertion was carried
        // over from that version and was wrong relative to the current SELL
        // direction.
        assert_eq!(result.unwrap(), 0.123456789);
    }

    #[tokio::test]
    async fn errors_get_propagated() {
        let mut inner = MockPriceEstimating::new();
        inner.expect_estimate().times(1).returning(|query| {
            assert!(query.buy_token == Address::with_last_byte(7));
            assert!(query.sell_token == Address::with_last_byte(2));
            async { Err(PriceEstimationError::NoLiquidity) }.boxed()
        });

        let native_price_estimator = NativePriceEstimator {
            inner: Arc::new(inner),
            native_token: Address::with_last_byte(7),
            native_token_unit_scale: 1,
            price_estimation_amount: NonZeroU256::try_from(U256::from(10).pow(U256::from(18)))
                .unwrap(),
        };

        let result = native_price_estimator
            .estimate_native_price(Address::with_last_byte(2), HEALTHY_PRICE_ESTIMATION_TIME)
            .await;
        assert!(matches!(result, Err(PriceEstimationError::NoLiquidity)));
    }

    #[test]
    fn computes_price_from_normalized_price() {
        assert_eq!(
            from_normalized_price(BigDecimal::from_str("500000000000000000").unwrap()).unwrap(),
            0.5
        );
    }

    #[test]
    fn computes_u256_prices_normalized_to_1e18() {
        assert_eq!(
            to_normalized_price(0.5).unwrap(),
            U256::from(500_000_000_000_000_000_u128),
        );
    }

    #[test]
    fn normalize_prices_fail_when_outside_valid_input_range() {
        assert!(to_normalized_price(0.).is_none());
        assert!(to_normalized_price(-1.).is_none());
        assert!(to_normalized_price(f64::INFINITY).is_none());

        let min_price = 1. / 1e18;
        assert!(to_normalized_price(min_price).is_some());
        assert!(to_normalized_price(min_price * (1. - f64::EPSILON)).is_none());

        let uint_max = 2.0_f64.powi(256);
        let max_price = uint_max / 1e18;
        assert!(to_normalized_price(max_price).is_none());
        assert!(to_normalized_price(max_price * (1. - f64::EPSILON)).is_some());
    }
}
