use {
    alloy::primitives::Address,
    serde::{Deserialize, Serialize},
    std::{num::NonZeroUsize, path::PathBuf, time::Duration},
};

fn default_max_cache_size() -> NonZeroUsize {
    NonZeroUsize::new(10000).unwrap()
}

fn default_snapshot_max_age() -> Duration {
    Duration::from_secs(24 * 60 * 60)
}

/// Manual address bans and an optional freshness-checked OFAC snapshot.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct BannedUsersConfig {
    /// List of account addresses to be denied from order creation.
    #[serde(default)]
    pub addresses: Vec<Address>,

    /// Atomically refreshed OFAC snapshot, in addition to manual bans.
    #[serde(default)]
    pub addresses_file: Option<PathBuf>,

    /// Stop screening when the last successful download is older than this.
    #[serde(default = "default_snapshot_max_age", with = "humantime_serde")]
    pub snapshot_max_age: Duration,

    /// Retained for configuration compatibility; the retired oracle cache is unused.
    #[serde(default = "default_max_cache_size")]
    pub max_cache_size: NonZeroUsize,
}

impl Default for BannedUsersConfig {
    fn default() -> Self {
        Self {
            addresses: Vec::new(),
            addresses_file: None,
            snapshot_max_age: default_snapshot_max_age(),
            max_cache_size: default_max_cache_size(),
        }
    }
}

#[cfg(test)]
mod tests {
    use {super::*, alloy::primitives::address};

    #[test]
    fn deserialize_defaults() {
        let toml = "";
        let config: BannedUsersConfig = toml::from_str(toml).unwrap();
        assert!(config.addresses.is_empty());
        assert!(config.addresses_file.is_none());
        assert_eq!(config.snapshot_max_age, Duration::from_secs(86400));
        assert_eq!(config.max_cache_size.get(), 10000);
    }

    #[test]
    fn deserialize_full() {
        let toml = r#"
        addresses = ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"]
        max-cache-size = 5000
        addresses-file = "/sanctions/addresses.json"
        snapshot-max-age = "12h"
        "#;
        let config: BannedUsersConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.addresses.len(), 1);
        assert_eq!(
            config.addresses[0],
            address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
        );
        assert_eq!(config.max_cache_size.get(), 5000);
        assert_eq!(
            config.addresses_file.unwrap(),
            PathBuf::from("/sanctions/addresses.json")
        );
        assert_eq!(config.snapshot_max_age, Duration::from_secs(43200));
    }
}
