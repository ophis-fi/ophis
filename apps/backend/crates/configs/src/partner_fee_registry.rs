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

    /// Master switch for the self-serve registration endpoint
    /// (`POST /api/v1/partners`). SHIPS DISABLED: `false` (the default and every
    /// checked-in config) makes the endpoint return 403 and no third party can
    /// register, so the registry stays empty and only the always-allowed Ophis
    /// Safe passes partner-fee validation, the exact pre-registry behavior.
    /// Flip on after the internal test partner order settles. Ignored by the
    /// autopilot (it only reads the snapshot; it never registers).
    #[serde(default)]
    pub registration_enabled: bool,
}

impl Default for PartnerFeeRegistryConfig {
    fn default() -> Self {
        Self {
            refresh_interval: default_refresh_interval(),
            registration_enabled: false,
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
        assert_eq!(config.refresh_interval, Duration::from_secs(30));
    }

    #[test]
    fn deserializes_full_block() {
        let config: PartnerFeeRegistryConfig = toml::from_str(
            r#"
            refresh-interval = "10s"
            registration-enabled = true
            "#,
        )
        .unwrap();
        assert!(config.registration_enabled);
        assert_eq!(config.refresh_interval, Duration::from_secs(10));
    }

    #[test]
    fn rejects_unknown_fields() {
        assert!(toml::from_str::<PartnerFeeRegistryConfig>("registration-enabledd = true").is_err());
    }
}
