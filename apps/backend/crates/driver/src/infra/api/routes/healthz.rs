use {
    crate::infra::{Ethereum, solver::Solver},
    alloy::providers::Provider,
    axum::{
        Json,
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::get,
    },
    chain::Chain,
    eth_domain_types as eth,
    futures::future::join_all,
    serde::Serialize,
    std::{sync::Arc, time::Duration},
};

/// Maximum acceptable age (from the moment the block was first observed by
/// this process) before the driver reports itself unhealthy. Backed by
/// `Instant` — pauses across VM suspend by design.
const MAX_BLOCK_OBSERVATION_AGE: Duration = Duration::from_secs(30);

/// Hard wall-clock cap on the chain-id RPC query.
const CHAIN_ID_RPC_TIMEOUT: Duration = Duration::from_secs(5);

/// Hard wall-clock cap on each per-solver balance RPC query.
const BALANCE_RPC_TIMEOUT: Duration = Duration::from_secs(5);

/// Outer probe budget — total wall-clock cap on the entire /healthz handler.
/// k8s default probe `timeoutSeconds` is typically 1-3s; LB front-ends often
/// 5-10s. We bound the whole probe at 6s so per-RPC timeouts (which fire
/// individually at 5s but run concurrently) can't compound past LB windows.
const HEALTHZ_BUDGET: Duration = Duration::from_secs(6);

/// Per-chain minimum submitter-EOA balance, denominated in the chain's
/// **native gas token wei** (e.g. WEI for Ethereum-family, HYPE-wei for
/// HyperEVM). Threshold sized for ~5-10 settlements of headroom so an
/// operator has time to refill before settlements start failing.
///
/// Chains not in the table fall through to `DEFAULT_MIN_BALANCE_WEI`; the
/// chain_id is logged when that fallback fires, so operators see the cliff
/// at deploy time rather than at out-of-funds time.
const DEFAULT_MIN_BALANCE_WEI: u128 = 10_000_000_000_000_000; // 0.01 native = 10 mUNIT

fn min_balance_for(chain: Chain) -> u128 {
    match chain {
        // Mainnet — ~0.005 ETH per settlement at 20 gwei; 0.1 ETH = 20 settle.
        Chain::Mainnet => 100_000_000_000_000_000, // 0.1 ETH
        // Optimism — ~0.0001 ETH per settlement; 0.01 ETH = 100 settle.
        Chain::Optimism => 10_000_000_000_000_000, // 0.01 ETH
        // OP Sepolia — keep low so testnet faucet drips refill reliably.
        Chain::OptimismSepolia => 1_000_000_000_000_000, // 0.001 ETH
        // HyperEVM mainnet — gas paid in HYPE; threshold in HYPE-wei.
        // Conservative: 0.1 HYPE (~$2-5 depending on price).
        Chain::HyperEvmMainnet => 100_000_000_000_000_000, // 0.1 HYPE
        Chain::HyperEvmTestnet => 10_000_000_000_000_000, // 0.01 HYPE testnet
        // MegaETH mainnet — native ETH; conservative 0.01 ETH = 10 mETH.
        Chain::MegaethMainnet => 10_000_000_000_000_000, // 0.01 ETH
        // Anything else (Sepolia, Goerli, Base, Arbitrum, etc.): default.
        _ => DEFAULT_MIN_BALANCE_WEI,
    }
}

#[derive(Clone)]
pub(in crate::infra::api) struct HealthcheckState {
    pub eth: Ethereum,
    pub solvers: Arc<Vec<Solver>>,
}

#[derive(Serialize)]
struct SubmitterReport {
    solver: String,
    address: String,
    balance_wei: String,
    /// None when the balance RPC failed/timed-out (status reflects that).
    /// `Some(true)` = below threshold, `Some(false)` = OK.
    below_threshold: Option<bool>,
    status: &'static str,
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    block_number: u64,
    block_age_seconds: u64,
    chain_id: u64,
    min_balance_wei: String,
    submitters: Vec<SubmitterReport>,
}

#[derive(Serialize)]
struct HealthFailure {
    ok: bool,
    failures: Vec<String>,
    submitters: Vec<SubmitterReport>,
}

pub(in crate::infra::api) fn healthz(
    app: axum::Router<HealthcheckState>,
) -> axum::Router<HealthcheckState> {
    app.route("/healthz", get(route))
}

async fn route(state: axum::extract::State<HealthcheckState>) -> Response {
    // Outer probe budget: never let /healthz exceed HEALTHZ_BUDGET wall-clock.
    // Per-RPC timeouts inside `run_probe` are belt-and-suspenders.
    match tokio::time::timeout(HEALTHZ_BUDGET, run_probe(state.0.clone())).await {
        Ok(response) => response,
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthFailure {
                ok: false,
                failures: vec![format!(
                    "healthz probe exceeded {budget}s budget",
                    budget = HEALTHZ_BUDGET.as_secs()
                )],
                submitters: vec![],
            }),
        )
            .into_response(),
    }
}

async fn run_probe(state: HealthcheckState) -> Response {
    let HealthcheckState { eth, solvers } = state;
    let configured = eth.chain();
    let min_balance = min_balance_for(configured);
    let mut failures = Vec::new();

    // Check 1: block freshness.
    let block = *eth.current_block().borrow();
    let block_age = block.observed_at.elapsed();
    if block_age > MAX_BLOCK_OBSERVATION_AGE {
        failures.push(format!(
            "latest block was observed {age}s ago, exceeds threshold {max}s",
            age = block_age.as_secs(),
            max = MAX_BLOCK_OBSERVATION_AGE.as_secs(),
        ));
    }

    // Checks 2 + 3 fan out concurrently. With N solvers and the chain_id
    // call, worst-case wall clock = max(CHAIN_ID_RPC_TIMEOUT, BALANCE_RPC_TIMEOUT)
    // ≈ 5s, well under HEALTHZ_BUDGET.
    let chain_id_fut = check_chain_id(&eth, configured);
    let balance_futs = solvers
        .iter()
        .map(|s| check_one_balance(eth.clone(), s.clone(), min_balance));

    let (chain_id_failure, submitters) =
        tokio::join!(chain_id_fut, join_all(balance_futs));

    if let Some(msg) = chain_id_failure {
        failures.push(msg);
    }
    for report in &submitters {
        if let Some(msg) = balance_failure_message(report) {
            failures.push(msg);
        }
    }

    if failures.is_empty() {
        Json(Health {
            ok: true,
            block_number: block.number,
            block_age_seconds: block_age.as_secs(),
            chain_id: configured.id(),
            min_balance_wei: min_balance.to_string(),
            submitters,
        })
        .into_response()
    } else {
        tracing::warn!(?failures, "driver healthz reporting unhealthy");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthFailure {
                ok: false,
                failures,
                submitters,
            }),
        )
            .into_response()
    }
}

async fn check_chain_id(eth: &Ethereum, configured: Chain) -> Option<String> {
    match tokio::time::timeout(CHAIN_ID_RPC_TIMEOUT, eth.web3().provider.get_chain_id()).await {
        Ok(Ok(rpc_id)) if rpc_id == configured.id() => None,
        Ok(Ok(rpc_id)) => Some(format!(
            "RPC reports chain_id {rpc_id} but driver is configured for chain_id \
             {configured_id} ({configured_name})",
            configured_id = configured.id(),
            configured_name = configured.name(),
        )),
        Ok(Err(err)) => {
            tracing::warn!(?err, "healthz get_chain_id RPC error");
            Some("get_chain_id RPC query failed".to_string())
        }
        Err(_) => Some(format!(
            "get_chain_id RPC query did not return within {timeout}s",
            timeout = CHAIN_ID_RPC_TIMEOUT.as_secs(),
        )),
    }
}

async fn check_one_balance(
    eth: Ethereum,
    solver: Solver,
    min_balance: u128,
) -> SubmitterReport {
    let addr = solver.address();
    let name = solver.name().to_string();
    match tokio::time::timeout(BALANCE_RPC_TIMEOUT, eth.balance(addr)).await {
        Ok(Ok(balance)) => {
            let balance_wei: eth::U256 = balance.into();
            let below = balance_wei < eth::U256::from(min_balance);
            SubmitterReport {
                solver: name,
                address: format!("{addr:?}"),
                balance_wei: balance_wei.to_string(),
                below_threshold: Some(below),
                status: if below { "below_threshold" } else { "ok" },
            }
        }
        Ok(Err(err)) => {
            tracing::warn!(?err, ?addr, "healthz balance RPC error");
            SubmitterReport {
                solver: name,
                address: format!("{addr:?}"),
                balance_wei: "unknown".to_string(),
                below_threshold: None,
                status: "rpc_error",
            }
        }
        Err(_) => SubmitterReport {
            solver: name,
            address: format!("{addr:?}"),
            balance_wei: "timeout".to_string(),
            below_threshold: None,
            status: "rpc_timeout",
        },
    }
}

fn balance_failure_message(report: &SubmitterReport) -> Option<String> {
    match (report.below_threshold, report.status) {
        (Some(true), _) => Some(format!(
            "submitter EOA {addr} for solver {solver} balance {balance} below threshold",
            addr = report.address,
            solver = report.solver,
            balance = report.balance_wei,
        )),
        (None, "rpc_error") => Some(format!(
            "balance() RPC query failed for solver {}",
            report.solver
        )),
        (None, "rpc_timeout") => Some(format!(
            "balance() RPC query timed out for solver {}",
            report.solver
        )),
        _ => None,
    }
}
