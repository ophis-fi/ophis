use {
    crate::infra::Ethereum,
    alloy::providers::Provider,
    axum::{
        Json,
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::get,
    },
    serde::Serialize,
    std::time::Duration,
};

/// Maximum acceptable age (from the moment the block was first observed by
/// this process) before the driver reports itself unhealthy. Note: backed by
/// `Instant`, which on Linux is `CLOCK_MONOTONIC` and pauses across VM
/// suspend — by design, since a suspended VM should report unhealthy via
/// freshness anyway once it resumes and time catches up.
const MAX_BLOCK_OBSERVATION_AGE: Duration = Duration::from_secs(30);

/// Hard wall-clock cap on the chain-id RPC query. A stalled upstream must
/// not be able to hang the probe past LB / k8s timeouts.
const CHAIN_ID_RPC_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize)]
struct Health {
    ok: bool,
    block_number: u64,
    block_age_seconds: u64,
    chain_id: u64,
}

#[derive(Serialize)]
struct HealthFailure {
    ok: bool,
    failures: Vec<String>,
}

pub(in crate::infra::api) fn healthz(app: axum::Router<Ethereum>) -> axum::Router<Ethereum> {
    app.route("/healthz", get(route))
}

async fn route(eth: axum::extract::State<Ethereum>) -> Response {
    let mut failures = Vec::new();

    // Check 1: block freshness. Uses the observed-at instant rather than the
    // chain-reported block.timestamp because the latter can drift on testnets
    // and against compromised upstreams.
    let block = *eth.current_block().borrow();
    let block_age = block.observed_at.elapsed();
    if block_age > MAX_BLOCK_OBSERVATION_AGE {
        failures.push(format!(
            "latest block was observed {age}s ago, exceeds threshold {max}s",
            age = block_age.as_secs(),
            max = MAX_BLOCK_OBSERVATION_AGE.as_secs(),
        ));
    }

    // Check 2: RPC-reported chain_id matches configured chain. Catches a
    // hostile or misconfigured upstream that silently switched networks.
    // Wall-clock-bounded so a stalled upstream can't hang the probe.
    // The error string is intentionally generic — provider errors can embed
    // the RPC URL (which may carry an API key in path/query for some
    // providers); details are emitted via tracing::warn! below for ops.
    let configured = eth.chain();
    let rpc_chain_id_result = tokio::time::timeout(
        CHAIN_ID_RPC_TIMEOUT,
        eth.web3().provider.get_chain_id(),
    )
    .await;
    match rpc_chain_id_result {
        Ok(Ok(rpc_id)) if rpc_id == configured.id() => {}
        Ok(Ok(rpc_id)) => {
            failures.push(format!(
                "RPC reports chain_id {rpc_id} but driver is configured for chain_id \
                 {configured_id} ({configured_name})",
                configured_id = configured.id(),
                configured_name = configured.name(),
            ));
        }
        Ok(Err(err)) => {
            tracing::warn!(?err, "healthz get_chain_id RPC error");
            failures.push("get_chain_id RPC query failed".to_string());
        }
        Err(_) => {
            failures.push(format!(
                "get_chain_id RPC query did not return within {timeout}s",
                timeout = CHAIN_ID_RPC_TIMEOUT.as_secs(),
            ));
        }
    }

    if failures.is_empty() {
        Json(Health {
            ok: true,
            block_number: block.number,
            block_age_seconds: block_age.as_secs(),
            chain_id: configured.id(),
        })
        .into_response()
    } else {
        tracing::warn!(?failures, "driver healthz reporting unhealthy");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthFailure {
                ok: false,
                failures,
            }),
        )
            .into_response()
    }
}
