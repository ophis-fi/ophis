//! Read-only, block-pinned Ophis Quote Lab observations.
//!
//! This crate is intentionally not a solver `Dex` implementation. It cannot
//! build a Settlement interaction or submit a transaction.

use {
    alloy::{
        primitives::{Address, B256, Bytes, U160, U256},
        sol,
        sol_types::SolCall,
    },
    ethrpc::block_context::{BlockContext, ReadOnlyRpc},
    serde::{Deserialize, Serialize},
    std::{collections::HashSet, path::Path, str::FromStr, time::Instant},
};

sol! {
    struct RawQuote {
        uint8 source;
        uint256 feeBps;
        uint256 amountIn;
        uint256 amountOut;
    }

    function getQuotes(bool exactOut, address tokenIn, address tokenOut, uint256 swapAmount)
        external
        view
        returns (RawQuote best, RawQuote[] quotes);

    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );

    function getAmountsOut(uint256 amountIn, address[] path)
        external
        view
        returns (uint256[] amounts);

    interface IV4Quoter {
        struct PoolKey {
            address currency0;
            address currency1;
            uint24 fee;
            int24 tickSpacing;
            address hooks;
        }

        struct QuoteExactSingleParams {
            PoolKey poolKey;
            bool zeroForOne;
            uint128 exactAmount;
            bytes hookData;
        }

        function quoteExactInputSingle(QuoteExactSingleParams params)
            external
            returns (uint256 amountOut, uint256 gasEstimate);
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub network: Network,
    pub source: Source,
    #[serde(rename = "contract")]
    pub contracts: Vec<Contract>,
}

const MAX_MATRIX_CASES: usize = 100;
const MIN_SERIES_SAMPLES: usize = 2;
const MAX_SERIES_SAMPLES: usize = 24;
const MIN_SERIES_INTERVAL_SECONDS: u64 = 12;
const MAX_SERIES_INTERVAL_SECONDS: u64 = 3_600;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct BenchmarkMatrix {
    pub schema_version: u32,
    #[serde(rename = "case")]
    pub cases: Vec<MatrixCase>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct MatrixCase {
    pub id: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
}

impl BenchmarkMatrix {
    pub fn load(path: &Path) -> Result<Self, Error> {
        let contents = std::fs::read_to_string(path)?;
        let matrix: Self = toml::from_str(&contents)?;
        matrix.validate()?;
        Ok(matrix)
    }

    fn validate(&self) -> Result<(), Error> {
        if self.schema_version != 1 {
            return Err(Error::UnsupportedMatrixSchema(self.schema_version));
        }
        if self.cases.is_empty() {
            return Err(Error::EmptyMatrix);
        }
        if self.cases.len() > MAX_MATRIX_CASES {
            return Err(Error::TooManyMatrixCases(self.cases.len()));
        }

        let mut ids = HashSet::new();
        for case in &self.cases {
            if !ids.insert(case.id.as_str()) {
                return Err(Error::DuplicateMatrixCase(case.id.clone()));
            }
            let token_in = case.parsed_token_in()?;
            let token_out = case.parsed_token_out()?;
            if token_in == token_out {
                return Err(Error::MatrixSameToken(case.id.clone()));
            }
            if case.parsed_amount_in()?.is_zero() {
                return Err(Error::MatrixZeroAmount(case.id.clone()));
            }
        }
        Ok(())
    }
}

impl MatrixCase {
    fn parsed_token_in(&self) -> Result<Address, Error> {
        Address::from_str(&self.token_in).map_err(|_| Error::InvalidMatrixToken {
            case: self.id.clone(),
            field: "token-in",
        })
    }

    fn parsed_token_out(&self) -> Result<Address, Error> {
        Address::from_str(&self.token_out).map_err(|_| Error::InvalidMatrixToken {
            case: self.id.clone(),
            field: "token-out",
        })
    }

    fn parsed_amount_in(&self) -> Result<U256, Error> {
        U256::from_str(&self.amount_in).map_err(|_| Error::InvalidMatrixAmount(self.id.clone()))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct Network {
    pub name: String,
    pub chain_id: u64,
    pub observed_block: u64,
    pub observed_block_hash: String,
    pub observed_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct Source {
    pub repository: String,
    pub commit: String,
    pub retrieved_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct Contract {
    pub id: String,
    pub name: String,
    pub address: String,
    pub runtime_code_hash: String,
    pub role: Role,
    pub status: Status,
    #[serde(default)]
    pub shadow_enabled: bool,
    #[serde(default)]
    pub quote_adapter: QuoteAdapter,
    #[serde(default)]
    pub fee_tiers: Vec<u32>,
    #[serde(default)]
    pub tick_spacings: Vec<i32>,
    pub source_url: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    pub notes: String,
}

impl Contract {
    pub fn parsed_address(&self) -> Result<Address, Error> {
        Address::from_str(&self.address).map_err(|_| Error::InvalidAddress(self.id.clone()))
    }

    pub fn parsed_code_hash(&self) -> Result<B256, Error> {
        B256::from_str(&self.runtime_code_hash).map_err(|_| Error::InvalidCodeHash(self.id.clone()))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    QuoteSource,
    QuoteHelper,
    Router,
    Amm,
    Factory,
    Lens,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Current,
    Historical,
    Dependency,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum QuoteAdapter {
    #[default]
    Aggregate,
    UniswapV2Direct,
    UniswapV3Single,
    UniswapV4Single,
}

const UNISWAP_V3_BASELINE_FEES: [u32; 4] = [100, 500, 3_000, 10_000];
const UNISWAP_V4_BASELINE_POOLS: [(u32, i32); 4] =
    [(100, 1), (500, 10), (3_000, 60), (10_000, 200)];

impl Manifest {
    pub fn load(path: &Path) -> Result<Self, Error> {
        let contents = std::fs::read_to_string(path)?;
        let manifest: Self = toml::from_str(&contents)?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn contract(&self, id: &str) -> Result<&Contract, Error> {
        self.contracts
            .iter()
            .find(|contract| contract.id == id)
            .ok_or_else(|| Error::UnknownContract(id.to_owned()))
    }

    fn validate(&self) -> Result<(), Error> {
        if self.schema_version != 1 {
            return Err(Error::UnsupportedSchema(self.schema_version));
        }
        if self.network.chain_id == 0 {
            return Err(Error::InvalidChainId);
        }
        B256::from_str(&self.network.observed_block_hash)
            .map_err(|_| Error::InvalidObservedBlockHash)?;

        let mut ids = HashSet::new();
        let mut addresses = HashSet::new();
        for contract in &self.contracts {
            if !ids.insert(contract.id.as_str()) {
                return Err(Error::DuplicateId(contract.id.clone()));
            }
            let address = contract.parsed_address()?;
            if !addresses.insert(address) {
                return Err(Error::DuplicateAddress(contract.address.clone()));
            }
            contract.parsed_code_hash()?;
            for dependency in &contract.dependencies {
                if dependency == &contract.id {
                    return Err(Error::SelfDependency(contract.id.clone()));
                }
            }
            if contract.shadow_enabled && contract.role != Role::QuoteSource {
                return Err(Error::NonSourceEnabled(contract.id.clone()));
            }
            match contract.quote_adapter {
                QuoteAdapter::Aggregate | QuoteAdapter::UniswapV2Direct
                    if !contract.fee_tiers.is_empty() || !contract.tick_spacings.is_empty() =>
                {
                    return Err(Error::UnexpectedPoolConfiguration(contract.id.clone()));
                }
                QuoteAdapter::UniswapV2Direct => {
                    if contract.role != Role::QuoteSource || !contract.shadow_enabled {
                        return Err(Error::SourceDisabled(contract.id.clone()));
                    }
                }
                QuoteAdapter::UniswapV3Single => {
                    if contract.role != Role::QuoteSource || !contract.shadow_enabled {
                        return Err(Error::SourceDisabled(contract.id.clone()));
                    }
                    if !contract.tick_spacings.is_empty() {
                        return Err(Error::UnexpectedPoolConfiguration(contract.id.clone()));
                    }
                    if contract.fee_tiers.is_empty() {
                        return Err(Error::MissingFeeTiers(contract.id.clone()));
                    }
                    let mut unique_fees = HashSet::new();
                    for fee in &contract.fee_tiers {
                        if !UNISWAP_V3_BASELINE_FEES.contains(fee) {
                            return Err(Error::UnsupportedFeeTier {
                                contract: contract.id.clone(),
                                fee: *fee,
                            });
                        }
                        if !unique_fees.insert(*fee) {
                            return Err(Error::DuplicateFeeTier {
                                contract: contract.id.clone(),
                                fee: *fee,
                            });
                        }
                    }
                }
                QuoteAdapter::UniswapV4Single => {
                    if contract.role != Role::QuoteSource || !contract.shadow_enabled {
                        return Err(Error::SourceDisabled(contract.id.clone()));
                    }
                    let configured: Vec<_> = contract
                        .fee_tiers
                        .iter()
                        .copied()
                        .zip(contract.tick_spacings.iter().copied())
                        .collect();
                    if configured != UNISWAP_V4_BASELINE_POOLS
                        || contract.fee_tiers.len() != contract.tick_spacings.len()
                    {
                        return Err(Error::InvalidV4PoolConfiguration(contract.id.clone()));
                    }
                }
                QuoteAdapter::Aggregate => {}
            }
        }
        for contract in &self.contracts {
            for dependency in &contract.dependencies {
                if !ids.contains(dependency.as_str()) {
                    return Err(Error::MissingDependency {
                        contract: contract.id.clone(),
                        dependency: dependency.clone(),
                    });
                }
            }
        }
        Ok(())
    }
}

pub struct QuoteLabClient {
    rpc: ReadOnlyRpc,
}

impl QuoteLabClient {
    pub fn try_new(node_url: url::Url, chain_id: u64) -> Result<Self, Error> {
        Ok(Self {
            rpc: ReadOnlyRpc::try_new(node_url, chain_id, "ophis-quote-lab/0.1")?,
        })
    }

    pub async fn verify_manifest(&self, manifest: &Manifest) -> Result<Verification, Error> {
        let context = self.rpc.snapshot().await?;
        let mut contracts = Vec::with_capacity(manifest.contracts.len());
        for contract in &manifest.contracts {
            let actual = self
                .rpc
                .code_hash_at(context, contract.parsed_address()?)
                .await?;
            let expected = contract.parsed_code_hash()?;
            contracts.push(ContractVerification {
                id: contract.id.clone(),
                address: contract.address.clone(),
                expected_code_hash: format!("{expected:#x}"),
                actual_code_hash: format!("{actual:#x}"),
                matches: actual == expected,
            });
        }
        Ok(Verification { context, contracts })
    }

    /// Observe one exact-input quote. Quote failures are data and are returned
    /// as a successful observation with an error field; provenance failures
    /// remain hard errors.
    pub async fn observe_exact_in(
        &self,
        manifest: &Manifest,
        source_id: &str,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<Observation, Error> {
        let context = self.rpc.snapshot().await?;
        self.observe_exact_in_at(context, manifest, source_id, token_in, token_out, amount_in)
            .await
    }

    /// Compare multiple sources at one exact block. No implementation may
    /// take its own later snapshot inside this batch.
    pub async fn compare_exact_in(
        &self,
        manifest: &Manifest,
        source_ids: &[String],
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<Comparison, Error> {
        validate_source_ids(manifest, source_ids)?;
        let context = self.rpc.snapshot().await?;
        let mut observations = Vec::with_capacity(source_ids.len());
        for source_id in source_ids {
            observations.push(
                self.observe_exact_in_at(
                    context, manifest, source_id, token_in, token_out, amount_in,
                )
                .await?,
            );
        }
        Comparison::try_new(context, observations)
    }

    /// Run every case and source at one canonical block, then derive a compact
    /// reliability summary. Failures remain observations and are never retried
    /// or silently replaced.
    pub async fn run_matrix(
        &self,
        manifest: &Manifest,
        matrix: &BenchmarkMatrix,
        source_ids: &[String],
    ) -> Result<MatrixRun, Error> {
        matrix.validate()?;
        validate_source_ids(manifest, source_ids)?;

        let context = self.rpc.snapshot().await?;
        let mut cases = Vec::with_capacity(matrix.cases.len());
        for case in &matrix.cases {
            let token_in = case.parsed_token_in()?;
            let token_out = case.parsed_token_out()?;
            let amount_in = case.parsed_amount_in()?;
            let mut observations = Vec::with_capacity(source_ids.len());
            for source_id in source_ids {
                observations.push(
                    self.observe_exact_in_at(
                        context, manifest, source_id, token_in, token_out, amount_in,
                    )
                    .await?,
                );
            }
            cases.push(MatrixCaseResult::try_new(
                context,
                case.id.clone(),
                observations,
            )?);
        }
        MatrixRun::try_new(context, source_ids, cases)
    }

    /// Repeat a matrix over a bounded time window. Every sample must advance
    /// to a later Ethereum block; duplicate-block observations fail closed.
    pub async fn run_matrix_series(
        &self,
        manifest: &Manifest,
        matrix: &BenchmarkMatrix,
        source_ids: &[String],
        samples: usize,
        interval_seconds: u64,
    ) -> Result<MatrixSeries, Error> {
        validate_series_parameters(samples, interval_seconds)?;
        matrix.validate()?;
        validate_source_ids(manifest, source_ids)?;

        let mut runs = Vec::with_capacity(samples);
        for index in 0..samples {
            runs.push(self.run_matrix(manifest, matrix, source_ids).await?);
            if index + 1 < samples {
                tokio::time::sleep(std::time::Duration::from_secs(interval_seconds)).await;
            }
        }
        MatrixSeries::try_new(interval_seconds, source_ids, runs)
    }

    async fn observe_exact_in_at(
        &self,
        context: BlockContext,
        manifest: &Manifest,
        source_id: &str,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<Observation, Error> {
        if amount_in.is_zero() {
            return Err(Error::ZeroAmount);
        }
        if token_in == token_out {
            return Err(Error::SameToken);
        }
        let source = manifest.contract(source_id)?;
        if source.role != Role::QuoteSource || !source.shadow_enabled {
            return Err(Error::SourceDisabled(source_id.to_owned()));
        }

        let source_address = source.parsed_address()?;
        let expected_hash = source.parsed_code_hash()?;
        let actual_hash = self.rpc.code_hash_at(context, source_address).await?;
        if actual_hash != expected_hash {
            return Err(Error::CodeHashMismatch {
                id: source.id.clone(),
                expected: expected_hash,
                actual: actual_hash,
            });
        }

        let started = Instant::now();
        let result = match source.quote_adapter {
            QuoteAdapter::Aggregate => {
                self.observe_aggregate_at(context, source_address, token_in, token_out, amount_in)
                    .await
            }
            QuoteAdapter::UniswapV2Direct => {
                self.observe_uniswap_v2_at(context, source_address, token_in, token_out, amount_in)
                    .await
            }
            QuoteAdapter::UniswapV3Single => {
                self.observe_uniswap_v3_at(
                    context,
                    source_address,
                    &source.fee_tiers,
                    token_in,
                    token_out,
                    amount_in,
                )
                .await
            }
            QuoteAdapter::UniswapV4Single => {
                self.observe_uniswap_v4_at(
                    context,
                    source_address,
                    source,
                    token_in,
                    token_out,
                    amount_in,
                )
                .await
            }
        };
        let latency_micros = started.elapsed().as_micros().try_into().unwrap_or(u64::MAX);

        match result {
            Ok((best, candidates)) => Ok(Observation {
                context,
                source_id: source.id.clone(),
                token_in: format!("{token_in:#x}"),
                token_out: format!("{token_out:#x}"),
                amount_in: amount_in.to_string(),
                latency_micros,
                success: true,
                best: Some(best),
                candidates,
                error: None,
            }),
            Err(error) => Ok(Observation {
                context,
                source_id: source.id.clone(),
                token_in: format!("{token_in:#x}"),
                token_out: format!("{token_out:#x}"),
                amount_in: amount_in.to_string(),
                latency_micros,
                success: false,
                best: None,
                candidates: Vec::new(),
                error: Some(error),
            }),
        }
    }

    async fn observe_aggregate_at(
        &self,
        context: BlockContext,
        source_address: Address,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<(Quote, Vec<Quote>), String> {
        let call = getQuotesCall {
            exactOut: false,
            tokenIn: token_in,
            tokenOut: token_out,
            swapAmount: amount_in,
        };
        let data = self
            .rpc
            .call_at(context, source_address, call.abi_encode())
            .await
            .map_err(|error| format!("rpc: {error}"))?;
        let result =
            getQuotesCall::abi_decode_returns(&data).map_err(|error| format!("decode: {error}"))?;
        validate_decoded_quote(&result.best, &result.quotes, amount_in)
            .map_err(|error| format!("semantic: {error}"))?;

        Ok((
            result.best.into(),
            result.quotes.into_iter().map(Into::into).collect(),
        ))
    }

    async fn observe_uniswap_v3_at(
        &self,
        context: BlockContext,
        source_address: Address,
        fee_tiers: &[u32],
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<(Quote, Vec<Quote>), String> {
        let mut successes = Vec::with_capacity(fee_tiers.len());
        let mut failures = Vec::new();

        for fee in fee_tiers {
            let call = quoteExactInputSingleCall {
                params: QuoteExactInputSingleParams {
                    tokenIn: token_in,
                    tokenOut: token_out,
                    amountIn: amount_in,
                    fee: (*fee).try_into().expect("fee tier was validated"),
                    sqrtPriceLimitX96: U160::ZERO,
                },
            };
            let result = self
                .rpc
                .call_at(context, source_address, call.abi_encode())
                .await;
            match result {
                Ok(data) => match quoteExactInputSingleCall::abi_decode_returns(&data) {
                    Ok(decoded) if !decoded.amountOut.is_zero() => successes.push((
                        decoded.amountOut,
                        Quote {
                            source: 3,
                            source_name: source_name(3),
                            fee_bps: (*fee / 100).to_string(),
                            amount_in: amount_in.to_string(),
                            amount_out: decoded.amountOut.to_string(),
                            gas_estimate: Some(decoded.gasEstimate.to_string()),
                        },
                    )),
                    Ok(_) => failures.push(format!("fee {fee}: zero output")),
                    Err(error) => failures.push(format!("fee {fee}: decode: {error}")),
                },
                Err(error) => failures.push(format!("fee {fee}: rpc: {error}")),
            }
        }

        let best = successes
            .iter()
            .max_by_key(|(amount_out, _)| amount_out)
            .map(|(_, quote)| quote.clone())
            .ok_or_else(|| format!("all V3 baseline tiers failed: {}", failures.join("; ")))?;
        Ok((
            best,
            successes.into_iter().map(|(_, quote)| quote).collect(),
        ))
    }

    async fn observe_uniswap_v2_at(
        &self,
        context: BlockContext,
        source_address: Address,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<(Quote, Vec<Quote>), String> {
        let call = getAmountsOutCall {
            amountIn: amount_in,
            path: vec![token_in, token_out],
        };
        let data = self
            .rpc
            .call_at(context, source_address, call.abi_encode())
            .await
            .map_err(|error| format!("rpc: {error}"))?;
        let result = getAmountsOutCall::abi_decode_returns(&data)
            .map_err(|error| format!("decode: {error}"))?;

        if result.len() != 2 {
            return Err(format!(
                "semantic: direct-pair response has {} amounts",
                result.len()
            ));
        }
        if result[0] != amount_in {
            return Err("semantic: returned amount-in differs from the request".to_owned());
        }
        if result[1].is_zero() {
            return Err("semantic: returned amount-out is zero".to_owned());
        }

        let quote = Quote {
            source: 0,
            source_name: source_name(0),
            fee_bps: "30".to_owned(),
            amount_in: amount_in.to_string(),
            amount_out: result[1].to_string(),
            gas_estimate: None,
        };
        Ok((quote.clone(), vec![quote]))
    }

    async fn observe_uniswap_v4_at(
        &self,
        context: BlockContext,
        source_address: Address,
        source: &Contract,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
    ) -> Result<(Quote, Vec<Quote>), String> {
        let exact_amount: u128 = amount_in
            .try_into()
            .map_err(|_| "semantic: amount-in exceeds uint128".to_owned())?;
        let (currency0, currency1, zero_for_one) = if token_in < token_out {
            (token_in, token_out, true)
        } else {
            (token_out, token_in, false)
        };
        let mut successes = Vec::with_capacity(source.fee_tiers.len());
        let mut failures = Vec::new();

        for (fee, tick_spacing) in source.fee_tiers.iter().zip(&source.tick_spacings) {
            let call = IV4Quoter::quoteExactInputSingleCall {
                params: IV4Quoter::QuoteExactSingleParams {
                    poolKey: IV4Quoter::PoolKey {
                        currency0,
                        currency1,
                        fee: (*fee).try_into().expect("fee tier was validated"),
                        tickSpacing: (*tick_spacing)
                            .try_into()
                            .expect("tick spacing was validated"),
                        hooks: Address::ZERO,
                    },
                    zeroForOne: zero_for_one,
                    exactAmount: exact_amount,
                    hookData: Bytes::new(),
                },
            };
            let result = self
                .rpc
                .call_at(context, source_address, call.abi_encode())
                .await;
            match result {
                Ok(data) => match IV4Quoter::quoteExactInputSingleCall::abi_decode_returns(&data) {
                    Ok(decoded) if !decoded.amountOut.is_zero() => successes.push((
                        decoded.amountOut,
                        Quote {
                            source: 4,
                            source_name: source_name(4),
                            fee_bps: (*fee / 100).to_string(),
                            amount_in: amount_in.to_string(),
                            amount_out: decoded.amountOut.to_string(),
                            gas_estimate: Some(decoded.gasEstimate.to_string()),
                        },
                    )),
                    Ok(_) => {
                        failures.push(format!("fee {fee}, spacing {tick_spacing}: zero output"))
                    }
                    Err(error) => failures.push(format!(
                        "fee {fee}, spacing {tick_spacing}: decode: {error}"
                    )),
                },
                Err(error) => {
                    failures.push(format!("fee {fee}, spacing {tick_spacing}: rpc: {error}"))
                }
            }
        }

        let best = successes
            .iter()
            .max_by_key(|(amount_out, _)| amount_out)
            .map(|(_, quote)| quote.clone())
            .ok_or_else(|| format!("all V4 baseline pools failed: {}", failures.join("; ")))?;
        Ok((
            best,
            successes.into_iter().map(|(_, quote)| quote).collect(),
        ))
    }
}

fn validate_source_ids(manifest: &Manifest, source_ids: &[String]) -> Result<(), Error> {
    if source_ids.is_empty() {
        return Err(Error::NoSources);
    }
    let mut unique_sources = HashSet::new();
    for source_id in source_ids {
        if !unique_sources.insert(source_id.as_str()) {
            return Err(Error::DuplicateSource(source_id.clone()));
        }
        let source = manifest.contract(source_id)?;
        if source.role != Role::QuoteSource || !source.shadow_enabled {
            return Err(Error::SourceDisabled(source_id.clone()));
        }
    }
    Ok(())
}

fn validate_decoded_quote(
    best: &RawQuote,
    candidates: &[RawQuote],
    requested_amount_in: U256,
) -> Result<(), &'static str> {
    if best.amountIn != requested_amount_in {
        return Err("best amount-in differs from the request");
    }
    if best.amountOut.is_zero() {
        return Err("best amount-out is zero");
    }
    if best.source > 8 {
        return Err("best source enum is unknown");
    }
    if best.feeBps > U256::from(10_000) {
        return Err("best fee exceeds 100 percent");
    }
    if !candidates.iter().any(|candidate| {
        candidate.source == best.source
            && candidate.feeBps == best.feeBps
            && candidate.amountIn == best.amountIn
            && candidate.amountOut == best.amountOut
    }) {
        return Err("best quote is absent from the candidate set");
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub context: BlockContext,
    pub observations: Vec<Observation>,
}

impl Comparison {
    fn try_new(context: BlockContext, observations: Vec<Observation>) -> Result<Self, Error> {
        for observation in &observations {
            context.ensure_same(observation.context)?;
        }
        Ok(Self {
            context,
            observations,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRun {
    pub context: BlockContext,
    pub cases: Vec<MatrixCaseResult>,
    pub summaries: Vec<SourceSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSeries {
    pub sample_count: usize,
    pub interval_seconds: u64,
    pub first_context: BlockContext,
    pub last_context: BlockContext,
    pub summaries: Vec<SourceSummary>,
    pub runs: Vec<MatrixRun>,
}

impl MatrixSeries {
    fn try_new(
        interval_seconds: u64,
        source_ids: &[String],
        runs: Vec<MatrixRun>,
    ) -> Result<Self, Error> {
        validate_series_parameters(runs.len(), interval_seconds)?;
        for pair in runs.windows(2) {
            let previous = pair[0].context;
            let current = pair[1].context;
            if previous.chain_id != current.chain_id || current.number <= previous.number {
                return Err(Error::NonAdvancingSeriesBlock {
                    previous: previous.number,
                    current: current.number,
                });
            }
        }

        let first_context = runs.first().expect("series length was validated").context;
        let last_context = runs.last().expect("series length was validated").context;
        let cases: Vec<_> = runs.iter().flat_map(|run| run.cases.iter()).collect();
        let summaries = summarize_source_refs(source_ids, &cases);
        Ok(Self {
            sample_count: runs.len(),
            interval_seconds,
            first_context,
            last_context,
            summaries,
            runs,
        })
    }
}

impl MatrixRun {
    fn try_new(
        context: BlockContext,
        source_ids: &[String],
        cases: Vec<MatrixCaseResult>,
    ) -> Result<Self, Error> {
        for case in &cases {
            context.ensure_same(case.context)?;
        }
        let summaries = summarize_sources(source_ids, &cases);
        Ok(Self {
            context,
            cases,
            summaries,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCaseResult {
    pub context: BlockContext,
    pub case_id: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub winning_source_ids: Vec<String>,
    pub observations: Vec<Observation>,
}

impl MatrixCaseResult {
    fn try_new(
        context: BlockContext,
        case_id: String,
        observations: Vec<Observation>,
    ) -> Result<Self, Error> {
        for observation in &observations {
            context.ensure_same(observation.context)?;
        }
        let first = observations.first().ok_or(Error::NoSources)?;
        let token_in = first.token_in.clone();
        let token_out = first.token_out.clone();
        let amount_in = first.amount_in.clone();
        if observations.iter().any(|observation| {
            observation.token_in != token_in
                || observation.token_out != token_out
                || observation.amount_in != amount_in
        }) {
            return Err(Error::CaseInputMismatch(case_id));
        }

        let highest_output = observations.iter().filter_map(successful_amount_out).max();
        let winning_source_ids = highest_output
            .map(|highest| {
                observations
                    .iter()
                    .filter(|observation| successful_amount_out(observation) == Some(highest))
                    .map(|observation| observation.source_id.clone())
                    .collect()
            })
            .unwrap_or_default();

        Ok(Self {
            context,
            case_id,
            token_in,
            token_out,
            amount_in,
            winning_source_ids,
            observations,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    pub source_id: String,
    pub attempts: usize,
    pub successes: usize,
    pub failures: usize,
    pub success_rate_bps: usize,
    pub winning_cases: usize,
    pub outright_wins: usize,
    pub tied_wins: usize,
    pub p50_latency_micros: Option<u64>,
    pub p95_latency_micros: Option<u64>,
    pub p99_latency_micros: Option<u64>,
}

fn successful_amount_out(observation: &Observation) -> Option<U256> {
    observation
        .success
        .then_some(observation.best.as_ref())
        .flatten()
        .and_then(|quote| U256::from_str(&quote.amount_out).ok())
}

fn validate_series_parameters(samples: usize, interval_seconds: u64) -> Result<(), Error> {
    if !(MIN_SERIES_SAMPLES..=MAX_SERIES_SAMPLES).contains(&samples) {
        return Err(Error::InvalidSeriesSampleCount(samples));
    }
    if !(MIN_SERIES_INTERVAL_SECONDS..=MAX_SERIES_INTERVAL_SECONDS).contains(&interval_seconds) {
        return Err(Error::InvalidSeriesInterval(interval_seconds));
    }
    Ok(())
}

fn summarize_sources(source_ids: &[String], cases: &[MatrixCaseResult]) -> Vec<SourceSummary> {
    let cases: Vec<_> = cases.iter().collect();
    summarize_source_refs(source_ids, &cases)
}

fn summarize_source_refs(source_ids: &[String], cases: &[&MatrixCaseResult]) -> Vec<SourceSummary> {
    source_ids
        .iter()
        .map(|source_id| {
            let observations: Vec<_> = cases
                .iter()
                .filter_map(|case| {
                    case.observations
                        .iter()
                        .find(|observation| &observation.source_id == source_id)
                })
                .collect();
            let attempts = observations.len();
            let successes = observations
                .iter()
                .filter(|observation| observation.success)
                .count();
            let mut latencies: Vec<_> = observations
                .iter()
                .map(|observation| observation.latency_micros)
                .collect();
            latencies.sort_unstable();
            let winning_cases = cases
                .iter()
                .filter(|case| case.winning_source_ids.contains(source_id))
                .count();
            let outright_wins = cases
                .iter()
                .filter(|case| {
                    case.winning_source_ids.len() == 1
                        && case.winning_source_ids.first() == Some(source_id)
                })
                .count();

            SourceSummary {
                source_id: source_id.clone(),
                attempts,
                successes,
                failures: attempts.saturating_sub(successes),
                success_rate_bps: successes
                    .saturating_mul(10_000)
                    .checked_div(attempts)
                    .unwrap_or_default(),
                winning_cases,
                outright_wins,
                tied_wins: winning_cases.saturating_sub(outright_wins),
                p50_latency_micros: percentile(&latencies, 50),
                p95_latency_micros: percentile(&latencies, 95),
                p99_latency_micros: percentile(&latencies, 99),
            }
        })
        .collect()
}

fn percentile(sorted_values: &[u64], percentage: usize) -> Option<u64> {
    if sorted_values.is_empty() {
        return None;
    }
    let rank = sorted_values
        .len()
        .saturating_mul(percentage)
        .div_ceil(100)
        .saturating_sub(1);
    sorted_values.get(rank).copied()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub context: BlockContext,
    pub contracts: Vec<ContractVerification>,
}

impl Verification {
    pub fn all_match(&self) -> bool {
        self.contracts.iter().all(|contract| contract.matches)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractVerification {
    pub id: String,
    pub address: String,
    pub expected_code_hash: String,
    pub actual_code_hash: String,
    pub matches: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub context: BlockContext,
    pub source_id: String,
    pub token_in: String,
    pub token_out: String,
    pub amount_in: String,
    pub latency_micros: u64,
    pub success: bool,
    pub best: Option<Quote>,
    pub candidates: Vec<Quote>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub source: u8,
    pub source_name: &'static str,
    pub fee_bps: String,
    pub amount_in: String,
    pub amount_out: String,
    pub gas_estimate: Option<String>,
}

impl From<RawQuote> for Quote {
    fn from(value: RawQuote) -> Self {
        Self {
            source: value.source,
            source_name: source_name(value.source),
            fee_bps: value.feeBps.to_string(),
            amount_in: value.amountIn.to_string(),
            amount_out: value.amountOut.to_string(),
            gas_estimate: None,
        }
    }
}

fn source_name(source: u8) -> &'static str {
    match source {
        0 => "uniswap-v2",
        1 => "sushiswap",
        2 => "external-constant-product",
        3 => "uniswap-v3",
        4 => "uniswap-v4",
        5 => "curve",
        6 => "lido",
        7 => "weth-wrap",
        8 => "uniswap-v4-hooked",
        _ => "unknown",
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported manifest schema {0}")]
    UnsupportedSchema(u32),
    #[error("unsupported benchmark matrix schema {0}")]
    UnsupportedMatrixSchema(u32),
    #[error("benchmark matrix must contain at least one case")]
    EmptyMatrix,
    #[error("benchmark matrix contains {0} cases; maximum is {MAX_MATRIX_CASES}")]
    TooManyMatrixCases(usize),
    #[error("duplicate benchmark matrix case {0}")]
    DuplicateMatrixCase(String),
    #[error("invalid {field} address in benchmark matrix case {case}")]
    InvalidMatrixToken { case: String, field: &'static str },
    #[error("invalid amount-in in benchmark matrix case {0}")]
    InvalidMatrixAmount(String),
    #[error("benchmark matrix case {0} has a zero amount")]
    MatrixZeroAmount(String),
    #[error("benchmark matrix case {0} uses the same input and output token")]
    MatrixSameToken(String),
    #[error(
        "matrix series sample count {0} is outside the allowed range {MIN_SERIES_SAMPLES}..={MAX_SERIES_SAMPLES}"
    )]
    InvalidSeriesSampleCount(usize),
    #[error(
        "matrix series interval {0} seconds is outside the allowed range {MIN_SERIES_INTERVAL_SECONDS}..={MAX_SERIES_INTERVAL_SECONDS}"
    )]
    InvalidSeriesInterval(u64),
    #[error("matrix series block did not advance: previous {previous}, current {current}")]
    NonAdvancingSeriesBlock { previous: u64, current: u64 },
    #[error("manifest chain ID must be non-zero")]
    InvalidChainId,
    #[error("manifest observed block hash is invalid")]
    InvalidObservedBlockHash,
    #[error("duplicate contract id {0}")]
    DuplicateId(String),
    #[error("duplicate contract address {0}")]
    DuplicateAddress(String),
    #[error("invalid address for {0}")]
    InvalidAddress(String),
    #[error("invalid runtime code hash for {0}")]
    InvalidCodeHash(String),
    #[error("contract {0} depends on itself")]
    SelfDependency(String),
    #[error("contract {contract} references missing dependency {dependency}")]
    MissingDependency {
        contract: String,
        dependency: String,
    },
    #[error("non-source {0} cannot be shadow-enabled")]
    NonSourceEnabled(String),
    #[error("quote source {0} has pool configuration unsupported by its adapter")]
    UnexpectedPoolConfiguration(String),
    #[error("V3 baseline source {0} must define at least one fee tier")]
    MissingFeeTiers(String),
    #[error("V3 baseline source {contract} defines unsupported fee tier {fee}")]
    UnsupportedFeeTier { contract: String, fee: u32 },
    #[error("V3 baseline source {contract} repeats fee tier {fee}")]
    DuplicateFeeTier { contract: String, fee: u32 },
    #[error("V4 baseline source {0} must use the exact allowlisted fee and tick-spacing pairs")]
    InvalidV4PoolConfiguration(String),
    #[error("unknown contract {0}")]
    UnknownContract(String),
    #[error("quote source {0} is not enabled for observation")]
    SourceDisabled(String),
    #[error("at least one quote source is required")]
    NoSources,
    #[error("duplicate quote source {0}")]
    DuplicateSource(String),
    #[error("benchmark case {0} contains mismatched observation inputs")]
    CaseInputMismatch(String),
    #[error("amount is not a valid uint256")]
    InvalidAmount,
    #[error("quote amount must be non-zero")]
    ZeroAmount,
    #[error("input and output token must differ")]
    SameToken,
    #[error("runtime code hash mismatch for {id}: expected {expected:#x}, got {actual:#x}")]
    CodeHashMismatch {
        id: String,
        expected: B256,
        actual: B256,
    },
    #[error("one or more runtime code hashes differ from the manifest")]
    VerificationFailed,
    #[error(transparent)]
    ContextMismatch(#[from] ethrpc::block_context::ContextMismatch),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
    #[error(transparent)]
    Rpc(#[from] ethrpc::block_context::Error),
    #[error("HTTP client creation failed")]
    Http(
        #[from]
        #[source]
        reqwest::Error,
    ),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(
        context: BlockContext,
        source_id: &str,
        latency_micros: u64,
        amount_out: Option<&str>,
    ) -> Observation {
        Observation {
            context,
            source_id: source_id.to_owned(),
            token_in: format!("{:#x}", Address::repeat_byte(0x11)),
            token_out: format!("{:#x}", Address::repeat_byte(0x22)),
            amount_in: "1".to_owned(),
            latency_micros,
            success: amount_out.is_some(),
            best: amount_out.map(|amount_out| Quote {
                source: 0,
                source_name: "test",
                fee_bps: "0".to_owned(),
                amount_in: "1".to_owned(),
                amount_out: amount_out.to_owned(),
                gas_estimate: None,
            }),
            candidates: Vec::new(),
            error: amount_out.is_none().then(|| "fixture".to_owned()),
        }
    }

    #[test]
    fn checked_in_manifest_is_valid() {
        let manifest = Manifest::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/ethereum.toml"
        )))
        .unwrap();
        assert_eq!(manifest.network.chain_id, 1);
        assert!(
            manifest
                .contract("ophis-fixture-current")
                .unwrap()
                .shadow_enabled
        );
        let baseline = manifest.contract("ophis-baseline-uniswap-v3").unwrap();
        assert_eq!(baseline.quote_adapter, QuoteAdapter::UniswapV3Single);
        assert_eq!(baseline.fee_tiers, UNISWAP_V3_BASELINE_FEES);
        assert_eq!(
            manifest
                .contract("ophis-baseline-uniswap-v2")
                .unwrap()
                .quote_adapter,
            QuoteAdapter::UniswapV2Direct
        );
        let v4_baseline = manifest.contract("ophis-baseline-uniswap-v4").unwrap();
        assert_eq!(v4_baseline.quote_adapter, QuoteAdapter::UniswapV4Single);
        assert_eq!(
            v4_baseline
                .fee_tiers
                .iter()
                .copied()
                .zip(v4_baseline.tick_spacings.iter().copied())
                .collect::<Vec<_>>(),
            UNISWAP_V4_BASELINE_POOLS
        );
    }

    #[test]
    fn v3_baseline_requires_unique_supported_fee_tiers() {
        let mut manifest = Manifest::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/ethereum.toml"
        )))
        .unwrap();
        let baseline_index = manifest
            .contracts
            .iter()
            .position(|contract| contract.id == "ophis-baseline-uniswap-v3")
            .unwrap();

        manifest.contracts[baseline_index].fee_tiers.clear();
        assert!(matches!(
            manifest.validate(),
            Err(Error::MissingFeeTiers(_))
        ));

        manifest.contracts[baseline_index].fee_tiers = vec![100, 100];
        assert!(matches!(
            manifest.validate(),
            Err(Error::DuplicateFeeTier { .. })
        ));

        manifest.contracts[baseline_index].fee_tiers = vec![42];
        assert!(matches!(
            manifest.validate(),
            Err(Error::UnsupportedFeeTier { .. })
        ));
    }

    #[test]
    fn v3_baseline_uses_the_canonical_quoter_v2_selector() {
        let call = quoteExactInputSingleCall {
            params: QuoteExactInputSingleParams {
                tokenIn: Address::repeat_byte(0x11),
                tokenOut: Address::repeat_byte(0x22),
                amountIn: U256::from(100),
                fee: 500_u32.try_into().unwrap(),
                sqrtPriceLimitX96: U160::ZERO,
            },
        };
        assert_eq!(&call.abi_encode()[..4], &[0xc6, 0xa5, 0x02, 0x6a]);
    }

    #[test]
    fn v2_baseline_uses_the_canonical_get_amounts_out_selector() {
        let call = getAmountsOutCall {
            amountIn: U256::from(100),
            path: vec![Address::repeat_byte(0x11), Address::repeat_byte(0x22)],
        };
        assert_eq!(&call.abi_encode()[..4], &[0xd0, 0x6c, 0xa6, 0x1f]);
    }

    #[test]
    fn v2_baseline_rejects_fee_tiers() {
        let mut manifest = Manifest::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/ethereum.toml"
        )))
        .unwrap();
        let baseline = manifest
            .contracts
            .iter_mut()
            .find(|contract| contract.id == "ophis-baseline-uniswap-v2")
            .unwrap();
        baseline.fee_tiers.push(3_000);
        assert!(matches!(
            manifest.validate(),
            Err(Error::UnexpectedPoolConfiguration(_))
        ));
    }

    #[test]
    fn v4_baseline_uses_the_canonical_single_pool_selector() {
        let call = IV4Quoter::quoteExactInputSingleCall {
            params: IV4Quoter::QuoteExactSingleParams {
                poolKey: IV4Quoter::PoolKey {
                    currency0: Address::repeat_byte(0x11),
                    currency1: Address::repeat_byte(0x22),
                    fee: 100_u32.try_into().unwrap(),
                    tickSpacing: 1_i32.try_into().unwrap(),
                    hooks: Address::ZERO,
                },
                zeroForOne: true,
                exactAmount: 100,
                hookData: Bytes::new(),
            },
        };
        assert_eq!(&call.abi_encode()[..4], &[0xaa, 0x9d, 0x21, 0xcb]);
    }

    #[test]
    fn v4_baseline_requires_exact_allowlisted_pool_pairs() {
        let mut manifest = Manifest::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/ethereum.toml"
        )))
        .unwrap();
        let baseline = manifest
            .contracts
            .iter_mut()
            .find(|contract| contract.id == "ophis-baseline-uniswap-v4")
            .unwrap();
        baseline.tick_spacings[0] = 10;
        assert!(matches!(
            manifest.validate(),
            Err(Error::InvalidV4PoolConfiguration(_))
        ));
    }

    #[test]
    fn checked_in_matrix_is_valid() {
        let matrix = BenchmarkMatrix::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/ethereum-matrix.toml"
        )))
        .unwrap();
        assert_eq!(matrix.cases.len(), 10);

        let expanded = BenchmarkMatrix::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/ethereum-matrix-expanded.toml"
        )))
        .unwrap();
        assert_eq!(expanded.cases.len(), 30);
    }

    #[test]
    fn source_labels_do_not_trust_unknown_enum_values() {
        assert_eq!(source_name(2), "external-constant-product");
        assert_eq!(source_name(255), "unknown");
    }

    #[test]
    fn decoded_quote_must_match_request_and_candidate_set() {
        let valid = RawQuote {
            source: 3,
            feeBps: U256::from(1),
            amountIn: U256::from(100),
            amountOut: U256::from(200),
        };
        assert!(
            validate_decoded_quote(&valid, std::slice::from_ref(&valid), U256::from(100)).is_ok()
        );

        let wrong_amount = RawQuote {
            source: 3,
            feeBps: U256::from(1),
            amountIn: U256::from(99),
            amountOut: U256::from(200),
        };
        assert!(
            validate_decoded_quote(
                &wrong_amount,
                std::slice::from_ref(&wrong_amount),
                U256::from(100)
            )
            .is_err()
        );

        let unknown_source = RawQuote {
            source: 255,
            feeBps: U256::from(1),
            amountIn: U256::from(100),
            amountOut: U256::from(200),
        };
        assert!(
            validate_decoded_quote(
                &unknown_source,
                std::slice::from_ref(&unknown_source),
                U256::from(100)
            )
            .is_err()
        );
        assert!(validate_decoded_quote(&valid, &[], U256::from(100)).is_err());
    }

    #[test]
    fn comparison_rejects_mixed_block_contexts() {
        let expected = BlockContext {
            chain_id: 1,
            number: 42,
            hash: B256::repeat_byte(0x11),
            observed_at_unix_millis: 1,
        };
        let mut different = expected;
        different.hash = B256::repeat_byte(0x22);

        Comparison::try_new(expected, vec![observation(expected, "test", 1, None)]).unwrap();
        assert!(
            Comparison::try_new(expected, vec![observation(different, "test", 1, None)]).is_err()
        );
    }

    #[test]
    fn matrix_summary_counts_failures_ties_and_percentiles() {
        let context = BlockContext {
            chain_id: 1,
            number: 42,
            hash: B256::repeat_byte(0x11),
            observed_at_unix_millis: 1,
        };
        let cases = vec![
            MatrixCaseResult::try_new(
                context,
                "one".to_owned(),
                vec![
                    observation(context, "a", 10, Some("10")),
                    observation(context, "b", 20, Some("9")),
                ],
            )
            .unwrap(),
            MatrixCaseResult::try_new(
                context,
                "two".to_owned(),
                vec![
                    observation(context, "a", 30, Some("5")),
                    observation(context, "b", 40, Some("5")),
                ],
            )
            .unwrap(),
            MatrixCaseResult::try_new(
                context,
                "three".to_owned(),
                vec![
                    observation(context, "a", 50, None),
                    observation(context, "b", 60, Some("7")),
                ],
            )
            .unwrap(),
        ];
        let run = MatrixRun::try_new(context, &["a".to_owned(), "b".to_owned()], cases).unwrap();

        let a = &run.summaries[0];
        assert_eq!(a.attempts, 3);
        assert_eq!(a.successes, 2);
        assert_eq!(a.failures, 1);
        assert_eq!(a.winning_cases, 2);
        assert_eq!(a.outright_wins, 1);
        assert_eq!(a.tied_wins, 1);
        assert_eq!(a.p50_latency_micros, Some(30));
        assert_eq!(a.p95_latency_micros, Some(50));

        let b = &run.summaries[1];
        assert_eq!(b.successes, 3);
        assert_eq!(b.winning_cases, 2);
        assert_eq!(b.outright_wins, 1);
        assert_eq!(b.tied_wins, 1);
    }

    #[test]
    fn matrix_series_requires_advancing_blocks_and_aggregates_samples() {
        let first = BlockContext {
            chain_id: 1,
            number: 42,
            hash: B256::repeat_byte(0x11),
            observed_at_unix_millis: 1,
        };
        let second = BlockContext {
            chain_id: 1,
            number: 43,
            hash: B256::repeat_byte(0x22),
            observed_at_unix_millis: 2,
        };
        let sources = vec!["a".to_owned()];
        let first_run = MatrixRun::try_new(
            first,
            &sources,
            vec![
                MatrixCaseResult::try_new(
                    first,
                    "one".to_owned(),
                    vec![observation(first, "a", 10, Some("10"))],
                )
                .unwrap(),
            ],
        )
        .unwrap();
        let second_run = MatrixRun::try_new(
            second,
            &sources,
            vec![
                MatrixCaseResult::try_new(
                    second,
                    "one".to_owned(),
                    vec![observation(second, "a", 20, Some("11"))],
                )
                .unwrap(),
            ],
        )
        .unwrap();
        let series = MatrixSeries::try_new(12, &sources, vec![first_run, second_run]).unwrap();
        assert_eq!(series.sample_count, 2);
        assert_eq!(series.first_context, first);
        assert_eq!(series.last_context, second);
        assert_eq!(series.summaries[0].attempts, 2);
        assert_eq!(series.summaries[0].successes, 2);

        let duplicate_first = MatrixRun::try_new(first, &sources, Vec::new()).unwrap();
        let duplicate_second = MatrixRun::try_new(first, &sources, Vec::new()).unwrap();
        assert!(matches!(
            MatrixSeries::try_new(12, &sources, vec![duplicate_first, duplicate_second]),
            Err(Error::NonAdvancingSeriesBlock { .. })
        ));
    }
}
