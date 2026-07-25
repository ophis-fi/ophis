//! Configuration for the public API server itself (as opposed to the domain
//! features it serves).

use {
    serde::{Deserialize, Serialize},
    std::num::NonZeroU32,
};

/// Settings for the orderbook's public HTTP API.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct ApiConfig {
    /// Orderbook-native per-client rate limiting.
    #[serde(default)]
    pub rate_limit: RateLimitConfig,
}

/// Orderbook-native per-client rate limiter (api-dx decision 10).
///
/// SHIPS DISABLED: `enabled` defaults to `false` and every checked-in config
/// keeps it `false`. The limiter flips on together with the published docs
/// table, in the same window, once real Cloudflare traffic data has set the
/// numbers -- one consistent table, so integrators never see documented
/// limits that disagree with enforced ones.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct RateLimitConfig {
    /// Master switch. `false` (the default) keeps the limiter completely
    /// inert: requests pass through uncounted and no per-client state is
    /// kept.
    #[serde(default)]
    pub enabled: bool,

    /// Sustained per-client budget in requests per second (the token-bucket
    /// refill rate).
    #[serde(default = "default_requests_per_second")]
    pub requests_per_second: NonZeroU32,

    /// Short-burst allowance per client (the token-bucket capacity).
    #[serde(default = "default_burst")]
    pub burst: NonZeroU32,

    /// Trust the `CF-Connecting-IP` header as the client identity. Correct
    /// when the orderbook is only reachable through Cloudflare (the
    /// production posture); MUST be `false` on any host that is directly
    /// reachable, because the header is then client-controlled and every
    /// caller could pick its own bucket.
    #[serde(default = "default_trust_cf_connecting_ip")]
    pub trust_cf_connecting_ip: bool,
}

fn default_requests_per_second() -> NonZeroU32 {
    NonZeroU32::new(5).unwrap()
}

fn default_burst() -> NonZeroU32 {
    NonZeroU32::new(20).unwrap()
}

fn default_trust_cf_connecting_ip() -> bool {
    true
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            requests_per_second: default_requests_per_second(),
            burst: default_burst(),
            trust_cf_connecting_ip: default_trust_cf_connecting_ip(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_ship_disabled() {
        let config: ApiConfig = toml::from_str("").unwrap();
        assert!(!config.rate_limit.enabled);
        assert_eq!(config.rate_limit.requests_per_second.get(), 5);
        assert_eq!(config.rate_limit.burst.get(), 20);
        assert!(config.rate_limit.trust_cf_connecting_ip);
    }

    #[test]
    fn deserializes_full_block() {
        let config: ApiConfig = toml::from_str(
            r#"
            [rate-limit]
            enabled = true
            requests-per-second = 10
            burst = 40
            trust-cf-connecting-ip = false
            "#,
        )
        .unwrap();
        assert!(config.rate_limit.enabled);
        assert_eq!(config.rate_limit.requests_per_second.get(), 10);
        assert_eq!(config.rate_limit.burst.get(), 40);
        assert!(!config.rate_limit.trust_cf_connecting_ip);
    }

    #[test]
    fn rejects_zero_rate_and_unknown_fields() {
        assert!(toml::from_str::<ApiConfig>("[rate-limit]\nrequests-per-second = 0").is_err());
        assert!(toml::from_str::<ApiConfig>("[rate-limit]\nburst = 0").is_err());
        assert!(toml::from_str::<ApiConfig>("[rate-limit]\nrequests-per-secondd = 5").is_err());
    }
}
