//! Read-only, block-pinned Ophis Quote Lab observations.
//!
//! This crate is intentionally not a solver `Dex` implementation. It cannot
//! build a Settlement interaction or submit a transaction.

use {
    alloy::{
        primitives::{Address, B256, U256},
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

        let call = getQuotesCall {
            exactOut: false,
            tokenIn: token_in,
            tokenOut: token_out,
            swapAmount: amount_in,
        };
        let started = Instant::now();
        let result = self
            .rpc
            .call_at(context, source_address, call.abi_encode())
            .await;
        let latency_micros = started.elapsed().as_micros().try_into().unwrap_or(u64::MAX);

        match result {
            Ok(data) => match getQuotesCall::abi_decode_returns(&data) {
                Ok(result) => match validate_decoded_quote(&result.best, &result.quotes, amount_in)
                {
                    Ok(()) => Ok(Observation {
                        context,
                        source_id: source.id.clone(),
                        token_in: format!("{token_in:#x}"),
                        token_out: format!("{token_out:#x}"),
                        amount_in: amount_in.to_string(),
                        latency_micros,
                        success: true,
                        best: Some(result.best.into()),
                        candidates: result.quotes.into_iter().map(Into::into).collect(),
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
                        error: Some(format!("semantic: {error}")),
                    }),
                },
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
                    error: Some(format!("decode: {error}")),
                }),
            },
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
                error: Some(format!("rpc: {error}")),
            }),
        }
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

fn summarize_sources(source_ids: &[String], cases: &[MatrixCaseResult]) -> Vec<SourceSummary> {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub source: u8,
    pub source_name: &'static str,
    pub fee_bps: String,
    pub amount_in: String,
    pub amount_out: String,
}

impl From<RawQuote> for Quote {
    fn from(value: RawQuote) -> Self {
        Self {
            source: value.source,
            source_name: source_name(value.source),
            fee_bps: value.feeBps.to_string(),
            amount_in: value.amountIn.to_string(),
            amount_out: value.amountOut.to_string(),
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
    }

    #[test]
    fn checked_in_matrix_is_valid() {
        let matrix = BenchmarkMatrix::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/ethereum-matrix.toml"
        )))
        .unwrap();
        assert_eq!(matrix.cases.len(), 10);
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
}
