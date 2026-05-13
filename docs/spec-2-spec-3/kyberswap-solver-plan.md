# KyberSwap Solver — Implementation Plan

Produced by the `feature-dev:code-architect` agent on 2026-05-13.
Target branch: `feat/kyberswap-solver` off `docs/spec-2-spec-3`.

## 1. Patterns & Conventions Found

**OKX module structure** (`apps/backend/crates/solvers/src/infra/dex/okx/`):
- `mod.rs` (516 lines): `Okx` struct, `Config` struct, `try_new(config) -> Result<Self, CreationError>`, `pub async fn swap(&self, order: &dex::Order, slippage: &dex::Slippage) -> Result<dex::Swap, Error>`, HMAC-SHA256 signing, moka cache for approval addresses, `handle_api_error(code, msg)`, generic `send_get_request<T, U>(base_url, sig_url, endpoint, query)`
- `dto.rs` (312 lines): All request/response structs with `#[serde_as]`, `HexOrDecimalU256` for U256 amounts, `BytesHex` for calldata, `Response<T>` wrapper

**KyberSwap is different in three critical ways vs OKX:**
1. Two separate HTTP calls (GET `/routes` then POST `/route/build`) vs OKX's single GET
2. No HMAC signing — only an optional `x-client-id` header
3. No separate approval-transaction endpoint — the router address comes directly in the `/routes` response as `routerAddress`

**Shared infrastructure to reuse:**
- `super::Client` (in `infra/dex/mod.rs:58`) — wraps `reqwest::Client` + optional block-hash header
- `util::http::roundtrip!` macro — handles GET responses; for POST use `.send()` directly as Bitget does
- `moka::future::Cache` — not needed for KyberSwap (router address is returned per-call, no separate approval endpoint)
- `dex::Slippage::as_bps() -> Option<u16>` — already exists in `domain/dex/slippage.rs:79`, maps slippage directly to the integer basis-points KyberSwap expects

**Config pattern** (`infra/config/dex/okx/`):
- `mod.rs`: thin `Config { okx: ..., base: ... }` wrapper
- `file.rs`: `#[serde(rename_all = "kebab-case", deny_unknown_fields)]` struct + `async fn load(path) -> super::Config`
- Dex-specific TOML section lives under `[dex]` key, parsed by `file::load::<T>(path)` generic

**Test pattern** (`tests/okx/`):
- `mod.rs`: `pub fn config(addr: &SocketAddr) -> tests::Config` helper building inline TOML
- `market_order.rs`, `not_found.rs`, `out_of_price.rs`, `api_calls.rs`: all use `mock::http::setup(vec![Expectation::Get/Post {...}])` + `SolverEngine::new("kyberswap", config)` + `engine.solve(json!({...}))` + `assert_eq!(solution, json!({...}))`
- POST expectations use `mock::http::Expectation::Post { path, req: RequestBody::Exact(...), res }` — this enum variant already exists in `tests/mock/http.rs`

**Slippage:** `dex::Slippage::as_bps()` converts the `BigDecimal` factor to `u16` basis points. KyberSwap's `slippageTolerance` is an integer in bps (range 0–2000). The conversion is already implemented.

**Gas padding:** Both OKX and Bitget add 50% to the API-returned gas. KyberSwap's `/route/build` response returns `gas` as a decimal string. Apply the same 50% padding.

**Allowance:** KyberSwap's `/routes` response includes `routerAddress` at the top level of `data`. This is the spender address for the ERC-20 approval — exactly what OKX's separate `approve-transaction` endpoint returns. No cache needed; the address is returned in every call.

**Buy orders:** KyberSwap's aggregator API is strictly `exactIn` (sell orders only). Buy orders must return `Error::OrderNotSupported`, identical to Bitget's approach.

**No new Cargo dependencies** are required. All needed crates (`reqwest`, `serde`, `serde_with`, `bytes-hex`, `alloy`, `thiserror`, `moka` is available but not needed) are already in `Cargo.toml`.

---

## 2. File-by-File Plan

### Files to CREATE

**`apps/backend/crates/solvers/src/infra/dex/kyberswap/mod.rs`** (~220 lines)

Responsibilities: `KyberSwap` struct, `Config` struct, `try_new`, `swap` (chains `get_route` + `build_route`), error types, `From<util::http::RoundtripError<dto::ApiError>>` impl.

Key decisions vs OKX:
- No HMAC signing logic
- No `dex_approved_addresses` moka cache
- No `buy_orders_endpoint` / `sell_orders_signature_base_url` complexity
- Single endpoint base URL; chain slug embedded in path
- Two sequential HTTP calls per swap: GET then POST
- Optional `x-client-id` header (set once on `reqwest::Client` default headers if configured)

```rust
pub struct KyberSwap {
    client: super::Client,
    base_url: reqwest::Url,  // e.g. https://aggregator-api.kyberswap.com/optimism/api/v1/
    defaults: Defaults,
}

struct Defaults {
    settlement_contract: eth::Address,
}

pub struct Config {
    pub base_url: reqwest::Url,
    pub chain_id: eth::ChainId,
    pub settlement_contract: alloy::primitives::Address,
    pub client_id: Option<String>,       // x-client-id header, optional
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl KyberSwap {
    pub fn try_new(config: Config) -> Result<Self, CreationError> { ... }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> { ... }

    async fn get_route(&self, order: &dex::Order) -> Result<dto::RoutesResponse, Error> { ... }

    async fn build_route(
        &self,
        route_summary: dto::RouteSummary,
        router_address: eth::Address,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dto::BuildResponse, Error> { ... }
}
```

---

**`apps/backend/crates/solvers/src/infra/dex/kyberswap/dto.rs`** (~160 lines)

Responsibilities: All request/response DTOs for both API calls.

```rust
// === GET /routes request (query params) ===
#[serde_as]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesRequest {
    pub token_in: eth::Address,
    pub token_out: eth::Address,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_in: U256,
    pub save_gas: bool,                  // always false
    pub gas_include: bool,               // always true
}

// === GET /routes response ===
#[derive(Deserialize, Clone)]
pub struct RoutesApiResponse {
    pub code: i64,
    pub message: String,
    pub data: Option<RoutesData>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoutesData {
    pub route_summary: RouteSummary,
    pub router_address: eth::Address,
}

// RouteSummary must be serializable (it's echoed verbatim to /route/build)
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RouteSummary {
    pub token_in: eth::Address,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_in: U256,
    pub amount_in_usd: String,
    pub token_out: eth::Address,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_out: U256,
    pub amount_out_usd: String,
    pub gas: String,
    pub gas_price: String,
    pub gas_usd: String,
    pub route: serde_json::Value,        // opaque; echo verbatim
    pub route_id: Option<String>,
    pub checksum: Option<String>,
    pub timestamp: Option<String>,
    pub extra_fee: Option<serde_json::Value>,
}

// === POST /route/build request body ===
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    pub route_summary: RouteSummary,     // verbatim from step 1
    pub sender: eth::Address,
    pub recipient: eth::Address,
    pub slippage_tolerance: u16,         // basis points, 0–2000
    pub deadline: Option<u64>,           // unix timestamp; None → API default (+20 min)
    pub enable_gas_estimation: bool,     // false — we use the gas from step 1
}

// === POST /route/build response ===
#[derive(Deserialize, Clone)]
pub struct BuildApiResponse {
    pub code: i64,
    pub message: String,
    pub data: Option<BuildData>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BuildData {
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_in: U256,
    #[serde_as(as = "serde_with::DisplayFromStr")]
    pub amount_out: U256,
    pub gas: String,                     // decimal string e.g. "200000"
    pub data: BytesHex,                  // encoded calldata
    pub router_address: eth::Address,    // should match step 1; use this as canonical
}

// === Shared error ===
#[derive(Deserialize)]
pub struct ApiError {
    pub code: i64,
    pub message: String,
}
```

Note on `route`: KyberSwap's route is a `Vec<Vec<pool_step>>` with nested sub-objects. Since we echo it verbatim to `/route/build`, deserializing as `serde_json::Value` avoids needing to model the full nested structure.

Note on `gas` in `BuildData`: returned as a decimal string (e.g. `"210000"`). Parse with `gas.parse::<u64>()` then convert to `U256`.

Note on `BytesHex` for `data`: this is the `bytes_hex::BytesHex` type already used in `okx/dto.rs` for calldata deserialization.

---

**`apps/backend/crates/solvers/src/infra/config/dex/kyberswap/mod.rs`** (~10 lines)

```rust
pub mod file;

pub struct Config {
    pub kyberswap: crate::infra::dex::kyberswap::Config,
    pub base: super::Config,
}
```

---

**`apps/backend/crates/solvers/src/infra/config/dex/kyberswap/file.rs`** (~80 lines)

```rust
#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct Config {
    /// Base URL for the KyberSwap aggregator API including chain slug.
    /// Defaults to https://aggregator-api.kyberswap.com/{chain_slug}/api/v1/
    #[serde(default)]  // computed from chain_id if absent
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    endpoint: Option<reqwest::Url>,

    /// Chain ID (10 for Optimism).
    chain_id: eth::ChainId,

    /// Optional x-client-id header sent with every request.
    #[serde(default)]
    client_id: Option<String>,
}

fn chain_slug(chain_id: eth::ChainId) -> &'static str {
    match chain_id {
        eth::ChainId::Mainnet    => "ethereum",
        eth::ChainId::Optimism   => "optimism",
        eth::ChainId::Arbitrum   => "arbitrum",
        eth::ChainId::Base       => "base",
        eth::ChainId::Polygon    => "polygon",
        eth::ChainId::Bnb        => "bsc",
        eth::ChainId::Gnosis     => "gnosis",
        eth::ChainId::Avalanche  => "avalanche",
        eth::ChainId::Linea      => "linea",
        _ => panic!("unsupported KyberSwap chain: {chain_id:?}"),
    }
}

fn default_endpoint(chain_id: eth::ChainId) -> reqwest::Url {
    format!(
        "https://aggregator-api.kyberswap.com/{}/api/v1/",
        chain_slug(chain_id)
    ).parse().unwrap()
}

pub async fn load(path: &Path) -> super::Config {
    let (base, config) = file::load::<Config>(path).await;
    let endpoint = config.endpoint
        .unwrap_or_else(|| default_endpoint(config.chain_id));
    super::Config {
        kyberswap: kyberswap::Config {
            base_url: endpoint,
            chain_id: config.chain_id,
            settlement_contract: base.contracts.settlement,
            client_id: config.client_id,
            block_stream: base.block_stream.clone(),
        },
        base,
    }
}
```

---

**`apps/backend/crates/solvers/config/example.kyberswap.toml`** (~20 lines)

```toml
node-url = "http://localhost:8545"

[dex]
# Chain ID. KyberSwap supports Optimism (10), Ethereum (1), Base (8453),
# Arbitrum (42161), Polygon (137), BNB (56), Gnosis (100), Avalanche (43114),
# Linea (59144).
chain-id = "10"

# Optional: override the API endpoint (default derived from chain-id above).
# endpoint = "https://aggregator-api.kyberswap.com/optimism/api/v1/"

# Optional: x-client-id header sent with every request. Recommended to avoid
# aggressive rate limiting. A simple string identifier for your integration.
# client-id = "ophis-solver"
```

---

**`apps/backend/crates/solvers/src/tests/kyberswap/mod.rs`** (~25 lines)

```rust
use {crate::tests, std::net::SocketAddr};

mod api_calls;
mod market_order;
mod not_found;
mod out_of_price;

pub fn config(solver_addr: &SocketAddr) -> tests::Config {
    tests::Config::String(format!(
        r"
node-url = 'http://localhost:8545'
[dex]
chain-id = '10'
endpoint = 'http://{solver_addr}/'
",
    ))
}
```

---

**`apps/backend/crates/solvers/src/tests/kyberswap/market_order.rs`** (~150 lines)

Happy-path sell order test: two mock expectations (GET then POST), full auction JSON, assert solution shape matches expected interactions/allowances/gas.

**`apps/backend/crates/solvers/src/tests/kyberswap/not_found.rs`** (~60 lines)

Two sub-tests:
- Routes GET returns `code: 4008` (no route found) → `solutions: []`
- Routes GET returns `code: 4010` (no eligible pools) → `solutions: []`

**`apps/backend/crates/solvers/src/tests/kyberswap/out_of_price.rs`** (~80 lines)

Routes GET returns a valid route, build POST returns valid calldata, but `amountOut` is below the order's `buyAmount` limit. Solver framework handles this via `Swap::satisfies()` check. Result: `solutions: []`.

**`apps/backend/crates/solvers/src/tests/kyberswap/api_calls.rs`** (~60 lines)

`#[ignore]`-gated integration test calling live KyberSwap OP Sepolia (chain 11155420). No env vars needed (no API key). Useful for manual smoke testing. Test slug for OP Sepolia: `"optimism-sepolia"`.

---

### Files to MODIFY

**`apps/backend/crates/solvers/src/infra/dex/mod.rs`**

Four changes:

1. Add `pub mod kyberswap;` after line 9.

2. Add variant to `Dex` enum (after line 16):
```rust
pub enum Dex {
    Bitget(bitget::Bitget),
    Okx(Box<okx::Okx>),
    KyberSwap(Box<kyberswap::KyberSwap>),   // ADD
}
```

3. Add match arm in `Dex::swap()` (after line 32):
```rust
Dex::KyberSwap(kyberswap) => kyberswap.swap(order, slippage).await?,
```

4. Add `From<kyberswap::Error> for Error` impl (after line 121):
```rust
impl From<kyberswap::Error> for Error {
    fn from(err: kyberswap::Error) -> Self {
        match err {
            kyberswap::Error::OrderNotSupported => Self::OrderNotSupported,
            kyberswap::Error::NotFound          => Self::NotFound,
            kyberswap::Error::RateLimited       => Self::RateLimited,
            _                                   => Self::Other(Box::new(err)),
        }
    }
}
```

---

**`apps/backend/crates/solvers/src/infra/cli.rs`**

Add variant to `Command` enum (after line 55):
```rust
/// solve individual orders via the KyberSwap aggregator API
KyberSwap {
    #[clap(long, env)]
    config: PathBuf,
},
```

---

**`apps/backend/crates/solvers/src/run.rs`**

Add match arm in `run_with()` (after line 66):
```rust
cli::Command::KyberSwap { config: path } => {
    let config = config::dex::kyberswap::file::load(&path).await;
    solver::Solver::Dex(Box::new(solver::Dex::new(
        dex::Dex::KyberSwap(Box::new(
            dex::kyberswap::KyberSwap::try_new(config.kyberswap)
                .expect("invalid KyberSwap configuration"),
        )),
        config.base,
    )))
}
```

---

**`apps/backend/crates/solvers/src/infra/config/dex/mod.rs`**

Add `pub mod kyberswap;` after line 3.

---

**`apps/backend/crates/solvers/src/tests/mod.rs`**

Add `mod kyberswap;` after line 17.

---

## 3. Two-Step Flow Design

```
swap(order, slippage)
  │
  ├─ Step 1: GET {base_url}routes?tokenIn=...&tokenOut=...&amountIn=...&saveGas=false&gasInclude=true
  │           ↓
  │   RoutesApiResponse { code, data: Some(RoutesData { route_summary, router_address }) }
  │           ↓
  │   if code != 0  → handle_api_error(code) → Error::NotFound | Error::RateLimited | Error::Api
  │   if data.is_none() → Error::NotFound
  │           ↓
  │   Capture: route_summary (will be POST body), router_address (spender for allowance)
  │
  ├─ Step 2: POST {base_url}route/build
  │           body: { routeSummary: <from step 1>, sender: settlement, recipient: settlement,
  │                   slippageTolerance: <bps>, enableGasEstimation: false }
  │           ↓
  │   BuildApiResponse { code, data: Some(BuildData { amount_in, amount_out, gas, data, router_address }) }
  │           ↓
  │   if code != 0  → handle_api_error(code) → Error::NotFound | Error::RateLimited | Error::Api
  │   if data.is_none() → Error::BuildFailed
  │           ↓
  │   gas_str.parse::<u64>().map_err(|_| Error::GasCalculationFailed)?
  │   gas_u256 = gas_u256 + gas_u256 / 2  (50% padding, checked_add)
  │           ↓
  │   return dex::Swap {
  │     calls: [Call { to: build_data.router_address, calldata: build_data.data }],
  │     input:  { token: order.sell, amount: build_data.amount_in },
  │     output: { token: order.buy,  amount: build_data.amount_out },
  │     allowance: { spender: routes_router_address.0, amount: Amount::new(build_data.amount_in) },
  │     gas: eth::Gas(gas_u256),
  │   }
```

**If step 1 succeeds but step 2 fails:** propagate step 2's error directly via `?`. The caller (domain solver) sees `Error::NotFound` or `Error::Api` and drops the order for this auction cycle. No partial state is persisted.

**Router address source for allowance:** Use `router_address` from the step-1 (`/routes`) response, not from step-2. Both responses return `routerAddress` and they should be identical; using step-1's value means the allowance is known before calldata is built. Step-2's `router_address` should be validated to match step-1's if you want extra safety, but this is optional — treat mismatch as `Error::Api`.

**Sequential (not parallel):** Unlike OKX's `tokio::try_join!` for sell orders, the two KyberSwap calls must be sequential because step 2 requires step 1's `routeSummary` payload. No parallelism opportunity here.

---

## 4. Slippage Handling

KyberSwap's `slippageTolerance` is an integer in basis points (0–2000, representing 0%–20%).

The `dex::Slippage` type already provides `as_bps() -> Option<u16>` at `domain/dex/slippage.rs:79`. The method multiplies the `BigDecimal` factor by 10,000 and converts to `u32`, then casts to `u16`.

Mapping in `build_route`:

```rust
let slippage_bps: u16 = slippage
    .as_bps()
    .ok_or(Error::InvalidSlippage)?;
// KyberSwap caps at 2000 bps (20%). Clamp rather than error.
let slippage_tolerance = slippage_bps.min(2000);
```

The `as_bps()` returns `None` only if the value overflows `u16` (slippage > 655%). For any sane config value this will not happen. Clamping to 2000 is defensive — if the solver config has `relative_slippage = 0.3` (30%), KyberSwap would reject anything above 2000 bps, so we cap it.

**Why not use the step-1 route's implicit min-out?** KyberSwap's `/routes` endpoint does not apply slippage to `amountOut`; slippage is only applied in `/route/build` via the `slippageTolerance` field. The route's `amountOut` is the best-case output before slippage deduction. This is consistent with how OKX works (slippage passed as a query param to the swap endpoint).

---

## 5. Approvals / Token Allowance

KyberSwap has **no separate approval-transaction endpoint**. The router address (spender) is returned directly in the `/routes` response as `data.routerAddress` — a single consistent address per chain (KyberSwap's MetaAggregationRouterV2 on Optimism: `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`).

In the `dex::Swap` struct, `allowance.spender` is set to this `routerAddress`. The CoW solver framework will generate the appropriate ERC-20 `approve()` call before the swap interaction if the current allowance is insufficient, via `solution::Allowance` mechanics.

**Comparison to OKX:** OKX requires a parallel `GET approve-transaction?...` call per token to get the contract address, then caches it in a moka `Cache<(token, side), eth::ContractAddress>`. KyberSwap eliminates this entirely — the address comes for free with every route, no cache needed.

**Allowance amount:** Use `build_data.amount_in` as the allowance amount (exact sell amount). For KyberSwap, since only sell orders (exactIn) are supported, the sell amount is fixed and known precisely from the build response.

---

## 6. Tests to Write

### `tests/kyberswap/market_order.rs`

**`sell_happy_path`:** Two mock expectations:
- `Expectation::Get` matching `routes?tokenIn=0x...&tokenOut=0x...&amountIn=1000000000000000000&saveGas=false&gasInclude=true` → canned `RoutesApiResponse` with `code: 0`, `routeSummary` fully populated, `routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"`
- `Expectation::Post` matching `route/build` with `RequestBody::Partial(json!({ "slippageTolerance": 100, "sender": "0x9008...", "recipient": "0x9008..." }), vec!["routeSummary.timestamp", "routeSummary.checksum"])` → canned `BuildApiResponse` with `code: 0`, `data: "0xABCD..."`, `gas: "200000"`, `amountIn`, `amountOut`, `routerAddress`

Assert: solution has one interaction, `allowances[0].spender == routerAddress`, `gas == 410000` (200000 * 1.5 + 106391 gas_offset from config), input/output tokens match order.

**`buy_order_not_supported`:** No mock expectations; pass a buy-order auction; assert `solutions: []`.

### `tests/kyberswap/not_found.rs`

**`routes_no_route`:** Single `Expectation::Get` returning `{ code: 4008, message: "Route not found", data: null }`. Assert `solutions: []`.

**`routes_no_pools`:** `{ code: 4010 }` → `solutions: []`.

**`build_fails_after_route`:** Two mock expectations: GET returns valid route, POST returns `{ code: 4008 }`. Assert `solutions: []`. This tests step-2 failure propagation.

### `tests/kyberswap/out_of_price.rs`

**`sell_insufficient_output`:** Both GET and POST succeed with valid data, but `amountOut` is set to a small value that doesn't satisfy the order's `buyAmount`. Assert `solutions: []` (filtered by `Swap::satisfies()`).

### `tests/kyberswap/api_calls.rs`

**`swap_sell_live`:** `#[ignore]` integration test. Build a `KyberSwap` config directly (no TOML loading) targeting `https://aggregator-api.kyberswap.com/optimism/api/v1/`. Use OP mainnet WETH→USDC. Assert `swap.input.token == order.sell`, `swap.output.token == order.buy`, `swap.allowance.spender == expected_router`.

**`swap_sell_op_sepolia`:** `#[ignore]` integration test targeting chain slug `optimism-sepolia` (chain 11155420). Confirms the API works on testnet for smoke testing deployments.

---

## 7. Build & Smoke Test Plan

### Compile check

```bash
cd /Users/scep/greg/apps/backend
cargo check -p solvers 2>&1
```

This catches all type errors, missing imports, and trait mismatches without running tests.

### Clippy

```bash
cargo clippy -p solvers -- -D warnings 2>&1
```

Pay attention to: unused imports (KyberSwap doesn't need `hmac`, `base64`, `chrono`, `AtomicU64`), shadowed variable names in the two-step flow, unnecessary `.clone()` on `RouteSummary`.

### Unit tests

```bash
cargo test -p solvers kyberswap 2>&1
```

This runs all tests under `tests/kyberswap/` that are not `#[ignore]`. Expect: `market_order::sell_happy_path`, `market_order::buy_order_not_supported`, `not_found::routes_no_route`, `not_found::routes_no_pools`, `not_found::build_fails_after_route`, `out_of_price::sell_insufficient_output`.

### Full test suite (regression check)

```bash
cargo test -p solvers 2>&1
```

Confirms no OKX or Bitget tests regressed due to `mod.rs` changes.

### Live smoke test against OP Sepolia

```bash
cargo test -p solvers kyberswap::api_calls::swap_sell_op_sepolia -- --ignored --nocapture 2>&1
```

No env vars needed (KyberSwap is free / no auth). OP Sepolia chain slug: `"optimism-sepolia"`. Use chain ID 11155420 — note this is **not** in the current `eth::ChainId` enum. Either add it temporarily for the test, or test against mainnet with `#[ignore]`.

**OP Mainnet live test:**

```bash
cargo test -p solvers kyberswap::api_calls::swap_sell_live -- --ignored --nocapture 2>&1
```

Requires live network access from the Mac mini. KyberSwap OP mainnet router: `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`.

### Binary smoke test (production wiring)

```bash
# Build the binary
cargo build -p solvers --bin solvers 2>&1

# Run with the example config (requires node-url to be reachable, will fail fast with config parse errors)
./target/debug/solvers \
  --addr 127.0.0.1:7999 \
  kyberswap \
  --config apps/backend/crates/solvers/config/example.kyberswap.toml \
  2>&1
```

Expected: process starts, logs `running solver engine`, accepts connections. Kill with Ctrl-C. This confirms CLI wiring, config loading, and struct construction work end-to-end.

---

## 8. Risks and Unknowns

**`x-client-id` rate limiting:** The API spec says `x-client-id` is "required" but it works without it at low volumes. Without a client-id, KyberSwap may apply stricter rate limits per source IP. At solver scale (dozens of requests per auction cycle), the shared `aggregator-api.kyberswap.com` endpoint may rate-limit within minutes. Mitigation: always send a `client-id` value. No API key registration needed — any stable string works (e.g. `"ophis-solver"`).

**`routeSummary` echo contract:** The `/route/build` endpoint requires echoing the `routeSummary` object exactly as received from `/routes`, including `checksum`, `timestamp`, `routeID`, and the nested `route` array. If any field is silently dropped during deserialization (missing from the struct), the build call may return `4002` (malformed body) or produce incorrect routes. The `route` field is a deeply nested array-of-arrays; modeling it as `serde_json::Value` avoids this. Verify in the live smoke test that the POST body sent has all fields intact by enabling trace logging.

**`amountOut` representation:** The `/routes` response returns `amountOut` as a decimal string (e.g. `"6556259156432631386442"`). This is a raw wei amount (no decimal scaling). The `#[serde_as(as = "serde_with::DisplayFromStr")]` pattern used by OKX's `HexOrDecimalU256` handles decimal strings. However, `HexOrDecimalU256` is specifically designed for hex-or-decimal — confirm it handles pure decimal without "0x" prefix. If not, use `serde_with::DisplayFromStr` directly on `U256`.

**`gas` field in `/route/build` response:** Returned as a plain decimal string (e.g. `"210000"`), not a `U256`. The `gas.parse::<u64>()` approach is straightforward but must handle potential leading zeros or whitespace. Use `.trim().parse::<u64>()` to be safe.

**No buy-order support:** KyberSwap's aggregator API is `exactIn` only (confirmed by docs). Buy orders must immediately return `Error::OrderNotSupported`. This is a known capability gap vs OKX (which has V5 exactOut support). Document this clearly in the config example TOML so operators know.

**`slippageTolerance` cap at 2000:** KyberSwap docs specify range [0, 2000]. If the solver's `relative_slippage` config exceeds 20% (unlikely but possible), the clamp will silently reduce effective slippage. This could cause build failures downstream (slippage too tight relative to route's actual price impact). Log a warning when clamping occurs.

**Chain slug for OP Sepolia (11155420):** KyberSwap supports OP Sepolia for testing under the slug `"optimism-sepolia"`, but this chain ID is not in `eth::ChainId`. The `chain_slug()` function will panic if passed an unknown chain. For the live test, either add `ChainId::OptimismSepolia = 11155420` to the enum (minor but clean), or construct the `base_url` manually in the test bypassing `chain_slug()`.

**Stale route / timestamp mismatch:** KyberSwap's `routeSummary` includes a `timestamp` field. If the time between GET and POST is too long (unusual in normal operation), the build call may reject the route as stale. In practice, both calls complete within milliseconds on the same request. Not a practical risk but worth noting for debugging if `4002` errors appear sporadically.

**No `approve-transaction` → no moka cache needed:** KyberSwap's design eliminates the approval-address cache entirely. This simplifies the struct (no `Cache` field, no cache-invalidation concerns) and reduces latency by one HTTP call per order compared to OKX.

---

## Implementation Sequence (Checklist)

- [ ] Create `apps/backend/crates/solvers/src/infra/dex/kyberswap/dto.rs`
- [ ] Create `apps/backend/crates/solvers/src/infra/dex/kyberswap/mod.rs`
- [ ] Modify `apps/backend/crates/solvers/src/infra/dex/mod.rs` (4 hunks: `pub mod`, enum variant, match arm, From impl)
- [ ] Create `apps/backend/crates/solvers/src/infra/config/dex/kyberswap/mod.rs`
- [ ] Create `apps/backend/crates/solvers/src/infra/config/dex/kyberswap/file.rs`
- [ ] Modify `apps/backend/crates/solvers/src/infra/config/dex/mod.rs` (add `pub mod kyberswap;`)
- [ ] Modify `apps/backend/crates/solvers/src/infra/cli.rs` (add `Command::KyberSwap` variant)
- [ ] Modify `apps/backend/crates/solvers/src/run.rs` (add match arm)
- [ ] Create `apps/backend/crates/solvers/config/example.kyberswap.toml`
- [ ] `cargo check -p solvers` — must be clean
- [ ] Create `apps/backend/crates/solvers/src/tests/kyberswap/mod.rs`
- [ ] Create `apps/backend/crates/solvers/src/tests/kyberswap/market_order.rs`
- [ ] Create `apps/backend/crates/solvers/src/tests/kyberswap/not_found.rs`
- [ ] Create `apps/backend/crates/solvers/src/tests/kyberswap/out_of_price.rs`
- [ ] Create `apps/backend/crates/solvers/src/tests/kyberswap/api_calls.rs`
- [ ] Modify `apps/backend/crates/solvers/src/tests/mod.rs` (add `mod kyberswap;`)
- [ ] `cargo test -p solvers kyberswap` — all 6 unit tests pass
- [ ] `cargo test -p solvers` — full suite clean (no regressions)
- [ ] `cargo clippy -p solvers -- -D warnings` — clean
- [ ] Binary smoke test with example config
- [ ] `#[ignore]` live test against KyberSwap OP mainnet
