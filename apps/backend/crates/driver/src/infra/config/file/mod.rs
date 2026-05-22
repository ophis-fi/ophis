pub use load::load;
use {
    crate::infra,
    alloy::{eips::BlockNumberOrTag, primitives::Address},
    configs::gas_price_estimation::{default_past_blocks, default_reward_percentile},
    eth_domain_types as eth,
    number::serialization::HexOrDecimalU256,
    reqwest::Url,
    serde::{Deserialize, Deserializer, Serialize},
    serde_with::serde_as,
    solver::solver::Arn,
    std::{collections::HashMap, num::NonZeroUsize, time::Duration},
};

mod load;

#[serde_as]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Optionally specify the chain ID that that driver is configured for.
    /// Note that the actual chain ID is fetched from the configured Ethereum
    /// RPC endpoint, and the driver will exit if it does not match this
    /// value.
    chain_id: Option<u64>,

    /// Disable access list simulation, useful for environments that don't
    /// support this, such as less popular blockchains.
    #[serde(default)]
    disable_access_list_simulation: bool,

    /// Disable gas simulation and always use this fixed gas value instead. This
    /// can be useful for testing, but shouldn't be used in production since it
    /// will cause the driver to return invalid scores.
    #[serde_as(as = "Option<serde_ext::U256>")]
    disable_gas_simulation: Option<eth::U256>,

    /// Defines the gas estimator to use.
    #[serde(default)]
    gas_estimator: GasEstimatorType,

    /// Parameters related to settlement submission.
    #[serde(default)]
    submission: SubmissionConfig,

    /// Override smart contract addresses.
    #[serde(default)]
    contracts: ContractsConfig,

    /// Liquidity sources notifier configuration.
    liquidity_sources_notifier: Option<LiquiditySourcesNotifier>,

    #[serde(rename = "solver")]
    solvers: Vec<SolverConfig>,

    #[serde(default)]
    liquidity: LiquidityConfig,

    /// Defines order prioritization strategies that will be applied in the
    /// specified order.
    #[serde(
        rename = "order-priority",
        default = "default_order_priority_strategies"
    )]
    order_priority_strategies: Vec<OrderPriorityStrategy>,

    /// How long should the token quality computed by the simulation
    /// based logic be cached.
    #[serde(
        with = "humantime_serde",
        default = "default_simulation_bad_token_max_age"
    )]
    simulation_bad_token_max_age: Duration,

    /// Configuration for the app-data fetching.
    #[serde(default, flatten)]
    app_data_fetching: AppDataFetching,

    /// Whether the flashloans feature is enabled.
    #[serde(default)]
    flashloans_enabled: bool,

    #[serde_as(as = "HexOrDecimalU256")]
    tx_gas_limit: eth::U256,

    #[serde(default)]
    simulator: configs::simulator::Config,

    /// Http client factory config
    #[serde(default)]
    http: configs::http_client::HttpClient,
}

#[serde_as]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct SubmissionConfig {
    /// The minimum priority fee in Gwei the solver is ensuring to pay in a
    /// settlement.
    #[serde(default)]
    #[serde_as(as = "serde_ext::U256")]
    min_priority_fee: eth::U256,

    /// The maximum gas price in Gwei the solver is willing to pay in a
    /// settlement.
    #[serde(default = "default_gas_price_cap")]
    #[serde_as(as = "serde_ext::U256")]
    gas_price_cap: eth::U256,

    /// The target confirmation time for settlement transactions used
    /// to estimate gas price.
    #[serde(with = "humantime_serde", default = "default_target_confirm_time")]
    target_confirm_time: Duration,

    /// Amount of time to wait before retrying to submit the tx to
    /// the ethereum network.
    #[serde(with = "humantime_serde", default = "default_retry_interval")]
    retry_interval: Duration,

    /// Block number to use when fetching nonces. Options: "pending",
    /// "latest", "earliest". If not specified, uses the web3 lib's default
    /// behavior.
    #[serde(default)]
    nonce_block_number: Option<BlockNumber>,

    /// The mempools to submit settlement transactions to. Can be the public
    /// mempool of a node or the private MEVBlocker mempool.
    #[serde(rename = "mempool", default)]
    mempools: Vec<Mempool>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BlockNumber {
    Pending,
    Latest,
    Earliest,
}

impl From<BlockNumber> for BlockNumberOrTag {
    fn from(value: BlockNumber) -> Self {
        match value {
            BlockNumber::Pending => Self::Pending,
            BlockNumber::Latest => Self::Latest,
            BlockNumber::Earliest => Self::Earliest,
        }
    }
}

#[serde_as]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct Mempool {
    /// Name for better logging and metrics.
    name: Option<String>,
    /// The RPC URL to use.
    url: Url,
    /// Maximum additional tip in Gwei that we are willing to give to
    /// the validator above regular gas price estimation.
    #[serde(default = "default_max_additional_tip")]
    #[serde_as(as = "serde_ext::U256")]
    max_additional_tip: eth::U256,
    /// Additional tip in percentage of max_fee_per_gas we are giving to
    /// validator above regular gas price estimation. Expects a
    /// floating point value between 0 and 1.
    #[serde(default = "default_additional_tip_percentage")]
    additional_tip_percentage: f64,
    /// Informs the submission logic whether a reverting transaction will
    /// actually be mined or just ignored. This is an advanced feature
    /// for private mempools so for most configured mempools you have to
    /// assume reverting transactions will get mined eventually.
    #[serde(default = "default_mines_reverting_txs")]
    mines_reverting_txs: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct ManageNativeToken {
    /// If true wraps ETH address
    wrap_address: bool,
    /// If true inserts unwrap interactions
    insert_unwraps: bool,
}

impl Default for ManageNativeToken {
    fn default() -> Self {
        Self {
            wrap_address: true,
            insert_unwraps: true,
        }
    }
}

impl ManageNativeToken {
    pub fn to_domain(&self) -> infra::solver::ManageNativeToken {
        infra::solver::ManageNativeToken {
            wrap_address: self.wrap_address,
            insert_unwraps: self.insert_unwraps,
        }
    }
}

fn default_additional_tip_percentage() -> f64 {
    0.05
}

/// 1000 gwei
fn default_gas_price_cap() -> eth::U256 {
    eth::U256::from(1000) * eth::U256::from(10).pow(eth::U256::from(9))
}

fn default_target_confirm_time() -> Duration {
    Duration::from_secs(30)
}

fn default_retry_interval() -> Duration {
    Duration::from_secs(2)
}

/// 3 gwei
fn default_max_additional_tip() -> eth::U256 {
    eth::U256::from(3) * eth::U256::from(10).pow(eth::U256::from(9))
}

fn default_mines_reverting_txs() -> bool {
    true
}

/// Lower bound on `tx_gas_limit`. 1M gas — below this, a settlement
/// tx cannot fit even a trivial single-fill (settle() overhead alone
/// is ~150k; a real fill is 300-900k). The PR-228 Codex audit
/// (2026-05-22) tightened this from the EIP-1559 intrinsic 21k to a
/// settlement-realistic floor that catches operator typos like
/// `tx-gas-limit = 21000` mistaking it for the intrinsic.
pub const MIN_TX_GAS_LIMIT: u64 = 1_000_000;

/// Upper bound on `tx_gas_limit`. 60M = Ethereum Fusaka mainnet block
/// gas limit (raised 2025-Oct from 30M).
///
/// Note: Fusaka also introduced a per-transaction gas cap of 16,777,216
/// (~16.77M) — so a 60M config value would be valid at the config layer
/// but rejected by the node at submission time on Fusaka mainnet. That
/// per-chain enforcement is a runtime concern handled by
/// `block_gas_limit()` checks at the simulator + submitter, not at
/// config load. This ceiling exists only to catch obvious operator
/// mistakes like `u64::MAX` — chains with different per-block gas
/// (60M Fusaka, 30M pre-Fusaka, 30M Optimism, etc.) all fit comfortably
/// under this single chain-agnostic config-time ceiling.
///
/// PR-228 audit-response Codex re-MED (2026-05-22): raised from 30M
/// after Codex pointed out current operator configs use 45M
/// (example.toml + playground/driver.toml).
const MAX_TX_GAS_LIMIT: u64 = 60_000_000;

/// Upper bound on `haircut_bps`. Basis points cap at 10000 = 100%.
/// Configs above this would scale solver-reported surplus into
/// negative territory — a config mistake, not a feature.
pub const MAX_HAIRCUT_BPS: u32 = 10_000;

/// Cap on `additional_tip_percentage` and `metrics_strategy_failure_ratio`.
/// Both are documented [0.0, 1.0] but neither was enforced. Sharp-edges
/// Sharp-edges PR-228 audit MED (2026-05-22): same vulnerability class as L1.
const FRACTION_RANGE: std::ops::RangeInclusive<f64> = 0.0..=1.0;

/// Cap on `reward_percentile`. Percentile values are in [0.0, 100.0];
/// alloy's `eth_feeHistory` silently saturates or errors at runtime if
/// passed values outside this range. Sharp-edges PR-228 audit MED.
const PERCENTILE_RANGE: std::ops::RangeInclusive<f64> = 0.0..=100.0;

/// Validate `tx_gas_limit` is within the supported range.
///
/// Closes Phase 2 audit finding C4 (sub-piece): config-time `tx_gas_limit`
/// previously accepted any `U256` (including 0 and `U256::MAX`). Now
/// asserted at config load against `[MIN_TX_GAS_LIMIT, MAX_TX_GAS_LIMIT]`.
/// Tests in [`tests::tx_gas_limit_*`].
fn validate_tx_gas_limit(v: eth::U256) -> Result<(), String> {
    let min = eth::U256::from(MIN_TX_GAS_LIMIT);
    let max = eth::U256::from(MAX_TX_GAS_LIMIT);
    if v < min {
        return Err(format!(
            "tx_gas_limit = {v} is below the {MIN_TX_GAS_LIMIT}-gas settlement floor; real \
             settlement txs need at least ~1M gas (settle() overhead ~150k + fills 300-900k)"
        ));
    }
    if v > max {
        return Err(format!(
            "tx_gas_limit = {v} exceeds the {MAX_TX_GAS_LIMIT}-gas block-fit ceiling; this is \
             above the Ethereum/Optimism mainnet block gas limit and cannot fit in a single \
             block — almost certainly a config mistake"
        ));
    }
    Ok(())
}

/// Validate `haircut_bps` is within `[0, MAX_HAIRCUT_BPS]`.
///
/// Closes Phase 2 audit finding C4 (sub-piece): the docstring at the
/// field declared the 0-10000 range but no code enforced it. Now
/// asserted at config load.
fn validate_haircut_bps(v: u32) -> Result<(), String> {
    if v > MAX_HAIRCUT_BPS {
        return Err(format!(
            "haircut_bps = {v} exceeds MAX_HAIRCUT_BPS ({MAX_HAIRCUT_BPS} = 100%). Basis \
             points must be in [0, 10000]; values above 10000 would invert solver economics"
        ));
    }
    Ok(())
}

/// Validate `solving_share_of_deadline` is a finite real number in
/// `[0.0, 1.0]`. Closes Phase 2 audit finding L1 (NaN/∞/negative
/// previously accepted; downstream `Percent::try_from(f64)` would
/// then `unwrap()` panic at config load with `OutOfRangeError` — this
/// validator surfaces the bad value AND the field name).
fn validate_solving_share_of_deadline(v: f64) -> Result<(), String> {
    if !v.is_finite() {
        return Err(format!(
            "solving_share_of_deadline = {v} is not a finite number (NaN/Inf rejected); \
             expected a value in [0.0, 1.0]"
        ));
    }
    if !(0.0..=1.0).contains(&v) {
        return Err(format!(
            "solving_share_of_deadline = {v} is outside [0.0, 1.0]; the solver's share of \
             the auction deadline must be a fraction (0 = no solving time, 1 = full deadline)"
        ));
    }
    Ok(())
}

/// Aggregate validator invoked by `load::load()` after TOML
/// deserialization. Runs all per-field range checks across the top-level
/// `Config` and every `SolverConfig`. Returns the first violation found
/// with a structured error message (field name + offending value +
/// solver name where applicable).
///
/// Locking this into a single function lets us cover the "iterates ALL
/// solvers, not just the first" wiring invariant with a unit test
/// against a TOML fixture, without needing the heavier `load::load()`
/// async-file-IO path. Closes Codex PR-228 LOW.
///
/// Visibility: default (file-module-private). Called from `super::load`
/// via `super::validate_config_for_load`. The `Config` type is private
/// to this module, so any `pub`/`pub(super)`/`pub(crate)` visibility on
/// this function would emit a "more private than the item" warning.
fn validate_config_for_load(config: &Config) -> Result<(), String> {
    validate_tx_gas_limit(config.tx_gas_limit)?;

    // Top-level submission mempools — each can override
    // additional_tip_percentage.
    for (i, mempool) in config.submission.mempools.iter().enumerate() {
        if let Err(e) = validate_additional_tip_percentage(mempool.additional_tip_percentage) {
            let label = mempool.name.as_deref().unwrap_or("<unnamed>");
            return Err(format!("mempool #{i} '{label}': {e}"));
        }
    }

    // Top-level gas_estimator.reward_percentile lives inside the
    // Alloy variant (only configured variant).
    if let GasEstimatorType::Alloy {
        reward_percentile, ..
    } = &config.gas_estimator
    {
        validate_reward_percentile(*reward_percentile)
            .map_err(|e| format!("gas_estimator: {e}"))?;
    }

    for solver_config in &config.solvers {
        if let Err(e) = validate_haircut_bps(solver_config.haircut_bps) {
            return Err(format!("solver '{}': {e}", solver_config.name));
        }
        if let Err(e) = validate_solving_share_of_deadline(
            solver_config.timeouts.solving_share_of_deadline,
        ) {
            return Err(format!("solver '{}': {e}", solver_config.name));
        }
        if let Err(e) = validate_metrics_strategy_failure_ratio(
            solver_config.bad_order_detection.metrics_strategy_failure_ratio,
        ) {
            return Err(format!("solver '{}': {e}", solver_config.name));
        }
    }
    Ok(())
}

/// Validate `additional_tip_percentage` is a finite real number in
/// [0.0, 1.0]. Same class as L1 — sharp-edges PR-228 audit MED.
/// Used as a multiplier on `max_fee_per_gas` in `gas.rs:57`; NaN
/// would poison downstream f64*U256 conversions, negative would
/// invert tips, >1 would blow gas caps.
fn validate_additional_tip_percentage(v: f64) -> Result<(), String> {
    if !v.is_finite() {
        return Err(format!(
            "additional_tip_percentage = {v} is not a finite number (NaN/Inf rejected); \
             expected a value in [0.0, 1.0]"
        ));
    }
    if !FRACTION_RANGE.contains(&v) {
        return Err(format!(
            "additional_tip_percentage = {v} is outside [0.0, 1.0]"
        ));
    }
    Ok(())
}

/// Validate `reward_percentile` is a finite real number in [0.0, 100.0].
/// Sharp-edges PR-228 audit MED. Passed to alloy's
/// `eth_feeHistory` percentile parameter — values outside [0, 100]
/// silently saturate or trigger opaque RPC errors.
fn validate_reward_percentile(v: f64) -> Result<(), String> {
    if !v.is_finite() {
        return Err(format!(
            "reward_percentile = {v} is not a finite number (NaN/Inf rejected); expected \
             a value in [0.0, 100.0]"
        ));
    }
    if !PERCENTILE_RANGE.contains(&v) {
        return Err(format!(
            "reward_percentile = {v} is outside [0.0, 100.0]"
        ));
    }
    Ok(())
}

/// Validate `metrics_strategy_failure_ratio` is a finite real number in
/// [0.0, 1.0]. Sharp-edges PR-228 audit MED. Used as a comparison
/// threshold for the metrics-bad-order-detection strategy — NaN makes
/// EVERY comparison false (silently breaks the strategy), negative
/// or >1 makes the threshold pathological.
fn validate_metrics_strategy_failure_ratio(v: f64) -> Result<(), String> {
    if !v.is_finite() {
        return Err(format!(
            "metrics_strategy_failure_ratio = {v} is not a finite number (NaN/Inf rejected); \
             expected a value in [0.0, 1.0]"
        ));
    }
    if !FRACTION_RANGE.contains(&v) {
        return Err(format!(
            "metrics_strategy_failure_ratio = {v} is outside [0.0, 1.0]"
        ));
    }
    Ok(())
}

pub fn default_http_time_buffer() -> Duration {
    Duration::from_millis(500)
}

pub fn default_solving_share_of_deadline() -> f64 {
    0.8
}

fn default_max_solutions_to_propose() -> NonZeroUsize {
    NonZeroUsize::new(1).unwrap()
}

#[serde_as]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct SolverConfig {
    /// The endpoint of this solver. `POST`ing an auction to this endpoint
    /// should prompt the solver to calculate and return a solution.
    endpoint: url::Url,

    /// The unique name for this solver. Used to disambiguate multiple solvers
    /// running behind a single driver.
    name: String,

    #[serde(flatten)]
    slippage: Slippage,

    /// Whether or not to skip fetching liquidity for this solver.
    #[serde(default)]
    skip_liquidity: bool,

    /// The account which should be used to sign settlements for this solver.
    account: Account,

    /// Timeout configuration for the solver.
    #[serde(default, flatten)]
    timeouts: Timeouts,

    #[serde(default)]
    request_headers: HashMap<String, String>,

    /// Determines whether the `solver` or the `driver` handles the fees
    #[serde(default)]
    fee_handler: FeeHandler,

    /// Use limit orders for quoting
    #[serde(default)]
    quote_using_limit_orders: bool,

    /// If enabled driver tries to merge multiple solutions for the same
    /// auction together.
    #[serde(default)]
    merge_solutions: bool,

    /// Maximum number of orders allowed to be contained in a merged solution.
    #[serde(default = "default_number_of_orders_per_merged_solution")]
    max_orders_per_merged_solution: usize,

    /// S3 configuration for storing the auctions in the form they are sent to
    /// the solver engine
    #[serde(default)]
    s3: Option<S3>,

    /// Whether the native token is wrapped or not when sent to the solvers
    #[serde(default)]
    manage_native_token: ManageNativeToken,

    /// Which `tx.origin` is required to make a quote simulation pass.
    #[serde(default)]
    quote_tx_origin: Option<eth::Address>,

    /// Maximum HTTP response size the driver will accept in bytes.
    #[serde(default = "default_response_size_limit_max_bytes")]
    response_size_limit_max_bytes: usize,

    /// Configuration for bad order detection.
    #[serde(default, flatten)]
    bad_order_detection: BadOrderDetectionConfig,

    /// The maximum number of `/settle` requests that can be queued up
    /// before the driver starts dropping new `/solve` requests.
    #[serde(default = "default_settle_queue_size")]
    settle_queue_size: usize,

    /// Haircut in basis points (0-10000). Applied to solver-reported
    /// economics to make bids more conservative by adjusting clearing prices
    /// to report lower surplus. Useful for solvers prone to negative slippage.
    /// Default: 0 (no haircut).
    #[serde(default)]
    haircut_bps: u32,

    /// Additional EOAs that submit settlement txs on behalf of the solver
    /// via EIP-7702 delegation. When non-empty, enables parallel submission
    /// with one lane per account.
    #[serde(default)]
    submission_accounts: Vec<Account>,

    /// Address of the deployed CowSettlementForwarder contract for EIP-7702
    /// delegation. Required when `submission_accounts` is non-empty.
    forwarder_contract: Option<eth::Address>,

    /// Maximum number of solutions the driver proposes to the autopilot per
    /// auction. Defaults to 1 (only the best-scoring solution). Values > 1
    /// require `submission-accounts` to be configured; the driver will refuse
    /// to start otherwise.
    #[serde(default = "default_max_solutions_to_propose")]
    max_solutions_to_propose: NonZeroUsize,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum FeeHandler {
    #[default]
    Driver,
    Solver,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct S3 {
    /// Name of the AWS S3 bucket in which the auctions will be stored
    pub bucket: String,

    /// Prepended to the auction id to form the final instance filename on AWS
    /// S3 bucket. Something like "staging/mainnet/"
    pub prefix: String,
}

#[serde_as]
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Account {
    /// A private key is used to sign transactions. Expects a 32-byte hex
    /// encoded string.
    ///
    /// SECURITY: prefer `PrivateKeyFile` for production — inline keys in
    /// TOML end up in backups, version control, and log dumps.
    PrivateKey(eth::B256),
    /// Path to a file containing a 32-byte hex-encoded private key
    /// (with or without `0x` / `0X` prefix, trailing whitespace trimmed).
    ///
    /// On Unix, the file:
    ///   - Must not be a symlink (refused on startup).
    ///   - Must not be group- or world-readable (`mode & 0o077 == 0`);
    ///     driver refuses to start otherwise.
    ///
    /// This enforces *filesystem-level* secrecy only. Processes running
    /// under the same UID (e.g. shared `systemd User=` accounts) can still
    /// read the file. For true key isolation use `Kms`.
    PrivateKeyFile {
        path: std::path::PathBuf,
    },
    /// AWS KMS is used to sign transactions. Expects the key identifier.
    Kms(#[serde_as(as = "serde_with::DisplayFromStr")] Arn),
    /// Used to start the driver in the dry-run mode. This account type is
    /// *unable* to sign transactions as alloy does not support *implicit*
    /// node-side signing.
    Address(eth::Address),
}

#[serde_as]
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Timeouts {
    /// Absolute time allocated from the total auction deadline for
    /// request/response roundtrip between autopilot and driver.
    #[serde(with = "humantime_serde", default = "default_http_time_buffer")]
    http_time_buffer: Duration,

    /// Maximum time allocated for solver engines to return the solutions back
    /// to the driver, in percentage of total driver deadline (after network
    /// buffer). Remaining time is spent on encoding and postprocessing the
    /// returned solutions. Expected value [0, 1]
    #[serde(default = "default_solving_share_of_deadline")]
    solving_share_of_deadline: f64,
}

#[serde_as]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Slippage {
    /// The relative slippage factor allowed by the solver.
    #[serde(rename = "relative-slippage")]
    #[serde_as(as = "serde_with::DisplayFromStr")]
    relative: bigdecimal::BigDecimal,

    /// The absolute slippage allowed by the solver.
    #[serde(rename = "absolute-slippage")]
    #[serde_as(as = "Option<serde_ext::U256>")]
    absolute: Option<eth::U256>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct ContractsConfig {
    /// Override the default address of the GPv2Settlement contract.
    gp_v2_settlement: Option<eth::Address>,

    /// Override the default address of the WETH contract.
    weth: Option<eth::Address>,

    /// Override the default address of the Balances contract.
    balances: Option<eth::Address>,

    /// Override the default address of the Signatures contract.
    signatures: Option<eth::Address>,

    /// List of all cow amm factories with the corresponding helper contract.
    #[serde(default)]
    cow_amms: Vec<CowAmmConfig>,

    /// Flashloan router to support taking out multiple flashloans
    /// in the same settlement.
    flashloan_router: Option<eth::Address>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct CowAmmConfig {
    /// CoW AMM factory address.
    pub factory: eth::Address,
    /// Which helper contract to use for interfacing with CoW AMMs.
    pub helper: eth::Address,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct LiquidityConfig {
    /// Additional tokens for which liquidity is always fetched, regardless of
    /// whether or not the token appears in the auction.
    #[serde(default)]
    base_tokens: Vec<eth::Address>,

    /// Liquidity provided by a Uniswap V2 compatible contract.
    #[serde(default)]
    uniswap_v2: Vec<UniswapV2Config>,

    /// Liquidity provided by a Swapr compatible contract.
    #[serde(default)]
    swapr: Vec<SwaprConfig>,

    /// Liquidity provided by a Uniswap V3 compatible contract.
    #[serde(default)]
    uniswap_v3: Vec<UniswapV3Config>,

    /// Liquidity provided by a Balancer V2 compatible contract.
    #[serde(default)]
    balancer_v2: Vec<BalancerV2Config>,

    /// Liquidity provided by 0x API.
    #[serde(default)]
    zeroex: Option<ZeroExConfig>,

    /// Defines at which block the liquidity needs to be fetched on /solve
    /// requests.
    #[serde(default)]
    fetch_at_block: AtBlock,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum UniswapV2Config {
    #[serde(rename_all = "kebab-case")]
    Preset { preset: UniswapV2Preset },

    #[serde(rename_all = "kebab-case")]
    Manual {
        /// The address of the Uniswap V2 compatible router contract.
        router: eth::Address,

        /// The digest of the pool initialization code.
        pool_code: eth::B256,

        /// How long liquidity should not be fetched for a token pair that
        /// didn't return useful liquidity before allowing to fetch it
        /// again.
        #[serde(with = "humantime_serde")]
        missing_pool_cache_time: Duration,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum UniswapV2Preset {
    UniswapV2,
    SushiSwap,
    Honeyswap,
    Baoswap,
    PancakeSwap,
    TestnetUniswapV2,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum SwaprConfig {
    #[serde(rename_all = "kebab-case")]
    Preset { preset: SwaprPreset },

    #[serde(rename_all = "kebab-case")]
    Manual {
        /// The address of the Swapr compatible router contract.
        router: eth::Address,

        /// The digest of the pool initialization code.
        pool_code: eth::B256,

        /// How long liquidity should not be fetched for a token pair that
        /// didn't return useful liquidity before allowing to fetch it
        /// again.
        #[serde(with = "humantime_serde")]
        missing_pool_cache_time: Duration,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
enum SwaprPreset {
    Swapr,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum UniswapV3Config {
    #[serde(rename_all = "kebab-case")]
    Preset {
        preset: UniswapV3Preset,

        /// How many pools to initialize during start up.
        #[serde(default = "uniswap_v3::default_max_pools_to_initialize")]
        max_pools_to_initialize: usize,

        graph_url: Url,

        /// How many pool IDs can be present in a where clause of a Tick query
        /// at once. Some subgraphs are overloaded and throw errors when
        /// there are too many.
        #[serde(default = "uniswap_v3::default_max_pools_per_tick_query")]
        max_pools_per_tick_query: usize,

        /// How often the liquidity source should be reinitialized to get
        /// access to new pools.
        #[serde(with = "humantime_serde", default = "default_reinit_interval")]
        reinit_interval: Option<Duration>,
    },

    #[serde(rename_all = "kebab-case")]
    Manual {
        /// Addresses of Uniswap V3 compatible router contracts.
        router: eth::Address,

        /// How many pools to initialize during start up.
        #[serde(default = "uniswap_v3::default_max_pools_to_initialize")]
        max_pools_to_initialize: usize,

        /// How many pool IDs can be present in a where clause of a Tick query
        /// at once. Some subgraphs are overloaded and throw errors when
        /// there are too many.
        #[serde(default = "uniswap_v3::default_max_pools_per_tick_query")]
        max_pools_per_tick_query: usize,

        /// The URL used to connect to uniswap v3 subgraph client.
        graph_url: Url,

        /// How often the liquidity source should be reinitialized to get
        /// access to new pools.
        #[serde(with = "humantime_serde", default = "default_reinit_interval")]
        reinit_interval: Option<Duration>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
enum UniswapV3Preset {
    UniswapV3,
}

mod uniswap_v3 {
    pub fn default_max_pools_to_initialize() -> usize {
        100
    }

    pub fn default_max_pools_per_tick_query() -> usize {
        usize::MAX
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum BalancerV2Config {
    #[serde(rename_all = "kebab-case")]
    Preset {
        preset: BalancerV2Preset,

        /// Deny listed Balancer V2 pools.
        #[serde(default)]
        pool_deny_list: Vec<eth::B256>,

        /// The URL used to connect to balancer v2 subgraph client.
        graph_url: Url,

        /// How often the liquidity source should be reinitialized to get
        /// access to new pools.
        #[serde(with = "humantime_serde", default = "default_reinit_interval")]
        reinit_interval: Option<Duration>,
    },

    #[serde(rename_all = "kebab-case")]
    Manual {
        /// Addresses of Balancer V2 compatible vault contract.
        vault: eth::Address,

        /// The weighted pool factory contract addresses.
        #[serde(default)]
        weighted: Vec<Address>,

        /// The weighted pool factory v3+ contract addresses.
        #[serde(default)]
        weighted_v3plus: Vec<Address>,

        /// The stable pool factory contract addresses.
        #[serde(default)]
        stable: Vec<Address>,

        /// The liquidity bootstrapping pool factory contract addresses.
        ///
        /// These are weighted pools with dynamic weights for initial token
        /// offerings.
        #[serde(default)]
        liquidity_bootstrapping: Vec<Address>,

        /// The composable stable pool factory contract addresses.
        #[serde(default)]
        composable_stable: Vec<Address>,

        /// Deny listed Balancer V2 pools.
        #[serde(default)]
        pool_deny_list: Vec<eth::B256>,

        /// The URL used to connect to balancer v2 subgraph client.
        graph_url: Url,

        /// How often the liquidity source should be reinitialized to get
        /// access to new pools.
        #[serde(with = "humantime_serde", default = "default_reinit_interval")]
        reinit_interval: Option<Duration>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
enum BalancerV2Preset {
    BalancerV2,
}

fn default_reinit_interval() -> Option<Duration> {
    Some(Duration::from_secs(12 * 60 * 60))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct ZeroExConfig {
    #[serde(default = "default_zeroex_base_url")]
    pub base_url: String,
    pub api_key: Option<String>,
    #[serde(with = "humantime_serde", default = "default_http_timeout")]
    pub http_timeout: Duration,
}

fn default_zeroex_base_url() -> String {
    "https://api.0x.org/".to_string()
}

fn default_http_timeout() -> Duration {
    Duration::from_secs(10)
}

fn default_response_size_limit_max_bytes() -> usize {
    30_000_000
}

fn default_number_of_orders_per_merged_solution() -> usize {
    3
}

/// A configuration for sending notifications to liquidity sources.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct LiquiditySourcesNotifier {
    /// Configuration for Liquorice liquidity
    pub liquorice: Option<LiquoriceConfig>,
}

/// Liquorice API configuration
/// <https://liquorice.gitbook.io/liquorice-docs>
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct LiquoriceConfig {
    /// Liquorice API base URL
    pub base_url: String,
    /// API key for the Liquorice API
    pub api_key: String,
    /// The HTTP timeout for requests to the Liquorice API
    #[serde(with = "humantime_serde", default = "default_http_timeout")]
    pub http_timeout: Duration,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields, tag = "estimator")]
pub enum GasEstimatorType {
    Web3,
    /// EIP-1559 gas estimator using alloy's algorithm.
    /// Optionally configure the fee history query parameters.
    #[serde(rename_all = "kebab-case")]
    Alloy {
        /// Number of blocks to look back for fee history (default: 10)
        #[serde(default = "default_past_blocks")]
        past_blocks: u64,
        /// Percentile of rewards to use for priority fee estimation (default:
        /// 20.0). This is what Metamask uses as medium priority:
        /// https://github.com/MetaMask/core/blob/0fd4b397e7237f104d1c81579a0c4321624d076b/packages/gas-fee-controller/src/fetchGasEstimatesViaEthFeeHistory/calculateGasFeeEstimatesForPriorityLevels.ts#L14-L45
        #[serde(default = "default_reward_percentile")]
        reward_percentile: f64,
    },
}

impl Default for GasEstimatorType {
    fn default() -> Self {
        Self::Alloy {
            past_blocks: default_past_blocks(),
            reward_percentile: default_reward_percentile(),
        }
    }
}

/// Defines various strategies to prioritize orders.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "strategy")]
pub enum OrderPriorityStrategy {
    /// Strategy to prioritize orders based on external price.
    /// This strategy uses the likelihood that an order will be fulfilled,
    /// based on token prices. A larger value means that the order is more
    /// likely to be fulfilled.
    ExternalPrice,
    /// Strategy to prioritize orders based on their creation timestamp. The
    /// most recently created orders are given the highest priority.
    #[serde(rename_all = "kebab-case")]
    CreationTimestamp {
        /// When specified, only orders created within this threshold will be
        /// taken into account for this specific strategy.
        #[serde(with = "humantime_serde", default = "default_max_order_age")]
        max_order_age: Option<Duration>,
    },
    /// Strategy to prioritize orders based on whether the current solver
    /// provided the winning quote for the order.
    #[serde(rename_all = "kebab-case")]
    OwnQuotes {
        /// When specified, only orders created within this threshold will be
        /// taken into account for this specific strategy.
        #[serde(with = "humantime_serde", default = "default_max_order_age")]
        max_order_age: Option<Duration>,
    },
}

/// The default prioritization process first considers
/// the order timestamp(2 minutes threshold by default), then checks if the
/// solver is working with its own quotes, and finally considers the likelihood
/// of order fulfillment based on external price data.
fn default_order_priority_strategies() -> Vec<OrderPriorityStrategy> {
    vec![
        OrderPriorityStrategy::OwnQuotes {
            max_order_age: default_max_order_age(),
        },
        OrderPriorityStrategy::CreationTimestamp {
            max_order_age: default_max_order_age(),
        },
        OrderPriorityStrategy::ExternalPrice,
    ]
}

fn default_max_order_age() -> Option<Duration> {
    Some(Duration::from_secs(300))
}

fn default_simulation_bad_token_max_age() -> Duration {
    Duration::from_secs(600)
}

#[serde_as]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct BadOrderDetectionConfig {
    /// Which tokens are explicitly supported or unsupported by the solver.
    #[serde(default)]
    pub token_supported: HashMap<eth::Address, bool>,

    /// Whether the solver opted into detecting unsupported
    /// tokens with `trace_callMany` based simulation.
    #[serde(default, rename = "enable-simulation-bad-token-detection")]
    pub enable_simulation_strategy: bool,

    /// Whether the solver opted into detecting unsupported
    /// orders with metrics-based detection. Orders that continue to result
    /// in reverting solutions will be ignored temporarily.
    #[serde(default, rename = "enable-metrics-bad-order-detection")]
    pub enable_metrics_strategy: bool,

    /// The ratio of failures to attempts that qualifies an order as
    /// unsupported.
    #[serde(
        default = "default_metrics_bad_order_detector_failure_ratio",
        rename = "metrics-bad-order-detection-failure-ratio"
    )]
    pub metrics_strategy_failure_ratio: f64,

    /// The minimum number of attempts required before evaluating an order’s
    /// quality.
    #[serde(
        default = "default_metrics_bad_order_detector_required_measurements",
        rename = "metrics-bad-order-detection-required-measurements"
    )]
    pub metrics_strategy_required_measurements: u32,

    /// Controls whether the metrics based detection strategy should only log
    /// unsupported orders or actually filter them out.
    #[serde(
        default = "default_metrics_bad_order_detector_log_only",
        rename = "metrics-bad-order-detection-log-only"
    )]
    pub metrics_strategy_log_only: bool,

    /// How long the metrics based bad order detection should flag an order as
    /// unsupported before it allows to solve for that token again.
    #[serde(
        default = "default_metrics_bad_order_detector_freeze_time",
        rename = "metrics-bad-order-detection-order-freeze-time",
        with = "humantime_serde"
    )]
    pub metrics_strategy_freeze_time: Duration,

    /// How frequently we try to collect garbage on the metrics cache.
    #[serde(
        default = "default_metrics_bad_order_detector_gc_interval",
        rename = "metrics-bad-order-detection-gc-interval",
        with = "humantime_serde"
    )]
    pub metrics_strategy_gc_interval: Duration,

    /// How long we must not have seen an order in a solution before
    /// the associated metrics get evicted from the cache.
    #[serde(
        default = "default_metrics_bad_order_detector_gc_max_age",
        rename = "metrics-bad-order-detection-gc-max-age",
        with = "humantime_serde"
    )]
    pub metrics_strategy_gc_max_age: Duration,
}

impl Default for BadOrderDetectionConfig {
    fn default() -> Self {
        serde_json::from_str("{}").expect("MetricsBadOrderDetectorConfig uses default values")
    }
}

#[derive(Clone, Debug)]
pub enum AppDataFetching {
    /// App-data fetching is disabled
    Disabled,

    /// App-data fetching is enabled
    Enabled {
        /// The base URL of the orderbook to fetch app-data from
        orderbook_url: Url,

        /// The maximum number of app-data entries in the cache
        cache_size: u64,
    },
}

impl<'de> Deserialize<'de> for AppDataFetching {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[serde_as]
        #[derive(Deserialize)]
        #[serde(rename_all = "kebab-case", deny_unknown_fields)]
        struct Helper {
            #[serde(default)]
            app_data_fetching_enabled: bool,
            orderbook_url: Option<Url>,
            #[serde(default = "default_app_data_cache_size")]
            cache_size: u64,
        }

        let helper = Helper::deserialize(deserializer)?;
        match helper.app_data_fetching_enabled {
            false => Ok(AppDataFetching::Disabled),
            true => {
                let orderbook_url = helper
                    .orderbook_url
                    .ok_or_else(|| serde::de::Error::custom("Missing `orderbook-url` field"))?;
                Ok(AppDataFetching::Enabled {
                    orderbook_url,
                    cache_size: helper.cache_size,
                })
            }
        }
    }
}

fn default_metrics_bad_order_detector_failure_ratio() -> f64 {
    0.9
}

fn default_metrics_bad_order_detector_required_measurements() -> u32 {
    20
}

/// Keeps 2 requests in the queue plus 1 ongoing request making a total of 3
/// pending settlements, which is considered big enough to avoid potential price
/// moves or any other conflicts due to the extended settlement idle time.
fn default_settle_queue_size() -> usize {
    2
}

fn default_metrics_bad_order_detector_log_only() -> bool {
    true
}

fn default_metrics_bad_order_detector_freeze_time() -> Duration {
    Duration::from_secs(60 * 10)
}

fn default_metrics_bad_order_detector_gc_interval() -> Duration {
    Duration::from_mins(1)
}

fn default_metrics_bad_order_detector_gc_max_age() -> Duration {
    Duration::from_hours(1)
}

/// According to statistics, the average size of the app-data is ~800 bytes.
/// With this default, the approximate size of the cache will be ~1.6 MB.
fn default_app_data_cache_size() -> u64 {
    2000
}

/// Which block should be used to fetch the liquidity.
#[derive(Clone, Copy, Debug, Deserialize, Default)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
enum AtBlock {
    /// Use the latest block received by the `CurrentBlockWatcher`.
    #[default]
    Latest,
    /// Use the latest finalized block.
    Finalized,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ────────────────────────────────────────────────────────────────────
    // Phase 2 audit C4 sub-pieces + L1 — config-time range validators
    // ────────────────────────────────────────────────────────────────────

    #[test]
    fn tx_gas_limit_accepts_typical_settlement_budget() {
        // ~3M gas — typical multi-fill settlement.
        assert!(validate_tx_gas_limit(eth::U256::from(3_000_000u64)).is_ok());
        // ~10M gas — large multi-fill batch.
        assert!(validate_tx_gas_limit(eth::U256::from(10_000_000u64)).is_ok());
    }

    #[test]
    fn tx_gas_limit_rejects_zero_and_below_settlement_floor() {
        assert!(validate_tx_gas_limit(eth::U256::ZERO).is_err());
        // EIP-1559 intrinsic (21k) is correctly rejected — it's nowhere
        // near what a settlement tx actually needs.
        assert!(validate_tx_gas_limit(eth::U256::from(21_000u64)).is_err());
        // Just below the 1M floor.
        assert!(validate_tx_gas_limit(eth::U256::from(MIN_TX_GAS_LIMIT - 1)).is_err());
    }

    #[test]
    fn tx_gas_limit_accepts_settlement_floor() {
        assert!(validate_tx_gas_limit(eth::U256::from(MIN_TX_GAS_LIMIT)).is_ok());
    }

    #[test]
    fn tx_gas_limit_rejects_u256_max() {
        assert!(validate_tx_gas_limit(eth::U256::MAX).is_err());
    }

    #[test]
    fn tx_gas_limit_accepts_block_fit_ceiling() {
        // 60M = Ethereum Fusaka mainnet block gas. Right at the boundary.
        assert!(validate_tx_gas_limit(eth::U256::from(MAX_TX_GAS_LIMIT)).is_ok());
    }

    #[test]
    fn tx_gas_limit_accepts_legacy_45m_config() {
        // example.toml + playground/driver.toml ship `tx-gas-limit = "45000000"`.
        // 45M is between pre-Fusaka block gas (30M) and post-Fusaka (60M).
        // Must remain accepted post-tightening or every running config
        // breaks on next driver restart.
        assert!(validate_tx_gas_limit(eth::U256::from(45_000_000u64)).is_ok());
    }

    #[test]
    fn tx_gas_limit_rejects_above_block_fit_ceiling() {
        assert!(validate_tx_gas_limit(eth::U256::from(MAX_TX_GAS_LIMIT + 1)).is_err());
        // 200M (old ceiling) now rejected — physically can't fit in a
        // block on any EVM chain we support.
        assert!(validate_tx_gas_limit(eth::U256::from(200_000_000u64)).is_err());
    }

    #[test]
    fn tx_gas_limit_error_names_the_field_and_value() {
        let err = validate_tx_gas_limit(eth::U256::ZERO).unwrap_err();
        assert!(
            err.contains("tx_gas_limit") && err.contains('0'),
            "error message should mention the field name + value: {err}"
        );
    }

    #[test]
    fn haircut_bps_accepts_zero_default() {
        assert!(validate_haircut_bps(0).is_ok());
    }

    #[test]
    fn haircut_bps_accepts_full_range_to_ten_thousand() {
        assert!(validate_haircut_bps(1).is_ok());
        assert!(validate_haircut_bps(2500).is_ok());
        assert!(validate_haircut_bps(MAX_HAIRCUT_BPS).is_ok());
    }

    #[test]
    fn haircut_bps_rejects_above_ten_thousand() {
        assert!(validate_haircut_bps(MAX_HAIRCUT_BPS + 1).is_err());
        assert!(validate_haircut_bps(u32::MAX).is_err());
    }

    #[test]
    fn haircut_bps_error_names_field_and_value() {
        let err = validate_haircut_bps(99_999).unwrap_err();
        assert!(
            err.contains("haircut_bps") && err.contains("99999"),
            "error message should mention the field name + value: {err}"
        );
    }

    #[test]
    fn solving_share_of_deadline_accepts_default_and_range() {
        assert!(validate_solving_share_of_deadline(default_solving_share_of_deadline()).is_ok());
        assert!(validate_solving_share_of_deadline(0.0).is_ok());
        assert!(validate_solving_share_of_deadline(0.5).is_ok());
        assert!(validate_solving_share_of_deadline(1.0).is_ok());
    }

    #[test]
    fn solving_share_of_deadline_rejects_nan_and_inf() {
        assert!(validate_solving_share_of_deadline(f64::NAN).is_err());
        assert!(validate_solving_share_of_deadline(f64::INFINITY).is_err());
        assert!(validate_solving_share_of_deadline(f64::NEG_INFINITY).is_err());
    }

    #[test]
    fn solving_share_of_deadline_rejects_negative() {
        assert!(validate_solving_share_of_deadline(-0.01).is_err());
        assert!(validate_solving_share_of_deadline(-1.0).is_err());
    }

    #[test]
    fn solving_share_of_deadline_rejects_above_one() {
        assert!(validate_solving_share_of_deadline(1.0001).is_err());
        assert!(validate_solving_share_of_deadline(2.0).is_err());
    }

    #[test]
    fn solving_share_of_deadline_rejects_negative_zero_correctly() {
        // -0.0 == 0.0 in IEEE 754, so this should be accepted (not a bug).
        assert!(validate_solving_share_of_deadline(-0.0).is_ok());
    }

    #[test]
    fn additional_tip_percentage_accepts_default_and_range() {
        assert!(validate_additional_tip_percentage(default_additional_tip_percentage()).is_ok());
        assert!(validate_additional_tip_percentage(0.0).is_ok());
        assert!(validate_additional_tip_percentage(0.5).is_ok());
        assert!(validate_additional_tip_percentage(1.0).is_ok());
    }

    #[test]
    fn additional_tip_percentage_rejects_nan_inf_negative_above_one() {
        assert!(validate_additional_tip_percentage(f64::NAN).is_err());
        assert!(validate_additional_tip_percentage(f64::INFINITY).is_err());
        assert!(validate_additional_tip_percentage(f64::NEG_INFINITY).is_err());
        assert!(validate_additional_tip_percentage(-0.01).is_err());
        assert!(validate_additional_tip_percentage(1.5).is_err());
    }

    #[test]
    fn reward_percentile_accepts_0_to_100() {
        assert!(validate_reward_percentile(0.0).is_ok());
        assert!(validate_reward_percentile(20.0).is_ok()); // Metamask default
        assert!(validate_reward_percentile(99.99).is_ok());
        assert!(validate_reward_percentile(100.0).is_ok());
    }

    #[test]
    fn reward_percentile_rejects_nan_inf_negative_above_hundred() {
        assert!(validate_reward_percentile(f64::NAN).is_err());
        assert!(validate_reward_percentile(f64::INFINITY).is_err());
        assert!(validate_reward_percentile(-0.01).is_err());
        assert!(validate_reward_percentile(100.0001).is_err());
        assert!(validate_reward_percentile(1000.0).is_err());
    }

    #[test]
    fn metrics_strategy_failure_ratio_accepts_default_and_range() {
        assert!(validate_metrics_strategy_failure_ratio(0.0).is_ok());
        assert!(validate_metrics_strategy_failure_ratio(0.5).is_ok());
        assert!(validate_metrics_strategy_failure_ratio(1.0).is_ok());
    }

    /// Closes Codex PR-228 LOW: lock the "iterates ALL solvers" wiring
    /// invariant against future refactors. Uses example.toml as the
    /// base config + appends a second [[solver]] block whose haircut_bps
    /// is invalid. Asserts the validator FAILS with an error naming the
    /// second solver. If a future refactor accidentally drops the
    /// per-solver loop (or only validates `solvers[0]`), this test breaks.
    #[test]
    fn validate_config_for_load_iterates_all_solvers() {
        let base = include_str!("../../../../example.toml");
        let bad_solver = r#"

[[solver]]
name = "bad-canary-solver"
endpoint = "http://example.invalid"
absolute-slippage = "40000000000000000"
relative-slippage = "0.1"
account = "0x0000000000000000000000000000000000000000000000000000000000000002"
haircut-bps = 99999  # INVALID: must be <= 10000
"#;
        let toml_str = format!("{base}{bad_solver}");
        let config: Config = toml::from_str(&toml_str)
            .expect("base example.toml + extra solver block should parse cleanly");
        assert_eq!(
            config.solvers.len(),
            2,
            "test fixture should produce 2 solvers (1 from example.toml + 1 appended bad one)"
        );

        let err = validate_config_for_load(&config).expect_err(
            "validator must fail because the 2nd solver has haircut_bps = 99999",
        );
        assert!(
            err.contains("bad-canary-solver"),
            "error must name the offending solver so operators can find it: {err}"
        );
        assert!(
            err.contains("haircut_bps") && err.contains("99999"),
            "error must name the field + value: {err}"
        );
    }

    /// Companion test to the one above: prove example.toml itself
    /// validates cleanly as-is. If a future change to example.toml
    /// makes it invalid (e.g. tightens a default), the test breaks
    /// loudly — easier to find than discovering it via the [ignore]
    /// async example_config integration test.
    #[test]
    fn validate_config_for_load_passes_on_example_toml() {
        let base = include_str!("../../../../example.toml");
        let config: Config = toml::from_str(base).expect("example.toml must parse");
        validate_config_for_load(&config).expect("example.toml must validate as-is");
    }

    #[test]
    fn metrics_strategy_failure_ratio_rejects_nan_inf_negative_above_one() {
        // NaN is the most dangerous case here — all comparisons against
        // NaN return false, so a NaN threshold silently breaks the
        // bad-order detection strategy without any error.
        assert!(validate_metrics_strategy_failure_ratio(f64::NAN).is_err());
        assert!(validate_metrics_strategy_failure_ratio(f64::INFINITY).is_err());
        assert!(validate_metrics_strategy_failure_ratio(-0.5).is_err());
        assert!(validate_metrics_strategy_failure_ratio(2.0).is_err());
    }

    #[test]
    fn solving_share_of_deadline_error_distinguishes_nan_from_range() {
        let nan_err = validate_solving_share_of_deadline(f64::NAN).unwrap_err();
        let range_err = validate_solving_share_of_deadline(2.0).unwrap_err();
        // NaN error must clearly call out the finite-ness violation
        // (regardless of whether it also mentions the range).
        assert!(
            nan_err.contains("finite"),
            "NaN should be reported as non-finite: {nan_err}"
        );
        // Out-of-range error must NOT mention finite-ness (we got past that check).
        assert!(
            !range_err.contains("finite") && range_err.contains("[0.0, 1.0]"),
            "Out-of-range value should be reported with range bounds (and not as a \
             finite-ness violation): {range_err}"
        );
    }

    // ────────────────────────────────────────────────────────────────────

    #[test]
    fn gas_estimator_alloy_defaults() {
        let config: GasEstimatorType = toml::from_str(
            r#"
            estimator = "alloy"
        "#,
        )
        .unwrap();

        match config {
            GasEstimatorType::Alloy {
                past_blocks,
                reward_percentile,
            } => {
                assert_eq!(past_blocks, 10);
                assert_eq!(reward_percentile, 20.0);
            }
            _ => panic!("expected Alloy variant"),
        }
    }

    #[test]
    fn gas_estimator_alloy_custom_past_blocks() {
        let config: GasEstimatorType = toml::from_str(
            r#"
            estimator = "alloy"
            past-blocks = 5
        "#,
        )
        .unwrap();

        match config {
            GasEstimatorType::Alloy {
                past_blocks,
                reward_percentile,
            } => {
                assert_eq!(past_blocks, 5);
                assert_eq!(reward_percentile, 20.0);
            }
            _ => panic!("expected Alloy variant"),
        }
    }

    #[test]
    fn gas_estimator_alloy_custom_percentile() {
        let config: GasEstimatorType = toml::from_str(
            r#"
            estimator = "alloy"
            reward-percentile = 50.0
        "#,
        )
        .unwrap();

        match config {
            GasEstimatorType::Alloy {
                past_blocks,
                reward_percentile,
            } => {
                assert_eq!(past_blocks, 10);
                assert_eq!(reward_percentile, 50.0);
            }
            _ => panic!("expected Alloy variant"),
        }
    }

    #[test]
    fn gas_estimator_alloy_all_custom() {
        let config: GasEstimatorType = toml::from_str(
            r#"
            estimator = "alloy"
            past-blocks = 20
            reward-percentile = 75.0
        "#,
        )
        .unwrap();

        match config {
            GasEstimatorType::Alloy {
                past_blocks,
                reward_percentile,
            } => {
                assert_eq!(past_blocks, 20);
                assert_eq!(reward_percentile, 75.0);
            }
            _ => panic!("expected Alloy variant"),
        }
    }

    #[test]
    fn gas_estimator_web3() {
        let config: GasEstimatorType = toml::from_str(
            r#"
            estimator = "web3"
        "#,
        )
        .unwrap();

        assert!(matches!(config, GasEstimatorType::Web3));
    }

    #[test]
    fn gas_estimator_default() {
        let config = GasEstimatorType::default();

        match config {
            GasEstimatorType::Alloy {
                past_blocks,
                reward_percentile,
            } => {
                assert_eq!(past_blocks, 10);
                assert_eq!(reward_percentile, 20.0);
            }
            _ => panic!("expected Alloy variant as default"),
        }
    }
}
