use {
    crate::{
        boundary,
        domain::{self, fee::Quote},
    },
    configs::{autopilot::fee_policy::FeePolicyKind, fee_factor::FeeFactor},
    shared::fee::VolumeFeePolicy,
};

pub enum Policy {
    Surplus(Surplus),
    PriceImprovement(PriceImprovement),
    Volume(Volume),
}

pub struct Surplus {
    factor: FeeFactor,
    max_volume_factor: FeeFactor,
}

pub struct PriceImprovement {
    factor: FeeFactor,
    max_volume_factor: FeeFactor,
}

pub struct Volume {
    factor: FeeFactor,
}

impl From<FeePolicyKind> for Policy {
    fn from(policy_arg: FeePolicyKind) -> Self {
        match policy_arg {
            FeePolicyKind::Surplus {
                factor,
                max_volume_factor,
            } => Policy::Surplus(Surplus {
                factor,
                max_volume_factor,
            }),
            FeePolicyKind::PriceImprovement {
                factor,
                max_volume_factor,
            } => Policy::PriceImprovement(PriceImprovement {
                factor,
                max_volume_factor,
            }),
            FeePolicyKind::Volume { factor } => Policy::Volume(Volume { factor }),
        }
    }
}

impl Surplus {
    pub fn apply(&self, order: &boundary::Order) -> Option<domain::fee::Policy> {
        match order.metadata.class {
            boundary::OrderClass::Market => None,
            boundary::OrderClass::Liquidity => None,
            boundary::OrderClass::Limit => {
                let policy = domain::fee::Policy::Surplus {
                    factor: self.factor,
                    max_volume_factor: self.max_volume_factor,
                };
                Some(policy)
            }
        }
    }
}

impl PriceImprovement {
    pub fn apply(
        &self,
        order: &boundary::Order,
        quote: &domain::Quote,
    ) -> Option<domain::fee::Policy> {
        match order.metadata.class {
            boundary::OrderClass::Liquidity => None,
            boundary::OrderClass::Market | boundary::OrderClass::Limit => Some(domain::fee::Policy::PriceImprovement {
                factor: self.factor,
                max_volume_factor: self.max_volume_factor,
                quote: Quote::from_domain(quote),
            }),
        }
    }

    pub fn apply_with_override(
        &self,
        order: &boundary::Order,
        quote: &domain::Quote,
        factor: FeeFactor,
        max_volume_factor: FeeFactor,
    ) -> Option<domain::fee::Policy> {
        match order.metadata.class {
            boundary::OrderClass::Liquidity => None,
            boundary::OrderClass::Market | boundary::OrderClass::Limit => Some(domain::fee::Policy::PriceImprovement {
                factor,
                max_volume_factor,
                quote: Quote::from_domain(quote),
            }),
        }
    }
}

impl Volume {
    pub fn apply(
        &self,
        order: &boundary::Order,
        volume_fee_policy: &VolumeFeePolicy,
    ) -> Option<domain::fee::Policy> {
        match order.metadata.class {
            boundary::OrderClass::Market => None,
            boundary::OrderClass::Liquidity => None,
            boundary::OrderClass::Limit => {
                // Use shared function to determine applicable volume fee factor
                let factor = volume_fee_policy.get_applicable_volume_fee_factor(
                    order.data.buy_token,
                    order.data.sell_token,
                    Some(self.factor),
                )?;

                Some(domain::fee::Policy::Volume { factor })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price_improvement() -> PriceImprovement {
        PriceImprovement {
            factor: FeeFactor::try_from(0.8).unwrap(),
            max_volume_factor: FeeFactor::try_from(0.003).unwrap(),
        }
    }

    #[test]
    fn price_improvement_applies_to_in_market_orders() {
        let mut order = boundary::Order::default();
        order.metadata.class = boundary::OrderClass::Market;

        assert!(price_improvement().apply(&order, &domain::Quote::default()).is_some());
        assert!(
            price_improvement()
                .apply_with_override(
                    &order,
                    &domain::Quote::default(),
                    FeeFactor::try_from(0.5).unwrap(),
                    FeeFactor::try_from(0.001).unwrap(),
                )
                .is_some()
        );
    }

    #[test]
    fn price_improvement_still_excludes_liquidity_orders() {
        let mut order = boundary::Order::default();
        order.metadata.class = boundary::OrderClass::Liquidity;
        assert!(price_improvement().apply(&order, &domain::Quote::default()).is_none());
    }
}
