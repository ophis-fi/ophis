//! Configuration for the self-serve partner-fee recipient registry
//! (partner-fees Phase A). Shared by the orderbook (which enforces the registry
//! at ingress and serves the registration endpoints) and the autopilot (which
//! consults the same snapshot as a defense-in-depth filter).

use {
    serde::{Deserialize, Serialize},
    std::time::Duration,
};

fn default_refresh_interval() -> Duration {
    Duration::from_secs(30)
}

/// Settings for the in-memory partner-fee registry snapshot and the
/// registration endpoint.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct PartnerFeeRegistryConfig {
    /// How often the in-memory active-recipient snapshot is refreshed from the
    /// database. A newly registered partner becomes enforceable within one
    /// interval.
    #[serde(with = "humantime_serde", default = "default_refresh_interval")]
    pub refresh_interval: Duration,

    /// Opens public POST /api/v1/partners; disabled by default. For backward
    /// compatibility, enabling registration also enables registry enforcement.
    #[serde(default)]
    pub registration_enabled: bool,

    /// Honors operator-provisioned recipients without opening registration.
    /// Defaults to false; keep this identical in orderbook and autopilot.
    #[serde(default)]
    pub registry_enabled: bool,
}

impl PartnerFeeRegistryConfig {
    /// Whether the registry snapshot is loaded and enforced: the new
    /// `registry_enabled` OR the legacy `registration_enabled` (which implied
    /// enforcement before the two were separated). Do NOT use this to gate
    /// `POST /api/v1/partners`; that is `registration_enabled` alone.
    pub fn registry_active(&self) -> bool {
        self.registry_enabled || self.registration_enabled
    }
}

impl Default for PartnerFeeRegistryConfig {
    fn default() -> Self {
        Self {
            refresh_interval: default_refresh_interval(),
            registration_enabled: false,
            registry_enabled: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_ship_registration_disabled() {
        let config: PartnerFeeRegistryConfig = toml::from_str("").unwrap();
        assert!(!config.registration_enabled);
        assert!(!config.registry_enabled);
        assert!(!config.registry_active());
        assert_eq!(config.refresh_interval, Duration::from_secs(30));
        let default = PartnerFeeRegistryConfig::default();
        assert!(!default.registration_enabled && !default.registry_enabled);
    }

    #[test]
    fn deserializes_full_block() {
        let config: PartnerFeeRegistryConfig = toml::from_str(
            r#"
            refresh-interval = "10s"
            registration-enabled = true
            registry-enabled = true
            "#,
        )
        .unwrap();
        assert!(config.registration_enabled);
        assert!(config.registry_enabled);
        assert_eq!(config.refresh_interval, Duration::from_secs(10));
    }

    #[test]
    fn flag_combinations() {
        // (registration_enabled, registry_enabled) -> registry_active
        for (registration, registry, active) in [
            (false, false, false),
            (true, false, true), // legacy: registration implies enforcement
            (false, true, true), // operator-provisioned, public POST stays off
            (true, true, true),
        ] {
            let config: PartnerFeeRegistryConfig = toml::from_str(&format!(
                "registration-enabled = {registration}\nregistry-enabled = {registry}"
            ))
            .unwrap();
            assert_eq!(config.registration_enabled, registration);
            assert_eq!(config.registry_enabled, registry);
            assert_eq!(config.registry_active(), active);
        }
    }

    #[test]
    fn operated_op_configs_enforce_registry_without_public_registration() {
        for document in [
            include_str!("../../../../../infra/optimism-mainnet/configs/orderbook.toml"),
            include_str!("../../../../../infra/optimism-mainnet/configs/autopilot.toml"),
        ] {
            let config: toml::Value = toml::from_str(document).unwrap();
            let registry: PartnerFeeRegistryConfig =
                config["partner-fee-registry"].clone().try_into().unwrap();
            assert!(registry.registry_active());
            assert!(!registry.registration_enabled);
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        assert!(
            toml::from_str::<PartnerFeeRegistryConfig>("registration-enabledd = true").is_err()
        );
        assert!(toml::from_str::<PartnerFeeRegistryConfig>("registry-enabledd = true").is_err());
    }
}
