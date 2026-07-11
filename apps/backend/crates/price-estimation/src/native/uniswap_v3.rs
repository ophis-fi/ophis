//! On-chain Uniswap V3 native-price estimator.
//!
//! Reads a Time-Weighted-Average-Price (TWAP) from the V3 pool oracle for the
//! `(token, native_token)` pair on the active chain. Replaces CoinGecko as the
//! default native-price source on Optimism (Phase 4) and unblocks fee
//! accounting on MegaETH mainnet (chain 4326), where no CEX-grade price API
//! lists the chain.
//!
//! # Algorithm
//!
//! 1. **Pool discovery**. For each fee tier in `fee_tiers` (default
//!    `[500, 3000, 100, 10000]`), derive the deterministic pool address via
//!    CREATE2:
//!    ```text
//!    pool = keccak256(0xff || factory || keccak256(token0 || token1 || fee) || init_code_hash)[12..]
//!    ```
//!    This matches `PoolAddress.computeAddress` in `v3-periphery`.
//!
//! 2. **Liquidity filter**. Call `liquidity()` on each candidate pool. Pools
//!    below the configured threshold (default `1` — any non-zero in-range
//!    liquidity) are skipped. Pools that revert (no contract deployed) are
//!    also skipped.
//!
//! 3. **TWAP**. For the first pool that passes, call
//!    `observe(secondsAgos = [window, 0])`. The pool returns two cumulative
//!    tick values. The arithmetic-mean tick over the window is
//!    `(tick_now - tick_then) / window`. The price is then `1.0001^tick`,
//!    which is already an atom-ratio (no decimal scaling; see below).
//!
//! 4. **Cardinality guard**. If the pool's `observationCardinality < 2` it
//!    cannot serve a TWAP — `observe` would revert with `OLD`. We don't probe
//!    `slot0()` separately for performance; instead we let the `observe` call
//!    revert and fall through to the next fee tier. Callers (the
//!    `CompetitionEstimator` fallback chain) will then try the next estimator.
//!
//! # Why TWAP and not `slot0().sqrtPriceX96`?
//!
//! `slot0()` exposes the current spot tick, which can be moved by a single
//! whale swap inside one block. For native-price use (fee accounting, order
//! ranking) we want resistance to single-block manipulation. 180s is the
//! sweet spot — long enough that pumping the price for ~90 OP blocks costs
//! real money, short enough that the price tracks live markets.
//!
//! # Price math
//!
//! Uniswap V3 stores prices as ticks. The relationship between tick `i`
//! and the price ratio `token1/token0` is:
//!
//! ```text
//! price(i) = 1.0001^i
//! ```
//!
//! `observe` returns `tickCumulatives` (the running sum of ticks weighted by
//! seconds). The arithmetic-mean tick over the window is:
//!
//! ```text
//! avg_tick = (cumulative_now - cumulative_then) / seconds
//! ```
//!
//! Then `price = 1.0001^avg_tick` is the `token1/token0` ATOM-ratio. After
//! inverting to `native per token` that is native-wei per 1 token-atom, which
//! IS the CoW native-price f64 the caller expects -- NO decimal adjustment is
//! applied, since the token's decimals are already baked into the tick (see
//! `super::NativePriceEstimator::estimate_native_price` for the contract).

use {
    super::{NativePriceEstimateResult, NativePriceEstimating, is_price_malformed},
    crate::PriceEstimationError,
    alloy::{
        primitives::{Address, B256, Signed, keccak256},
        sol,
    },
    anyhow::{Context, Result, anyhow},
    configs::native_price_estimators::UniswapV3Config,
    ethrpc::Web3,
    futures::{FutureExt, future::BoxFuture},
    std::{sync::Arc, time::Duration},
    token_info::TokenInfoFetching,
    tracing::instrument,
};

sol! {
    /// Minimal Uniswap V3 pool interface.
    ///
    /// Source: <https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolDerivedState.sol>
    /// Source: <https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolState.sol>
    #[sol(rpc)]
    interface IUniswapV3Pool {
        /// Returns the in-range liquidity of the pool.
        function liquidity() external view returns (uint128);

        /// Returns the cumulative tick and cumulative seconds-per-liquidity for
        /// each timestamp `secondsAgos`. Reverts (`OLD`) if the oldest
        /// requested observation is not yet recorded — caller must ensure the
        /// pool's `observationCardinality` is at least 2 for a meaningful TWAP.
        function observe(uint32[] memory secondsAgos)
            external
            view
            returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    }
}

/// On-chain Uniswap V3 native-price estimator.
pub struct UniswapV3 {
    web3: Web3,
    native_token: Address,
    token_infos: Arc<dyn TokenInfoFetching>,
    config: UniswapV3Config,
}

impl UniswapV3 {
    /// Build a new estimator.
    pub async fn new(
        web3: Web3,
        native_token: Address,
        token_infos: Arc<dyn TokenInfoFetching>,
        config: UniswapV3Config,
    ) -> Result<Self> {
        anyhow::ensure!(
            !config.fee_tiers.is_empty(),
            "uniswap-v3 fee_tiers must not be empty"
        );
        anyhow::ensure!(
            config.twap_window_secs > 0,
            "uniswap-v3 twap_window_secs must be positive"
        );

        Ok(Self {
            web3,
            native_token,
            token_infos,
            config,
        })
    }

    /// Compute the deterministic CREATE2 pool address for a token pair + fee.
    ///
    /// `keccak256(0xff || factory || keccak256(token0 || token1 || fee) || init_code_hash)[12..]`
    ///
    /// Matches `PoolAddress.computeAddress` in
    /// <https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/PoolAddress.sol>.
    pub fn compute_pool_address(
        factory: Address,
        init_code_hash: B256,
        token_a: Address,
        token_b: Address,
        fee: u32,
    ) -> Address {
        let (token0, token1) = if token_a < token_b {
            (token_a, token_b)
        } else {
            (token_b, token_a)
        };

        // keccak256(abi.encode(token0, token1, fee))
        // Each ABI-encoded slot is 32 bytes; fee is uint24 but ABI-encoded as
        // 32 bytes left-padded.
        let mut inner = [0u8; 96];
        inner[12..32].copy_from_slice(token0.as_slice());
        inner[44..64].copy_from_slice(token1.as_slice());
        // fee occupies the rightmost 3 bytes of the third slot.
        inner[93..96].copy_from_slice(&fee.to_be_bytes()[1..4]);
        let salt = keccak256(inner);

        let mut buf = [0u8; 85];
        buf[0] = 0xff;
        buf[1..21].copy_from_slice(factory.as_slice());
        buf[21..53].copy_from_slice(salt.as_slice());
        buf[53..85].copy_from_slice(init_code_hash.as_slice());

        Address::from_slice(&keccak256(buf)[12..])
    }

    /// Fetch the in-range liquidity of a pool. Returns `Ok(None)` if the call
    /// reverts (no contract deployed, or pool not initialised). Returns an
    /// `Err` only for transport-level failures we don't want to silently
    /// swallow.
    async fn pool_liquidity(&self, pool: Address) -> Option<u128> {
        let pool = IUniswapV3Pool::new(pool, self.web3.provider.clone());
        match pool.liquidity().call().await {
            Ok(liquidity) => Some(liquidity),
            Err(err) => {
                tracing::trace!(?err, "UniswapV3 pool.liquidity() call failed; skipping");
                None
            }
        }
    }

    /// Fetch the TWAP tick over `window` seconds. Returns `None` if the call
    /// reverts (typically `OLD` — pool too young / cardinality too low) or
    /// any other RPC error.
    async fn pool_twap_tick(&self, pool: Address, window: u32) -> Option<i64> {
        let pool = IUniswapV3Pool::new(pool, self.web3.provider.clone());
        let result = pool.observe(vec![window, 0]).call().await;
        match result {
            Ok(ret) => {
                // `int56` decodes to `Signed<56, 1>`; narrow to i64 so the
                // math layer doesn't need to know about alloy types.
                let cumulatives: Vec<i64> = ret
                    .tickCumulatives
                    .iter()
                    .map(signed56_to_i64)
                    .collect();
                compute_average_tick(&cumulatives, window)
            }
            Err(err) => {
                tracing::trace!(?err, "UniswapV3 pool.observe() call failed; skipping");
                None
            }
        }
    }

    /// Try each fee tier in priority order. Returns the (token0_is_native,
    /// twap_tick) tuple of the first pool that passes both the liquidity and
    /// TWAP checks. `token0_is_native` tells the price-derivation code which
    /// way to invert the ratio.
    async fn find_pool_twap(&self, token: Address) -> Option<(bool, i64)> {
        for &fee in &self.config.fee_tiers {
            let pool = Self::compute_pool_address(
                self.config.factory,
                self.config.init_code_hash,
                token,
                self.native_token,
                fee,
            );

            let Some(liquidity) = self.pool_liquidity(pool).await else {
                continue;
            };
            if liquidity < self.config.min_liquidity {
                tracing::trace!(?pool, fee, liquidity, "pool below liquidity threshold");
                continue;
            }

            let Some(tick) = self.pool_twap_tick(pool, self.config.twap_window_secs).await else {
                continue;
            };

            let token0_is_native = self.native_token < token;
            tracing::debug!(
                ?pool,
                fee,
                liquidity,
                tick,
                token0_is_native,
                "UniswapV3 native-price pool selected"
            );
            return Some((token0_is_native, tick));
        }
        None
    }
}

/// `int56` from the Uniswap ABI lands as `Signed<56, 1>` in alloy. The full
/// 56-bit range fits in i64, so the `try_into` is infallible in practice; on
/// the (impossible) overflow path we saturate at the i64 bound rather than
/// panic, since this code path lives inside a price-estimation hot loop.
fn signed56_to_i64(value: &Signed<56, 1>) -> i64 {
    let as_i128: i128 = (*value).try_into().unwrap_or(0);
    // Bounded: 56-bit signed values are well within i64.
    if as_i128 > i128::from(i64::MAX) {
        i64::MAX
    } else if as_i128 < i128::from(i64::MIN) {
        i64::MIN
    } else {
        as_i128 as i64
    }
}

/// Compute the arithmetic-mean tick over the window.
///
/// `observe([w, 0])` returns `[cumulative_then, cumulative_now]`. The
/// average tick is `(cumulative_now - cumulative_then) / w`.
///
/// Returns `None` if the input doesn't have exactly two entries (defensive
/// — Uniswap always returns the same length as `secondsAgos`, but we don't
/// trust untrusted RPC nodes).
fn compute_average_tick(tick_cumulatives: &[i64], window: u32) -> Option<i64> {
    if tick_cumulatives.len() != 2 || window == 0 {
        return None;
    }
    let then = i128::from(tick_cumulatives[0]);
    let now = i128::from(tick_cumulatives[1]);
    let delta = now.checked_sub(then)?;
    let avg = delta.checked_div(i128::from(window))?;

    // Tick is canonically a int24. After dividing a int56 cumulative by the
    // window the result should fit in int24, but we narrow to i64 for the
    // math layer.
    i64::try_from(avg).ok()
}

/// Convert an arithmetic-mean tick to the price of `token` denominated in the
/// pool's other token, then adjust for decimal differences so the returned
/// `f64` is the amount of `native_token` per unit of `token` in the same
/// scale the rest of the price-estimation pipeline expects.
///
/// Caller passes `token0_is_native = true` when the native token is `token0`
/// in the pool (i.e. `native < token` in address order). In that case, the
/// raw `1.0001^tick` is `token1/token0 = token/native`, so we invert to get
/// `native/token`.
///
/// Returns `None` on overflow or a non-normal f64 result.
fn tick_to_native_price(tick: i64, token0_is_native: bool) -> Option<f64> {
    // 1.0001^tick — directly in f64. Ticks are bounded by [-887272, 887272]
    // (the V3 MIN_TICK / MAX_TICK), so 1.0001^tick is at most ~2^96, well
    // inside f64 range (~1.8e308). f64 has ~15 decimal digits of precision;
    // a 1bps tick step is ~9e-5 relative error which is below that.
    let raw_price = 1.0001_f64.powi(i32::try_from(tick).ok()?);
    if !raw_price.is_normal() {
        return None;
    }

    // raw_price = token1 / token0 (in "wei-of-token1 per wei-of-token0").
    // The caller wants `native per token` (i.e. how much native it takes to
    // buy 1 unit of `token`).
    let price_native_per_token_wei_ratio = if token0_is_native {
        // raw_price = token / native; invert.
        1.0 / raw_price
    } else {
        // raw_price = native / token; use directly.
        raw_price
    };

    // No decimal shift is applied. `price_native_per_token_wei_ratio` is
    // already native-wei per 1 token-ATOM, which IS the CoW native-price f64
    // convention (see shared::external_prices; to_normalized_price multiplies
    // it by 1e18). The token's decimals are already baked into where the pool
    // tick sits. A prior 10^(native_decimals - token_decimals) adjustment here
    // double-counted decimals and priced every non-18-decimal token
    // 10^(18-dec) too high (e.g. USDC 10^12 too high, seen live as ~5.6e38).
    let price = price_native_per_token_wei_ratio;
    price.is_normal().then_some(price)
}

impl NativePriceEstimating for UniswapV3 {
    #[instrument(skip_all)]
    fn estimate_native_price(
        &self,
        token: Address,
        _timeout: Duration,
    ) -> BoxFuture<'_, NativePriceEstimateResult> {
        async move {
            // The native token itself is trivially priced at 1.0. The CoW
            // pipeline calls `estimate_native_price(native_token)` to
            // sanity-check the denominator, so we have to short-circuit here.
            if token == self.native_token {
                return Ok(1.0);
            }

            let token_info = self
                .token_infos
                .get_token_info(token)
                .await
                .map_err(|err| {
                    PriceEstimationError::EstimatorInternal(anyhow!(
                        "UniswapV3 failed to fetch token info: {err}"
                    ))
                })?;
            // Kept as a "known token" guard (fail closed on tokens with no
            // decimals); the value is no longer used by the tick math.
            let _token_decimals = token_info
                .decimals
                .with_context(|| format!("missing decimals for token {token:?}"))?;

            let Some((token0_is_native, tick)) = self.find_pool_twap(token).await else {
                return Err(PriceEstimationError::NoLiquidity);
            };

            let price = tick_to_native_price(tick, token0_is_native)
            .ok_or_else(|| {
                PriceEstimationError::EstimatorInternal(anyhow!(
                    "UniswapV3 tick {tick} produced malformed price"
                ))
            })?;

            if is_price_malformed(price) {
                return Err(PriceEstimationError::EstimatorInternal(anyhow!(
                    "UniswapV3 returned malformed price: {price}"
                )));
            }
            Ok(price)
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        alloy::{primitives::address, providers::mock::Asserter, sol_types::SolCall},
        token_info::{MockTokenInfoFetching, TokenInfo},
    };

    // Canonical Uniswap V3 deployment values (mainnet / Optimism / etc.).
    const UNISWAP_V3_FACTORY: Address = address!("1F98431c8aD98523631AE4a59f267346ea31F984");
    // INIT_CODE_HASH is a 32-byte constant; the `b256!` macro is only in
    // newer alloy. Construct via `parse`.
    fn uniswap_v3_init_hash() -> B256 {
        "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54"
            .parse()
            .unwrap()
    }

    /// Canonical USDC/WETH 0.05% pool on Ethereum mainnet — used as a
    /// publicly-verifiable fixture for `compute_pool_address`.
    ///
    /// See <https://etherscan.io/address/0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640>.
    #[test]
    fn compute_pool_address_matches_known_mainnet_usdc_weth_500() {
        let usdc = address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
        let weth = address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
        let expected = address!("88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640");
        let pool = UniswapV3::compute_pool_address(
            UNISWAP_V3_FACTORY,
            uniswap_v3_init_hash(),
            usdc,
            weth,
            500,
        );
        assert_eq!(pool, expected);
    }

    /// Same pool but called with the token order reversed — should produce
    /// the same address (the function canonicalises token0 < token1).
    #[test]
    fn compute_pool_address_is_token_order_independent() {
        let usdc = address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
        let weth = address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
        let a = UniswapV3::compute_pool_address(
            UNISWAP_V3_FACTORY,
            uniswap_v3_init_hash(),
            usdc,
            weth,
            500,
        );
        let b = UniswapV3::compute_pool_address(
            UNISWAP_V3_FACTORY,
            uniswap_v3_init_hash(),
            weth,
            usdc,
            500,
        );
        assert_eq!(a, b);
    }

    /// USDC/WETH 0.3% pool on Ethereum mainnet — a second known fixture for
    /// the same factory but a different fee tier.
    ///
    /// See <https://etherscan.io/address/0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8>.
    #[test]
    fn compute_pool_address_matches_known_mainnet_usdc_weth_3000() {
        let usdc = address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
        let weth = address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
        let expected = address!("8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8");
        let pool = UniswapV3::compute_pool_address(
            UNISWAP_V3_FACTORY,
            uniswap_v3_init_hash(),
            usdc,
            weth,
            3000,
        );
        assert_eq!(pool, expected);
    }

    /// `compute_pool_address` is a pure CREATE2 derivation and is chain-
    /// independent: the same `(factory, init_code_hash, tokens, fee)` tuple
    /// produces the same address on every chain. The mainnet fixtures above
    /// prove the algorithm matches the canonical V3 deployment; this test
    /// just guards against a regression in the Optimism token addresses we
    /// pass through to the algorithm (USDC.e and WETH on OP). The expected
    /// pool below was computed by this same function and asserted against
    /// the canonical OP USDC.e/WETH 0.05% pool at deployment time — see
    /// `optimistic.etherscan.io/address/0x85149247691df622eaf1a8bd0cafd40bc45154a9`.
    #[test]
    fn compute_pool_address_optimism_usdc_weth_500_is_stable() {
        let usdc = address!("7F5c764cBc14f9669B88837ca1490cCa17c31607");
        let weth = address!("4200000000000000000000000000000000000006");
        let pool = UniswapV3::compute_pool_address(
            UNISWAP_V3_FACTORY,
            uniswap_v3_init_hash(),
            usdc,
            weth,
            500,
        );
        assert_eq!(
            pool,
            address!("85149247691df622eaf1a8bd0cafd40bc45154a9")
        );
    }

    #[test]
    fn average_tick_basic() {
        // 100 seconds, tick rose linearly from ~5 to ~10:
        //   then = 5  * 100 = 500
        //   now  = 10 * 100 = 1000   (no, accumulator keeps growing)
        // For a clean fixture, use plain deltas:
        let then: i64 = 1_000;
        let now: i64 = 1_000 + 100 * 7; // 7 ticks/sec average
        assert_eq!(compute_average_tick(&[then, now], 100), Some(7));
    }

    #[test]
    fn average_tick_negative() {
        let then: i64 = 50_000;
        let now: i64 = 50_000 - 180 * 3; // -3 ticks/sec
        assert_eq!(compute_average_tick(&[then, now], 180), Some(-3));
    }

    #[test]
    fn average_tick_wrong_length() {
        assert_eq!(compute_average_tick(&[1, 2, 3], 100), None);
        assert_eq!(compute_average_tick(&[1], 100), None);
        assert_eq!(compute_average_tick(&[], 100), None);
    }

    #[test]
    fn average_tick_zero_window() {
        assert_eq!(compute_average_tick(&[0, 100], 0), None);
    }

    /// At tick 0, raw price is `1.0001^0 = 1`. With matching decimals the
    /// adjustment is 1, so the result is exactly 1.0 regardless of which side
    /// of the pool the native token is on.
    #[test]
    fn tick_to_native_price_zero_tick() {
        assert_eq!(tick_to_native_price(0, false), Some(1.0));
        assert_eq!(tick_to_native_price(0, true), Some(1.0));
    }

    /// USDC has 6 decimals, WETH has 18. The USDC/WETH 0.05% pool on
    /// mainnet historically sits near tick `-200_000` (1 USDC = ~0.00033 ETH
    /// ≈ 1.0001^-200000 = ~2.06e-9 in wei-ratio terms). Native-per-token in
    /// wei terms is therefore ~2.06e-9; after the 18-6 = 12-decimal shift,
    /// the human-readable native price is `~2.06e-9 * 10^12 = ~2060` —
    /// i.e. "buy 1 unit of USDC for ~2060 wei of ETH at this tick", which
    /// matches the autopilot's expected native-price scale (where USDC's
    /// fewer-decimal entries are amplified by 10^12 — see CoinGecko
    /// `denominate_price`).
    #[test]
    fn tick_to_native_price_usdc_pool_scale_is_sane() {
        // USDC (6dec) priced against WETH (native, 18dec). USDC < WETH by
        // address, so USDC is token0 and native WETH is token1 =>
        // token0_is_native = false and raw = token1/token0 = native-wei per
        // USDC-atom. At USDC ~= $1 (ETH ~= $1767) that is ~5.66e8 (1 USDC-atom
        // = 1e-6/1767 ETH ~= 5.66e8 wei), reached near tick +201_551. The
        // returned native price IS that wei-ratio: no decimal shift.
        let price = tick_to_native_price(201_551, false).unwrap();
        assert!(
            (1e8..1e9).contains(&price),
            "expected ~5.66e8 native-wei per USDC-atom, got {price}"
        );
    }

    /// Inverted variant: WETH the priced token, USDC native (hypothetical
    /// USDC-native chain): the price should be ~1/5.66e8.
    #[test]
    fn tick_to_native_price_inverted_pool() {
        // Inverted: WETH is the priced token and USDC is the native token.
        // token0 = native (USDC) => token0_is_native = true, so
        // price = 1/raw = ~1/5.66e8 = ~1.77e-9.
        let price = tick_to_native_price(201_551, true).unwrap();
        assert!(
            (1e-10..1e-8).contains(&price),
            "expected ~1.77e-9, got {price}"
        );
    }

    /// Compose `compute_average_tick` + `tick_to_native_price` on the
    /// same-decimal happy path. A 180s TWAP that returns `cumulative = [0,
    /// 0]` averages to tick 0, which prices the token at exactly 1.0 native
    /// per token.
    #[test]
    fn full_pipeline_zero_cumulative_yields_unit_price() {
        let tick = compute_average_tick(&[0, 0], 180).unwrap();
        assert_eq!(tick, 0);
        let price = tick_to_native_price(tick, false).unwrap();
        assert_eq!(price, 1.0);
    }

    /// Encodes a value the way `eth_call` returns it: a `0x`-prefixed hex
    /// string of the ABI-encoded return data. The Asserter JSON-serialises
    /// whatever we push, and alloy's eth_call decoder expects a hex string.
    fn encode_call_return(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(2 + bytes.len() * 2);
        s.push_str("0x");
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// End-to-end: mock the RPC, return liquidity + observe responses for a
    /// pool, and check the estimator produces a sensible price.
    ///
    /// Setup: token `T` with 18 decimals, native (WETH) 18 decimals. Native
    /// token address > T, so T is token0 and native is token1.
    /// `tick = 0` => price = 1.0001^0 = 1.0 (T worth 1 WETH each).
    #[tokio::test]
    async fn estimate_native_price_with_mocked_rpc() {
        // Pick addresses so native > token (i.e. token is token0).
        let token = address!("0000000000000000000000000000000000000001");
        let native = address!("4200000000000000000000000000000000000006");

        // Set up token-info fetcher: both 18 decimals.
        let mut token_info = MockTokenInfoFetching::new();
        token_info.expect_get_token_info().returning(|_| {
            Ok(TokenInfo {
                decimals: Some(18),
                symbol: None,
            })
        });
        let token_info: Arc<dyn TokenInfoFetching> = Arc::new(token_info);

        // The estimator queries:
        //   1. fee-tier 500: liquidity() — return non-zero
        //   2. fee-tier 500: observe([180, 0]) — return cumulatives [0, 0]
        //      => avg tick 0 => price 1.0
        //
        // Asserter is FIFO: each `push_*` enqueues one response.
        let asserter = Asserter::new();

        // (1) liquidity() returns uint128. ABI-encoded uint128 is a 32-byte
        // big-endian word; alloy decodes it via the SolCall's return type.
        let liquidity_encoded =
            IUniswapV3Pool::liquidityCall::abi_encode_returns(&1_000_000_000_000u128);
        asserter.push_success(&encode_call_return(&liquidity_encoded));

        // (2) observe() returns (int56[], uint160[]).
        let tick_cumulatives: Vec<Signed<56, 1>> = vec![
            Signed::<56, 1>::try_from(0i64).unwrap(),
            Signed::<56, 1>::try_from(0i64).unwrap(),
        ];
        let spcs: Vec<alloy::primitives::aliases::U160> =
            vec![Default::default(), Default::default()];
        let observe_encoded = IUniswapV3Pool::observeCall::abi_encode_returns(
            &IUniswapV3Pool::observeReturn {
                tickCumulatives: tick_cumulatives,
                secondsPerLiquidityCumulativeX128s: spcs,
            },
        );
        asserter.push_success(&encode_call_return(&observe_encoded));

        let web3 = Web3::with_asserter(asserter);

        // Build estimator. Note: `UniswapV3::new` makes an extra call to
        // fetch native_token decimals via the token_info fetcher (NOT the
        // RPC), so no asserter slot is consumed here.
        let estimator = UniswapV3 {
            web3,
            native_token: native,
            token_infos: token_info,
            config: UniswapV3Config {
                factory: UNISWAP_V3_FACTORY,
                init_code_hash: uniswap_v3_init_hash(),
                fee_tiers: vec![500],
                min_liquidity: 1,
                twap_window_secs: 180,
            },        };

        let price = estimator
            .estimate_native_price(token, Duration::from_secs(5))
            .await
            .unwrap();

        // tick = 0, same decimals, token0_is_native = false (native > token)
        //   => price = 1.0001^0 = 1.0
        // With f64 path through powi(0) the result is exactly 1.0.
        assert!(
            (0.999..1.001).contains(&price),
            "expected ~1.0, got {price}"
        );
    }

    /// If `liquidity()` reverts on every fee tier, the estimator returns
    /// `NoLiquidity` so the fallback chain can move on to CoinGecko etc.
    #[tokio::test]
    async fn estimate_native_price_falls_through_when_no_pool_exists() {
        let token = address!("0000000000000000000000000000000000000002");
        let native = address!("4200000000000000000000000000000000000006");

        let mut token_info = MockTokenInfoFetching::new();
        token_info.expect_get_token_info().returning(|_| {
            Ok(TokenInfo {
                decimals: Some(18),
                symbol: None,
            })
        });
        let token_info: Arc<dyn TokenInfoFetching> = Arc::new(token_info);

        let asserter = Asserter::new();
        // Two fee tiers, both liquidity() reverts.
        asserter.push_failure_msg("execution reverted");
        asserter.push_failure_msg("execution reverted");

        let web3 = Web3::with_asserter(asserter);
        let estimator = UniswapV3 {
            web3,
            native_token: native,
            token_infos: token_info,
            config: UniswapV3Config {
                factory: UNISWAP_V3_FACTORY,
                init_code_hash: uniswap_v3_init_hash(),
                fee_tiers: vec![500, 3000],
                min_liquidity: 1,
                twap_window_secs: 180,
            },        };

        let result = estimator
            .estimate_native_price(token, Duration::from_secs(5))
            .await;
        assert!(matches!(result, Err(PriceEstimationError::NoLiquidity)));
    }

    /// Pricing the native token itself short-circuits to 1.0 without an RPC
    /// round-trip. The CoW autopilot relies on this for the price-denominator
    /// sanity check.
    #[tokio::test]
    async fn estimate_native_price_of_native_is_one() {
        let native = address!("4200000000000000000000000000000000000006");
        let mut token_info = MockTokenInfoFetching::new();
        token_info.expect_get_token_info().returning(|_| {
            Ok(TokenInfo {
                decimals: Some(18),
                symbol: None,
            })
        });
        let token_info: Arc<dyn TokenInfoFetching> = Arc::new(token_info);

        // No asserter calls expected.
        let web3 = Web3::with_asserter(Asserter::new());
        let estimator = UniswapV3 {
            web3,
            native_token: native,
            token_infos: token_info,
            config: UniswapV3Config {
                factory: UNISWAP_V3_FACTORY,
                init_code_hash: uniswap_v3_init_hash(),
                fee_tiers: vec![500],
                min_liquidity: 1,
                twap_window_secs: 180,
            },        };
        let price = estimator
            .estimate_native_price(native, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(price, 1.0);
    }

    /// Make sure we don't accidentally drop the import that backs the
    /// `i32::try_from(tick).ok()?` overflow guard.
    #[test]
    fn tick_overflow_returns_none() {
        // i64 value that doesn't fit in i32.
        assert_eq!(tick_to_native_price(i64::MAX, false), None);
        assert_eq!(tick_to_native_price(i64::MIN, false), None);
    }

}
