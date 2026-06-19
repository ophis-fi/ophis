//! Protocol fee implementation.
//!
//! The protocol fee is a fee that is defined by the protocol and for each order
//! we define the way to calculate the protocol fee based on the configuration
//! parameters.

mod policy;

use {
    crate::{
        boundary::{self},
        domain,
    },
    ::observe::metrics,
    alloy::primitives::{Address, U256},
    app_data::PARTNER_FEE_RECIPIENT_ALLOWLIST,
    chrono::{DateTime, Utc},
    configs::{
        autopilot::fee_policy::{
            FeePoliciesConfig,
            FeePolicy,
            FeePolicyOrderClass,
            UpcomingFeePolicies,
        },
        fee_factor::FeeFactor,
    },
    eth_domain_types as eth,
    prometheus::IntCounterVec,
    rust_decimal::Decimal,
    shared::{arguments::TokenBucketFeeOverride, fee::VolumeFeePolicy},
    std::collections::HashSet,
};

#[derive(prometheus_metric_storage::MetricStorage)]
struct Metrics {
    /// Counts orders whose partner-fee policies were silently dropped before
    /// fee computation. Each `reason` label indicates a distinct upstream
    /// failure mode that bypassed CIP-75 partner-fee accounting; non-zero
    /// values warrant operator investigation since revenue may be at stake.
    #[metric(labels("reason"))]
    partner_fee_dropped: IntCounterVec,
}

impl Metrics {
    fn get() -> &'static Self {
        Metrics::instance(metrics::get_storage_registry()).unwrap()
    }
}

#[derive(Debug)]
enum OrderClass {
    Market,
    Limit,
    Any,
}

impl From<FeePolicyOrderClass> for OrderClass {
    fn from(value: FeePolicyOrderClass) -> Self {
        match value {
            FeePolicyOrderClass::Market => Self::Market,
            FeePolicyOrderClass::Limit => Self::Limit,
            FeePolicyOrderClass::Any => Self::Any,
        }
    }
}

/// Constructs fee policies based on the current configuration.
pub struct ProtocolFee {
    policy: policy::Policy,
    order_class: OrderClass,
}

impl From<FeePolicy> for ProtocolFee {
    fn from(value: FeePolicy) -> Self {
        Self {
            policy: value.kind.into(),
            order_class: value.order_class.into(),
        }
    }
}

pub struct UpcomingProtocolFees {
    fee_policies: Vec<ProtocolFee>,
    effective_from_timestamp: DateTime<Utc>,
}

impl UpcomingProtocolFees {
    fn from_config(value: UpcomingFeePolicies) -> Option<Self> {
        value
            // both config fields must be non-empty
            .effective_from_timestamp
            .filter(|_| !value.policies.is_empty())
            .map(|effective_from_timestamp| UpcomingProtocolFees {
                fee_policies: value
                    .policies
                    .into_iter()
                    .map(ProtocolFee::from)
                    .collect::<Vec<_>>(),
                effective_from_timestamp,
            })
    }
}

pub type ProtocolFeeExemptAddresses = HashSet<Address>;

pub struct ProtocolFees {
    fee_policies: Vec<ProtocolFee>,
    max_partner_fee: FeeFactor,
    upcoming_fee_policies: Option<UpcomingProtocolFees>,
    volume_fee_policy: VolumeFeePolicy,
}

impl ProtocolFees {
    pub fn new(
        config: &FeePoliciesConfig,
        volume_fee_bucket_overrides: Vec<TokenBucketFeeOverride>,
        enable_sell_equals_buy_volume_fee: bool,
    ) -> Self {
        // OP partner-fee floor invariant (defense-in-depth). `max_partner_fee` is
        // the operator-set UPPER cap applied to every partner fee in
        // `get_partner_fee` via `fee_factor_from_capped`. The recipient allowlist
        // means every partner fee is an Ophis fee, and the token-pair floor
        // (enforced at order ingress and re-clamped here) is at most
        // OPHIS_NON_STABLE_FLOOR_BPS. If the cap were configured below that floor,
        // the cap would silently settle an allowlisted-recipient fee BELOW the
        // floor on the eth-flow / on-chain path that skips ingress, reopening the
        // bypass. Fail fast at startup rather than under-charge at settlement.
        let cap = config.max_partner_fee.get();
        let floor_bps = app_data::OPHIS_NON_STABLE_FLOOR_BPS;
        let floor_factor = floor_bps as f64 / 10_000.0;
        assert!(
            cap >= floor_factor,
            "max_partner_fee ({cap}) is below the OP partner-fee floor of {floor_bps} \
             bps ({floor_factor}); the autopilot cap would settle Ophis fees below \
             the enforced floor. Raise max_partner_fee in the autopilot fee-policy \
             config."
        );

        let volume_fee_policy = VolumeFeePolicy::new(
            volume_fee_bucket_overrides,
            None, // contained within FeePoliciesConfig; vol fee is passed in at callsite
            enable_sell_equals_buy_volume_fee,
        );
        Self {
            fee_policies: config
                .policies
                .iter()
                .cloned()
                .map(ProtocolFee::from)
                .collect(),
            max_partner_fee: config.max_partner_fee,
            upcoming_fee_policies: UpcomingProtocolFees::from_config(
                config.upcoming_policies.clone(),
            ),
            volume_fee_policy,
        }
    }

    /// Returns the capped aggregated partner fee
    fn get_partner_fee(
        order: &boundary::Order,
        quote: &domain::Quote,
        max_partner_fee: f64,
    ) -> Vec<Policy> {
        /// Number of basis points that make up 100%.
        const MAX_BPS: u32 = 10_000;

        /// Convert a fee into a `FeeFactor` capping its value
        fn fee_factor_from_capped(
            value: Decimal,
            cap: Decimal,
            accumulated: &mut Decimal,
        ) -> FeeFactor {
            // Calculate how much more we can compound before hitting the cap.
            //
            // When dealing with fee factors or percentages in compounding operations:
            // - We use (1 + x) where x is the percentage as a decimal (e.g., 5% = 0.05 →
            //   1.05)
            // - This is because applying a fee means multiplying by (1 + fee_rate)
            //
            // The total accumulated factor can't exceed (1 + cap), and we've
            // already accumulated to (1 + accumulated), then:
            //
            // 1. Current value with accumulated fees: (1 + accumulated)
            // 2. Maximum allowed value: (1 + cap)
            // 3. To find the remaining factor we can apply: (1 + cap) / (1 + accumulated) -
            //    1
            //
            // The subtraction of 1 at the end converts back from the multiplier form (1.xx)
            // to the percentage form (0.xx) that our FeeFactor expects.
            let remaining_factor =
                (Decimal::ONE + cap) / (Decimal::ONE + *accumulated) - Decimal::ONE;

            // update the `accumulated` value
            *accumulated += value.min(cap - *accumulated);

            FeeFactor::new(f64::try_from(value.max(Decimal::ZERO).min(remaining_factor)).unwrap())
        }

        let max_partner_fee = match Decimal::try_from(max_partner_fee) {
            Ok(value) => value,
            Err(err) => {
                Metrics::get()
                    .partner_fee_dropped
                    .with_label_values(&["max_partner_fee_invalid"])
                    .inc();
                tracing::error!(
                    order_uid = %order.metadata.uid,
                    ?err,
                    max_partner_fee,
                    "partner fee policies dropped: operator-configured max_partner_fee \
                     is not convertible to Decimal"
                );
                return vec![];
            }
        };
        // An absent `full_app_data` means the order legitimately has no app-data
        // attached, which is the common case for orders without partner fees.
        // No telemetry here on purpose — it would fire on every plain order.
        let Some(full_app_data) = order.metadata.full_app_data.as_ref() else {
            return vec![];
        };
        let parsed_app_data = match app_data::parse(full_app_data.as_bytes()) {
            Ok(parsed) => parsed,
            Err(err) => {
                Metrics::get()
                    .partner_fee_dropped
                    .with_label_values(&["app_data_parse_error"])
                    .inc();
                // warn (not error) — the input is user-controlled, so a malformed
                // app_data can be triggered at order-ingestion rate by an
                // attacker. The metric is the load-bearing signal; alert on the
                // rate, not on each log line. %err (Display) is used in place of
                // ?err (Debug) so we don't accidentally echo raw user bytes if
                // serde_json's Debug ever embeds them.
                tracing::warn!(
                    order_uid = %order.metadata.uid,
                    %err,
                    "partner fee policies dropped: app_data document failed to parse"
                );
                return vec![];
            }
        };

        let mut accumulated = Decimal::ZERO;

        parsed_app_data
            .partner_fee
            .iter()
            .filter(|partner_fee| {
                // Defense-in-depth against the orderbook validator: the same
                // allowlist check fires at order ingest, but pre-existing DB
                // rows or any future direct-DB-write path would bypass it.
                // Filter the partner_fee list here too — a non-allowlisted
                // recipient is dropped silently (with a metric so ops can
                // detect attempts), the order itself continues without the
                // fee policy.
                let allowed = PARTNER_FEE_RECIPIENT_ALLOWLIST.contains(&partner_fee.recipient);
                if !allowed {
                    Metrics::get()
                        .partner_fee_dropped
                        .with_label_values(&["recipient_not_in_allowlist"])
                        .inc();
                    tracing::warn!(
                        order_uid = %order.metadata.uid,
                        recipient = ?partner_fee.recipient,
                        "partner fee policy dropped: recipient not in allowlist \
                         (defense-in-depth — orderbook validator should have \
                         rejected at ingest; this fires on stale DB rows or \
                         bypass paths)"
                    );
                }
                allowed
            })
            .map(move |partner_fee| {
                match partner_fee.policy {
                    app_data::FeePolicy::Volume { bps } => {
                        // Defense-in-depth floor mirroring the orderbook ingress
                        // validator: any path that skips ingress (eth-flow /
                        // on-chain orders) or a stale DB row must still never settle
                        // a Volume fee to an allowlisted recipient below the
                        // token-pair-aware minimum. Clamp UP only — never reduce the
                        // user's signed fee; this only raises anomalous sub-floor fees
                        // that ingress should already have rejected.
                        let bps = bps.max(app_data::partner_fee_floor_bps(
                            order.data.sell_token,
                            order.data.buy_token,
                            partner_fee.recipient,
                        ));
                        // Convert bps to decimal percentage
                        let fee_decimal = Decimal::from(bps) / Decimal::from(MAX_BPS);
                        // Create policy and update accumulator
                        let factor =
                            fee_factor_from_capped(fee_decimal, max_partner_fee, &mut accumulated);
                        Policy::Volume { factor }
                    }
                    // Ophis charges a Volume fee only. A Surplus or PriceImprovement
                    // partner fee can only reach an allowlisted recipient here via a
                    // path that skipped the orderbook ingress (which rejects those
                    // variants) — i.e. eth-flow / on-chain orders or a stale DB row.
                    // Those variants carry no enforced lower bound, so neutralize them
                    // to a floor Volume fee (the token-pair minimum) instead of
                    // honoring a potentially near-zero surplus fee. Defense-in-depth:
                    // the normal order path never reaches this arm.
                    app_data::FeePolicy::Surplus { .. }
                    | app_data::FeePolicy::PriceImprovement { .. } => {
                        let _ = &quote; // quote is unused for the neutralized fee
                        let bps = app_data::partner_fee_floor_bps(
                            order.data.sell_token,
                            order.data.buy_token,
                            partner_fee.recipient,
                        );
                        let fee_decimal = Decimal::from(bps) / Decimal::from(MAX_BPS);
                        let factor =
                            fee_factor_from_capped(fee_decimal, max_partner_fee, &mut accumulated);
                        Policy::Volume { factor }
                    }
                }
            })
            .collect::<Vec<_>>()
    }

    /// Converts an order from the boundary layer to the domain layer, applying
    /// protocol fees if necessary.
    pub fn apply(
        &self,
        order: &boundary::Order,
        quote: Option<domain::Quote>,
        surplus_capturing_jit_order_owners: &[eth::Address],
    ) -> domain::Order {
        // In case there is no quote, we assume 0 buy amount so that the order ends up
        // being considered out of market price.
        let reference_quote = quote.clone().unwrap_or(domain::Quote {
            order_uid: order.metadata.uid.into(),
            sell_amount: order.data.sell_amount.into(),
            buy_amount: U256::ZERO.into(),
            fee: order.data.fee_amount.into(),
            solver: Address::ZERO,
        });

        let partner_fee =
            Self::get_partner_fee(order, &reference_quote, self.max_partner_fee.get());

        if surplus_capturing_jit_order_owners.contains(&order.metadata.owner) {
            return boundary::order::to_domain(order, partner_fee, quote);
        }

        self.apply_policies(order, reference_quote, partner_fee)
    }

    fn apply_policies(
        &self,
        order: &boundary::Order,
        quote: domain::Quote,
        partner_fees: Vec<Policy>,
    ) -> domain::Order {
        let now = Utc::now();
        let fee_policies = self
            .upcoming_fee_policies
            .as_ref()
            .filter(|upcoming| upcoming.effective_from_timestamp <= now)
            .map(|upcoming| &upcoming.fee_policies)
            .unwrap_or(&self.fee_policies);

        let protocol_fees = fee_policies
            .iter()
            .filter_map(|fee_policy| Self::protocol_fee_into_policy(order, &quote, fee_policy))
            .flat_map(|policy| self.variant_fee_apply(order, &quote, policy))
            .chain(partner_fees)
            .collect::<Vec<_>>();

        boundary::order::to_domain(order, protocol_fees, Some(quote))
    }

    fn variant_fee_apply(
        &self,
        order: &boundary::Order,
        quote: &domain::Quote,
        policy: &policy::Policy,
    ) -> Option<Policy> {
        match policy {
            policy::Policy::Surplus(variant) => variant.apply(order),
            policy::Policy::PriceImprovement(variant) => variant.apply(order, quote),
            policy::Policy::Volume(variant) => variant.apply(order, &self.volume_fee_policy),
        }
    }

    fn protocol_fee_into_policy<'a>(
        order: &boundary::Order,
        quote: &domain::Quote,
        protocol_fee: &'a ProtocolFee,
    ) -> Option<&'a policy::Policy> {
        let outside_market_price =
            boundary::is_order_outside_market_price(&order.into(), &quote.into(), order.data.kind);
        match (outside_market_price, &protocol_fee.order_class) {
            (_, OrderClass::Any) => Some(&protocol_fee.policy),
            (true, OrderClass::Limit) => Some(&protocol_fee.policy),
            (false, OrderClass::Market) => Some(&protocol_fee.policy),
            _ => None,
        }
    }
}

#[derive(Debug, Copy, Clone, PartialEq)]
pub enum Policy {
    /// If the order receives more than limit price, take the protocol fee as a
    /// percentage of the difference. The fee is taken in `sell` token for
    /// `buy` orders and in `buy` token for `sell` orders.
    Surplus {
        /// Factor of surplus the protocol charges as a fee.
        /// Surplus is the difference between executed price and limit price
        ///
        /// E.g. if a user received 2000USDC for 1ETH while having a limit price
        /// of 1990USDC, their surplus is 10USDC. A factor of 0.5
        /// requires the solver to pay 5USDC to the protocol for
        /// settling this order.
        factor: FeeFactor,
        /// Cap protocol fee with a percentage of the order's volume.
        max_volume_factor: FeeFactor,
    },
    /// A price improvement corresponds to a situation where the order is
    /// executed at a better price than the top quote. The protocol fee in such
    /// case is calculated from a cut of this price improvement.
    PriceImprovement {
        factor: FeeFactor,
        max_volume_factor: FeeFactor,
        quote: Quote,
    },
    /// How much of the order's volume should be taken as a protocol fee.
    /// The fee is taken in `sell` token for `sell` orders and in `buy`
    /// token for `buy` orders.
    Volume {
        /// Percentage of the order's volume should be taken as a protocol
        /// fee.
        factor: FeeFactor,
    },
}

#[derive(Debug, Copy, Clone, PartialEq)]
pub struct Quote {
    /// The amount of the sell token.
    pub sell_amount: U256,
    /// The amount of the buy token.
    pub buy_amount: U256,
    /// The amount that needs to be paid, denominated in the sell token.
    pub fee: U256,
    pub solver: Address,
}

impl Quote {
    fn from_domain(value: &domain::Quote) -> Self {
        Self {
            sell_amount: value.sell_amount.0,
            buy_amount: value.buy_amount.0,
            fee: value.fee.0,
            solver: value.solver,
        }
    }
}

#[cfg(test)]
mod test {
    use {super::*, model::order::OrderMetadata};

    #[test]
    #[should_panic(expected = "below the OP partner-fee floor")]
    fn new_panics_when_max_partner_fee_below_floor() {
        // A cap below the 4 bps non-stable floor would let the autopilot's
        // upper cap settle an Ophis fee below the floor on the eth-flow path that
        // skips ingress. The constructor must refuse to build (fail fast at boot).
        let config = FeePoliciesConfig {
            max_partner_fee: FeeFactor::new(0.0003), // 3 bps < 4 bps floor
            ..Default::default()
        };
        let _ = ProtocolFees::new(&config, vec![], false);
    }

    #[test]
    fn new_accepts_max_partner_fee_at_or_above_floor() {
        // Production default (100 bps) and a value just above the floor both build.
        for factor in [0.002_f64, 0.01] {
            let config = FeePoliciesConfig {
                max_partner_fee: FeeFactor::new(factor),
                ..Default::default()
            };
            let _ = ProtocolFees::new(&config, vec![], false);
        }
    }

    #[test]
    fn test_get_partner_fee_valid_multiple_fees_not_capped() {
        // Scenario: Multiple partner fees, with valid values (not capped)
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
                {
                    "appCode": "CoW Swap",
                    "environment": "production",
                    "metadata": {
                        "partnerFee": [
                            {
                                "bps": 500,
                                "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                            },
                            {
                                "bps": 2000,
                                "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                            }
                        ]
                    },
                    "version": "0.9.0"
                }
            "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3; // 30%
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);

        // Expected: The compounded percentage (1 + 0.05) * (1 + 0.20) - 1 = 0.26 < 0.3
        // (not capped)
        assert_eq!(
            result,
            vec![
                Policy::Volume {
                    factor: FeeFactor::try_from(0.05).unwrap(),
                },
                Policy::Volume {
                    factor: FeeFactor::try_from(0.2).unwrap(),
                }
            ]
        );
    }

    #[test]
    fn test_get_partner_fee_empty() {
        // Scenario: No partner fees in the app data
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": []
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3; // 30%
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);

        // Expected: Empty vector since there are no partner fees
        assert_eq!(result, vec![]);
    }

    #[test]
    fn test_get_partner_fee_zero_bps_clamped_up_to_floor() {
        // Scenario: a 0 bps Volume fee to the Ophis recipient is clamped UP to the
        // token-pair floor by the defense-in-depth autopilot floor (mirrors the
        // orderbook ingress validator). This closes the prior 0-fee bypass for any
        // path that skips the off-chain ingress (eth-flow / on-chain orders, stale
        // DB rows). The order's default token pair is non-stable -> the 4 bps floor.
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": [
                        {
                            "bps": 0,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        }
                    ]
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3; // 30%
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);

        // Expected: 0 bps clamped UP to the 4 bps floor (default tokens are
        // non-stable; 4 bps = 0.0004), never settling a sub-floor Volume fee.
        assert_eq!(
            result,
            vec![Policy::Volume {
                factor: FeeFactor::try_from(0.0004).unwrap(),
            }]
        );
    }

    #[test]
    fn test_get_partner_fee_recipient_not_in_allowlist_dropped() {
        // Defense-in-depth: orderbook validator should reject at ingress,
        // but pre-existing DB rows or any bypass path could carry a fee
        // entry with a non-allowlisted recipient. Verify the fee module
        // drops it silently rather than minting policy for a non-Ophis
        // recipient.
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": [
                        {
                            "bps": 1000,
                            "recipient": "0x0202020202020202020202020202020202020202"
                        }
                    ]
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3;
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);
        assert_eq!(
            result,
            vec![],
            "non-allowlisted recipient must produce empty policy vector",
        );
    }

    #[test]
    fn test_get_partner_fee_mixed_allowlist_keeps_only_allowed() {
        // Two fees in the same app-data, one allowlisted + one not.
        // Expect the allowed one to keep its policy; the other dropped.
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": [
                        {
                            "bps": 1000,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        },
                        {
                            "bps": 500,
                            "recipient": "0x0303030303030303030303030303030303030303"
                        }
                    ]
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3;
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);
        assert_eq!(
            result.len(),
            1,
            "exactly one policy expected (the allowlisted recipient's)"
        );
    }

    #[test]
    fn test_get_partner_fee_zero_cap() {
        // Scenario: Partner fees with zero cap
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": [
                        {
                            "bps": 1000,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        },
                        {
                            "bps": 2000,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        }
                    ]
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.0; // 0%
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);

        // Expected: All fees are capped to zero but still appear
        assert_eq!(
            result,
            vec![
                Policy::Volume {
                    factor: FeeFactor::try_from(0.0).unwrap(),
                },
                Policy::Volume {
                    factor: FeeFactor::try_from(0.0).unwrap(),
                }
            ]
        );
    }

    #[test]
    fn test_get_partner_fee_single_capped() {
        // Scenario: Single partner fee exceeding the cap
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": [
                        {
                            "bps": 5000,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        }
                    ]
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3; // 30%
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);

        // Expected: Single fee capped at 0.3 (instead of 0.5)
        assert_eq!(
            result,
            vec![Policy::Volume {
                factor: FeeFactor::try_from(0.3).unwrap(),
            }]
        );
    }

    #[test]
    fn test_get_two_partner_fees_capped() {
        // Scenario: One partner fee gets partially capped due to compounding
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": [
                        {
                            "bps": 1000,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        },
                        {
                            "bps": 2500,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        }
                    ]
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3; // 30%
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);

        // Expected: With compounding:
        // First fee: 0.1
        // Second fee: 0.25 would result in (1+0.1)*(1+0.25)-1 = 0.375 > 0.3
        // Second fee is capped to 0.1818... to make total exactly 0.3
        assert_eq!(
            result,
            vec![
                Policy::Volume {
                    factor: FeeFactor::try_from(0.1).unwrap(),
                },
                Policy::Volume {
                    factor: FeeFactor::try_from(0.18181818181818182).unwrap(),
                }
            ]
        );
    }

    #[test]
    fn test_get_three_partner_fees_capped() {
        // Scenario: Partner fees exceeding the cap with compounding
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(
                    r#"
            {
                "appCode": "CoW Swap",
                "environment": "production",
                "metadata": {
                    "partnerFee": [
                        {
                            "bps": 1000,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        },
                        {
                            "bps": 2000,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        },
                        {
                            "bps": 1500,
                            "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                        }
                    ]
                },
                "version": "0.9.0"
            }
        "#
                    .to_string(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };

        let max_partner_fee = 0.3; // 30%
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), max_partner_fee);

        // Expected: With compounding, fees accumulate as follows:
        // First fee: 0.1
        // Second fee: 0.2 (accumulated to this point: (1+0.1)*(1+0.2)-1 = 0.32 > 0.3)
        // Second fee gets capped to 0.1818... to make total exactly 0.3
        // Third fee: Capped to 0 since we already hit the cap
        assert_eq!(
            result,
            vec![
                Policy::Volume {
                    factor: FeeFactor::try_from(0.1).unwrap(),
                },
                Policy::Volume {
                    factor: FeeFactor::try_from(0.18181818181818182).unwrap(),
                },
                Policy::Volume {
                    factor: FeeFactor::try_from(0.0).unwrap(),
                }
            ]
        );
    }

    // A Surplus or PriceImprovement partner fee to an allowlisted recipient can
    // only reach the autopilot via a path that bypasses the orderbook ingress
    // validator (eth-flow / on-chain orders, or a stale DB row) — the off-chain
    // order path rejects those variants outright. Because they carry no enforced
    // lower bound, the autopilot neutralizes them to a floor Volume fee (the
    // token-pair minimum), so they can never be used to settle below the floor.
    // These helpers return that neutralized Volume factor; the input bps is
    // discarded by design.
    fn neutralized_surplus_factor(bps: u64) -> FeeFactor {
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(format!(
                    r#"{{
                        "metadata": {{
                            "partnerFee": [{{
                                "surplusBps": {bps},
                                "maxVolumeBps": 50,
                                "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                            }}]
                        }}
                    }}"#
                )),
                ..Default::default()
            },
            ..Default::default()
        };
        let policies = ProtocolFees::get_partner_fee(&order, &Default::default(), 1.0);
        match policies.first().expect("expected at least one policy") {
            Policy::Volume { factor } => *factor,
            other => panic!("expected neutralized Policy::Volume, got {other:?}"),
        }
    }

    fn neutralized_price_improvement_factor(bps: u64) -> FeeFactor {
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some(format!(
                    r#"{{
                        "metadata": {{
                            "partnerFee": [{{
                                "priceImprovementBps": {bps},
                                "maxVolumeBps": 50,
                                "recipient": "0x858f0F5eE954846D47155F5203c04aF1819eCeF8"
                            }}]
                        }}
                    }}"#
                )),
                ..Default::default()
            },
            ..Default::default()
        };
        let policies = ProtocolFees::get_partner_fee(&order, &Default::default(), 1.0);
        match policies.first().expect("expected at least one policy") {
            Policy::Volume { factor } => *factor,
            other => panic!("expected neutralized Policy::Volume, got {other:?}"),
        }
    }

    #[test]
    fn surplus_fee_to_allowlisted_recipient_neutralized_to_floor() {
        // Default (non-stable) token pair, so the floor is
        // OPHIS_NON_STABLE_FLOOR_BPS (4 bps = 0.0004). The surplus bps value is
        // irrelevant: it is discarded and replaced by the token-pair floor, so a
        // near-zero surplus fee on an eth-flow order can never be used to settle
        // below the minimum. max_partner_fee = 1.0 here, so the cap never binds.
        let floor = FeeFactor::try_from(0.0004).unwrap();
        assert_eq!(neutralized_surplus_factor(0), floor);
        assert_eq!(neutralized_surplus_factor(1), floor);
        assert_eq!(neutralized_surplus_factor(2500), floor);
        assert_eq!(neutralized_surplus_factor(9999), floor);
        assert_eq!(neutralized_surplus_factor(u64::MAX), floor);
    }

    #[test]
    fn price_improvement_fee_to_allowlisted_recipient_neutralized_to_floor() {
        let floor = FeeFactor::try_from(0.0004).unwrap();
        assert_eq!(neutralized_price_improvement_factor(0), floor);
        assert_eq!(neutralized_price_improvement_factor(2500), floor);
        assert_eq!(neutralized_price_improvement_factor(9999), floor);
        assert_eq!(neutralized_price_improvement_factor(u64::MAX), floor);
    }

    #[test]
    fn malformed_app_data_returns_empty_without_panic() {
        // Audit C1 inverse: a malformed app_data document used to silently drop
        // partner fees with no log or telemetry. The function must still return
        // `vec![]` (preserving the legacy callsite contract) and now emits a
        // `tracing::warn!` plus `partner_fee_dropped{reason="app_data_parse_error"}`
        // counter increment. The metric is observable in production; this test
        // only guards the no-panic / empty-return contract.
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: Some("this is not json".to_string()),
                ..Default::default()
            },
            ..Default::default()
        };
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), 0.01);
        assert_eq!(result, vec![]);
    }

    #[test]
    fn no_app_data_returns_empty_silently() {
        // No `full_app_data` is a legitimate case (orders without app-data);
        // no telemetry should fire on this path, only on parse failures.
        let order = boundary::Order {
            metadata: OrderMetadata {
                full_app_data: None,
                ..Default::default()
            },
            ..Default::default()
        };
        let result = ProtocolFees::get_partner_fee(&order, &Default::default(), 0.01);
        assert_eq!(result, vec![]);
    }
}
