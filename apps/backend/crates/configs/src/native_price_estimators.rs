use {
    alloy::primitives::{Address, B256},
    serde::Deserialize,
    std::fmt::{self, Display, Formatter},
    url::Url,
};

/// Ordered stages of native-price estimators. Each stage is tried in order;
/// within a stage estimators run concurrently.
#[derive(Clone, Debug, Default)]
#[cfg_attr(any(test, feature = "test-util"), derive(serde::Serialize))]
pub struct NativePriceEstimators(Vec<Vec<NativePriceEstimator>>);

impl<'de> Deserialize<'de> for NativePriceEstimators {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let estimators = <Vec<Vec<NativePriceEstimator>>>::deserialize(deserializer)?;
        if estimators.is_empty() {
            return Err(serde::de::Error::invalid_length(
                0,
                &"expected native price estimator stages to be configured",
            ));
        }
        match estimators
            .iter()
            .enumerate()
            .find_map(|(n, stage)| stage.is_empty().then_some(n))
        {
            Some(n) => Err(serde::de::Error::invalid_length(
                0,
                &format!("stage {} is empty, all stages must not be empty", n).as_str(),
            )),
            None => Ok(Self(estimators)),
        }
    }
}

impl NativePriceEstimators {
    pub fn new(estimators: Vec<Vec<NativePriceEstimator>>) -> Self {
        Self(estimators)
    }

    pub fn as_slice(&self) -> &[Vec<NativePriceEstimator>] {
        &self.0
    }
}

#[cfg(any(test, feature = "test-util"))]
impl NativePriceEstimators {
    pub fn test_default() -> Self {
        use std::str::FromStr;
        NativePriceEstimators::new(vec![vec![NativePriceEstimator::driver(
            "test_quoter".to_string(),
            Url::from_str("http://localhost:11088/test_solver").unwrap(),
        )]])
    }
}

impl Display for NativePriceEstimators {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        for (i, stage) in self.as_slice().iter().enumerate() {
            if i > 0 {
                write!(f, ";")?;
            }
            for (j, estimator) in stage.iter().enumerate() {
                if j > 0 {
                    write!(f, ",")?;
                }
                write!(f, "{estimator}")?;
            }
        }
        Ok(())
    }
}

/// Reference to an external solver by name and URL.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[cfg_attr(any(test, feature = "test-util"), derive(serde::Serialize))]
#[serde(deny_unknown_fields)]
pub struct ExternalSolver {
    pub name: String,
    pub url: Url,
}

/// A single native-price estimation backend.
#[derive(Clone, Debug, Hash, Eq, PartialEq, Deserialize)]
#[cfg_attr(any(test, feature = "test-util"), derive(serde::Serialize))]
#[serde(tag = "type")]
pub enum NativePriceEstimator {
    /// Query an external solver driver for native prices.
    Driver(ExternalSolver),
    /// Forward requests to another service (e.g. autopilot).
    Forwarder { url: Url },
    /// Use the 1inch spot-price API.
    OneInchSpotPriceApi,
    /// Use the CoinGecko API.
    CoinGecko,
    /// Read native prices from on-chain Uniswap-V3 pool oracles.
    ///
    /// Probes the configured fee tiers (default `[500, 3000, 100, 10000]`),
    /// picks the first pool whose `liquidity()` clears the configured threshold,
    /// and computes a 180-second TWAP via `IUniswapV3Pool.observe`. The factory
    /// address and pool `init_code_hash` are per-chain — the canonical Uniswap
    /// V3 deployment is used on Optimism/Ethereum, and forks (e.g. Kumbaya V3
    /// on MegaETH) need their own factory + init hash configured.
    ///
    /// The `init_code_hash` is the keccak256 of the deployed pool contract's
    /// init code (constructor + runtime). Pools have no constructor args, so
    /// the hash is constant across all pools of a given V3 deployment.
    UniswapV3(UniswapV3Config),
}

impl NativePriceEstimator {
    pub const fn driver(name: String, url: Url) -> Self {
        Self::Driver(ExternalSolver { name, url })
    }

    pub const fn forwarder(url: Url) -> Self {
        Self::Forwarder { url }
    }
}

impl Display for NativePriceEstimator {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        match self {
            NativePriceEstimator::Driver(s) => write!(f, "Driver|{}|{}", &s.name, s.url),
            NativePriceEstimator::Forwarder { url } => write!(f, "Forwarder|{}", url),
            NativePriceEstimator::OneInchSpotPriceApi => write!(f, "OneInchSpotPriceApi"),
            NativePriceEstimator::CoinGecko => write!(f, "CoinGecko"),
            NativePriceEstimator::UniswapV3(_) => write!(f, "UniswapV3"),
        }
    }
}

/// Configuration for the on-chain Uniswap-V3 native-price estimator.
///
/// All addresses and the init-code hash are chain-specific. The defaults below
/// match canonical Uniswap V3 (Ethereum / Optimism / Arbitrum / Polygon / Base
/// / BNB). Forks like Kumbaya V3 on MegaETH need to override both
/// `factory` and `init_code_hash`.
#[derive(Clone, Debug, Hash, Eq, PartialEq, Deserialize)]
#[cfg_attr(any(test, feature = "test-util"), derive(serde::Serialize))]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct UniswapV3Config {
    /// V3 factory address. Used only for documentation / metrics; pool
    /// addresses are computed via CREATE2 from `factory + init_code_hash`.
    pub factory: Address,

    /// Pool init-code hash. Constant for a given V3 deployment because pools
    /// have no constructor arguments.
    pub init_code_hash: B256,

    /// Fee tiers to probe, in priority order. Defaults to
    /// `[500, 3000, 100, 10000]` (0.05% → 0.3% → 0.01% → 1%).
    #[serde(default = "default_fee_tiers")]
    pub fee_tiers: Vec<u32>,

    /// Minimum `pool.liquidity()` value required to accept a pool. Pools below
    /// this threshold are skipped. Default `1` accepts any pool with non-zero
    /// in-range liquidity. Accepted as either a TOML integer (capped at u64
    /// range — TOML doesn't natively support u128) or a decimal string for
    /// thresholds that exceed u64. Stored internally as u128 to match the
    /// native return type of `IUniswapV3Pool.liquidity()`.
    #[serde(default = "default_min_liquidity", deserialize_with = "deserialize_u128")]
    pub min_liquidity: u128,

    /// TWAP window in seconds. Default `180` (3 minutes) — matches CoW
    /// Protocol's native-price practice and is the sweet spot for an
    /// orderbook fee/ranking signal on Optimism.
    #[serde(default = "default_twap_window_secs")]
    pub twap_window_secs: u32,
}

fn default_fee_tiers() -> Vec<u32> {
    vec![500, 3000, 100, 10000]
}

const fn default_min_liquidity() -> u128 {
    1
}

const fn default_twap_window_secs() -> u32 {
    180
}

/// Accept either a TOML integer (max `i64::MAX` / `u64::MAX` depending on
/// parser) or a decimal-string for values above the integer range. Errors on
/// negative integers and on strings that don't parse as u128.
fn deserialize_u128<'de, D>(deserializer: D) -> Result<u128, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};
    use std::fmt;

    struct U128Visitor;

    impl<'de> Visitor<'de> for U128Visitor {
        type Value = u128;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a u128 (integer or decimal-encoded string)")
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(u128::from(v))
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            if v < 0 {
                return Err(E::custom(format!("negative min_liquidity: {v}")));
            }
            Ok(v as u128)
        }

        fn visit_u128<E: de::Error>(self, v: u128) -> Result<Self::Value, E> {
            Ok(v)
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            v.parse::<u128>()
                .map_err(|err| E::custom(format!("invalid u128 string {v:?}: {err}")))
        }
    }

    deserializer.deserialize_any(U128Visitor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_uniswap_v3_with_defaults() {
        let toml = r#"
            type = "UniswapV3"
            factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
            init-code-hash = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54"
        "#;
        let estimator: NativePriceEstimator = toml::from_str(toml).unwrap();
        let cfg = match estimator {
            NativePriceEstimator::UniswapV3(c) => c,
            _ => panic!("expected UniswapV3 variant"),
        };
        assert_eq!(cfg.fee_tiers, vec![500, 3000, 100, 10000]);
        assert_eq!(cfg.min_liquidity, 1);
        assert_eq!(cfg.twap_window_secs, 180);
    }

    #[test]
    fn deserialize_uniswap_v3_with_overrides() {
        let toml = r#"
            type = "UniswapV3"
            factory = "0x68b34591f662508076927803c567Cc8006988a09"
            init-code-hash = "0x851d77a45b8b9a205fb9f44cb829cceba85282714d2603d601840640628a3da7"
            fee-tiers = [3000, 500]
            min-liquidity = 1000
            twap-window-secs = 60
        "#;
        let estimator: NativePriceEstimator = toml::from_str(toml).unwrap();
        let cfg = match estimator {
            NativePriceEstimator::UniswapV3(c) => c,
            _ => panic!("expected UniswapV3 variant"),
        };
        assert_eq!(cfg.fee_tiers, vec![3000, 500]);
        assert_eq!(cfg.min_liquidity, 1000);
        assert_eq!(cfg.twap_window_secs, 60);
    }

    /// Smoke test: the multi-stage TOML shape we ship in
    /// `infra/optimism-mainnet/configs/{orderbook,autopilot}.toml` must
    /// deserialise cleanly into `NativePriceEstimators`. Catches regressions
    /// where a future serde rename or default change breaks the production
    /// configs without an explicit roundtrip in the e2e suite.
    #[test]
    fn deserialize_uniswap_v3_then_coingecko_fallback_stage() {
        #[derive(serde::Deserialize)]
        struct Wrapper {
            estimators: NativePriceEstimators,
        }
        let toml = r#"
            estimators = [
              [
                { type = "UniswapV3", factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984", init-code-hash = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54" },
                { type = "CoinGecko" },
              ],
            ]
        "#;
        let w: Wrapper = toml::from_str(toml).unwrap();
        let stages = w.estimators.as_slice();
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].len(), 2);
        assert!(matches!(stages[0][0], NativePriceEstimator::UniswapV3(_)));
        assert!(matches!(stages[0][1], NativePriceEstimator::CoinGecko));
    }

    #[test]
    fn uniswap_v3_display() {
        let estimator = NativePriceEstimator::UniswapV3(UniswapV3Config {
            factory: Address::ZERO,
            init_code_hash: B256::ZERO,
            fee_tiers: default_fee_tiers(),
            min_liquidity: default_min_liquidity(),
            twap_window_secs: default_twap_window_secs(),
        });
        assert_eq!(format!("{estimator}"), "UniswapV3");
    }
}
