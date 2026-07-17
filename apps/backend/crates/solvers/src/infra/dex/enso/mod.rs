//! Bindings to the Enso Shortcuts/Route aggregator API.
//!
//! Enso's route flow is a single authenticated HTTP call:
//! - `GET /api/v1/shortcuts/route` — returns the best route as one executable
//!   transaction (`tx.{to,data,value}`) plus the optimistic `amountOut` and the
//!   GUARANTEED `minAmountOut` (the on-chain slippage floor baked into the
//!   calldata).
//!
//! This is a NON-RFQ, executable-by-the-spender route (NOT a signed
//! market-maker quote): with `routingStrategy=router` the EnsoRouter at `tx.to`
//! pulls `tokenIn` from the caller via `transferFrom` and delivers `tokenOut`
//! to the `receiver` we specify, enforcing `minAmountOut` on-chain. Because we
//! pin `fromAddress = receiver = spender = the Settlement contract`, the
//! returned calldata stays executable by an arbitrary caller (the Settlement)
//! for the seconds-to-minutes a CoW settlement takes to land. The route
//! response carries NO off-chain deadline/signature/permit, so nothing expires.
//!
//! Enso requires a Bearer API key (no anonymous tier); it is set as a default
//! `Authorization` header on the client and is fail-fasted on at construction.
//!
//! Full upstream docs: <https://docs.enso.build>.

use {
    crate::{
        domain::{dex, eth, order},
        util,
    },
    alloy::primitives::{Address, U256},
    ethrpc::block_stream::CurrentBlockWatcher,
    reqwest::StatusCode,
    std::sync::atomic::{self, AtomicU64},
    tracing::Instrument,
};

mod dto;

/// Maximum slippage (in bps) we will ever send to Enso. Mirrors the
/// kyberswap / velora / openocean 20% safety cap.
const MAX_SLIPPAGE_BPS: u16 = 2000;

/// Fallback gas estimate (units) used when Enso omits or returns an
/// unparseable `gas` hint. The driver re-simulates, so this only nudges
/// ranking; a typical Enso router swap is well under this padded value.
const DEFAULT_GAS: u64 = 400_000;

/// Allowlist of EnsoRouter addresses that can be approved as the ERC-20
/// spender for the Settlement contract on chain 130.
///
/// **Why a fixed allowlist?** The `tx.to` returned by `/shortcuts/route` is
/// trusted as both the call target AND the allowance grantee — a compromised
/// Enso edge (DNS hijack, CA compromise, malicious CDN, insider) returning an
/// attacker-controlled router could drain the Settlement's transient balance.
/// Enso is a single-call API with no per-request equality cross-check, so the
/// static allowlist is the ONLY router-poisoning defense. Validate BEFORE use.
///
/// **Spender == call target.** With `routingStrategy=router` the caller
/// approves `tx.to`, which pulls `tokenIn` via `transferFrom` — there is no
/// separate approval target, so allowlisting `tx.to` covers both roles.
///
/// **Address coverage (chain 130 — Unichain):**
/// `0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf` — EnsoRouter. Verified live
/// 2026-06-30: `eth_getCode` on https://mainnet.unichain.org returns 3313
/// bytes for this address on chain 130; the live `/shortcuts/route` response
/// returns this exact address as `tx.to`, stable across token pairs.
///
/// **If Enso redeploys the router**: add the new address here after independent
/// on-chain verification — do NOT take it from a `/route` response unchecked.
const ENSO_ROUTER_ALLOWLIST: &[Address] = &[
    // EnsoRouter on Unichain (130).
    // EIP-55: 0xF75584eF6673aD213a685a1B58Cc0330B8eA22Cf (raw bytes lowercased).
    Address::new([
        0xf7, 0x55, 0x84, 0xef, 0x66, 0x73, 0xad, 0x21, 0x3a, 0x68, 0x5a, 0x1b, 0x58, 0xcc, 0x03,
        0x30, 0xb8, 0xea, 0x22, 0xcf,
    ]),
];

fn validate_router_allowlist(router: &Address) -> Result<(), Error> {
    if ENSO_ROUTER_ALLOWLIST.contains(router) {
        Ok(())
    } else {
        Err(Error::Api {
            code: -1,
            reason: format!(
                "Enso returned non-allowlisted router address {router:?}. Refusing \
                 to call / approve. If this is a legitimate new EnsoRouter, add it \
                 to ENSO_ROUTER_ALLOWLIST in crates/solvers/src/infra/dex/enso/mod.rs \
                 after independent on-chain verification."
            ),
        })
    }
}

/// Parse Enso's `gas` hint, which may be a JSON number or a decimal string.
/// Falls back to [`DEFAULT_GAS`] on any other / unparseable shape.
fn parse_gas(value: &serde_json::Value) -> u64 {
    match value {
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(DEFAULT_GAS),
        serde_json::Value::String(s) => s.trim().parse::<u64>().unwrap_or(DEFAULT_GAS),
        _ => DEFAULT_GAS,
    }
}

/// Bindings to the Enso Shortcuts/Route aggregator API.
pub struct Enso {
    client: super::Client,
    /// Base URL including a trailing slash, e.g.
    /// `https://api.enso.build/api/v1/`.
    base_url: reqwest::Url,
    chain_id: u64,
    settlement_contract: Address,
}

pub struct Config {
    /// Base URL for the Enso API including a trailing slash. Defaults to
    /// `https://api.enso.build/api/v1/`.
    pub base_url: reqwest::Url,

    /// Chain ID. Enso keys its endpoints by `chainId`; this solver is verified
    /// on Unichain (130).
    pub chain_id: eth::ChainId,

    /// CoW settlement contract — pinned as fromAddress / receiver / spender so
    /// the returned calldata is executable by the settlement and the output
    /// lands in its buffer.
    pub settlement_contract: Address,

    /// Enso Bearer API key (REQUIRED — no anonymous tier). SECRET: rendered
    /// from `${ENSO_API_KEY}`, never hardcoded. Sent as the `Authorization:
    /// Bearer <key>` default header. Auth / rate-limit only — never the funds
    /// path.
    pub api_key: String,

    /// Block stream used to attach the current block hash header so an egress
    /// proxy can cache responses per block.
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl Enso {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        // Fail fast on an empty API key. `HeaderValue::from_str("")` is
        // `Ok(empty)`, so an unset `${ENSO_API_KEY}` render path would
        // otherwise start a lane that 403s on every solve (Enso has no
        // anonymous tier) — crash at startup instead of failing at runtime.
        if config.api_key.trim().is_empty() {
            return Err(CreationError::EmptyApiKey);
        }

        let client = {
            let mut auth =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", config.api_key))?;
            auth.set_sensitive(true);
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(reqwest::header::AUTHORIZATION, auth);

            let client = reqwest::Client::builder()
                .default_headers(headers)
                .build()?;
            super::Client::new(client, config.block_stream)
        };

        Ok(Self {
            client,
            base_url: config.base_url,
            chain_id: config.chain_id as u64,
            settlement_contract: config.settlement_contract,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> {
        // Enso /shortcuts/route is exactIn-only (sell side).
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        async move {
            let route = self.get_route(order, slippage).await?;

            // Validate the router BEFORE using it as the call target / spender.
            // This is the ONLY router-poisoning defense (single-call API).
            validate_router_allowlist(&route.tx.to)?;

            // ERC-20 -> ERC-20 only. The settlement holds wrapped tokens, so a
            // non-zero native `value` means the route expects ETH the settlement
            // won't attach — refuse rather than build a call that can only revert
            // at settle time (the same wrapped-settlement guard DODO/OpenOcean
            // apply).
            if !route.tx.value.is_zero() {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "Enso route requires non-zero native value {}",
                        route.tx.value
                    ),
                });
            }

            // A zero guaranteed output is a degenerate / malformed route.
            if route.min_amount_out.is_zero() {
                return Err(Error::NotFound);
            }

            let gas_u256 = U256::from(parse_gas(&route.gas));
            let gas = gas_u256
                .checked_add(gas_u256 / U256::from(2))
                .ok_or(Error::GasCalculationFailed)?;

            Ok(dex::Swap {
                calls: vec![dex::Call {
                    to: route.tx.to,
                    calldata: route.tx.data,
                }],
                input: eth::Asset {
                    token: order.sell,
                    // exactIn SELL: input is fixed to the order's sell amount.
                    // We never trust an API-echoed input — the amount sent to
                    // Enso is `order.amount`, and the allowance below is sized
                    // to the same value with NO pad.
                    amount: order.amount.get(),
                },
                output: eth::Asset {
                    token: order.buy,
                    // Report the GUARANTEED on-chain floor (`minAmountOut`),
                    // NOT the optimistic `amountOut`. Enso bakes minAmountOut
                    // into the calldata and the router reverts below it. Paying
                    // the optimistic value as the CoW buy clearing amount would
                    // exceed what the router realizes and revert the buy-side
                    // transfer, dropping the solution. Paying the floor always
                    // succeeds; surplus above it accrues to the Settlement
                    // buffer. The #726 buffer-siphon / revert fix.
                    amount: route.min_amount_out,
                },
                allowance: dex::Allowance {
                    // routingStrategy=router: `tx.to` is the ERC-20 spender.
                    // Already allowlist-validated above.
                    spender: route.tx.to,
                    // exactIn: allowance == input == order amount, NO pad.
                    amount: dex::Amount::new(order.amount.get()),
                },
                gas: eth::Gas(gas),
            })
        }
        .instrument(tracing::trace_span!("enso-route", id = %id))
        .await
    }

    /// Single call — fetch the route + encoded calldata for an exactIn order.
    async fn get_route(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dto::RouteResponse, Error> {
        // Enso's `slippage` is an integer in bps (e.g. 100 = 1%). Route it
        // through the shared clamp so the same metric/cap discipline applies as
        // for kyberswap / velora / openocean; the floor (`minAmountOut`) Enso
        // returns is derived from exactly this value.
        let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let clamped_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Enso,
            slippage_bps,
            MAX_SLIPPAGE_BPS,
        );

        let settlement = format!("{:#x}", self.settlement_contract);
        let query = [
            ("chainId", self.chain_id.to_string()),
            ("tokenIn", format!("{:#x}", order.sell.0)),
            ("tokenOut", format!("{:#x}", order.buy.0)),
            // exactIn: amountIn is the sell amount in wei.
            ("amountIn", order.amount.get().to_string()),
            ("slippage", clamped_bps.to_string()),
            // RFQ exclusion: pin fromAddress / receiver / spender to the
            // Settlement so the calldata is executable by an arbitrary later
            // caller and the output lands in the settlement buffer.
            ("fromAddress", settlement.clone()),
            ("receiver", settlement.clone()),
            ("spender", settlement),
            // Single self-contained on-chain route through the EnsoRouter.
            ("routingStrategy", "router".to_string()),
        ];

        let url = self
            .base_url
            .join("shortcuts/route")
            .map_err(|_| Error::RequestBuildFailed)?;
        let request = self.client.request(reqwest::Method::GET, url).query(&query);

        let response: dto::RouteResponse =
            util::http::roundtrip!(<dto::RouteResponse, dto::ApiError>; request).await?;

        Ok(response)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error("the Enso api-key is empty — set a non-empty ${{ENSO_API_KEY}}")]
    EmptyApiKey,
    #[error(transparent)]
    Header(#[from] reqwest::header::InvalidHeaderValue),
    #[error(transparent)]
    Client(#[from] reqwest::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to build the request")]
    RequestBuildFailed,
    #[error("calculating output gas failed")]
    GasCalculationFailed,
    #[error("unable to find a quote")]
    NotFound,
    #[error("order type is not supported")]
    OrderNotSupported,
    #[error("rate limited")]
    RateLimited,
    #[error("slippage tolerance overflowed u16 basis points")]
    InvalidSlippage,
    #[error("api error code {code}: {reason}")]
    Api { code: i64, reason: String },
    #[error(transparent)]
    Http(util::http::Error),
}

impl From<util::http::RoundtripError<dto::ApiError>> for Error {
    fn from(err: util::http::RoundtripError<dto::ApiError>) -> Self {
        match err {
            util::http::RoundtripError::Http(err) => {
                if let util::http::Error::Status(code, _) = err
                    && code == StatusCode::TOO_MANY_REQUESTS
                {
                    Self::RateLimited
                } else {
                    Self::Http(err)
                }
            }
            util::http::RoundtripError::Api(err) => {
                if err.status_code == 429 {
                    return Self::RateLimited;
                }
                let reason = if !err.message.is_empty() {
                    err.message
                } else {
                    err.error
                };
                let lower = reason.to_ascii_lowercase();
                if lower.contains("no route")
                    || lower.contains("not found")
                    || lower.contains("insufficient liquidity")
                    || lower.contains("cannot find")
                    || lower.contains("no liquidity")
                {
                    return Self::NotFound;
                }
                Self::Api {
                    code: err.status_code,
                    reason,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_enso_router_rejects_other() {
        let router = Address::new([
            0xf7, 0x55, 0x84, 0xef, 0x66, 0x73, 0xad, 0x21, 0x3a, 0x68, 0x5a, 0x1b, 0x58, 0xcc,
            0x03, 0x30, 0xb8, 0xea, 0x22, 0xcf,
        ]);
        assert!(validate_router_allowlist(&router).is_ok());
        assert!(validate_router_allowlist(&Address::ZERO).is_err());
    }

    #[test]
    fn parse_gas_handles_number_string_and_fallback() {
        assert_eq!(parse_gas(&serde_json::json!(250000)), 250_000);
        assert_eq!(parse_gas(&serde_json::json!("250000")), 250_000);
        assert_eq!(parse_gas(&serde_json::json!("  250000 ")), 250_000);
        assert_eq!(parse_gas(&serde_json::Value::Null), DEFAULT_GAS);
        assert_eq!(parse_gas(&serde_json::json!("not-a-number")), DEFAULT_GAS);
        assert_eq!(parse_gas(&serde_json::json!(["unexpected"])), DEFAULT_GAS);
    }

    #[test]
    fn floor_is_min_amount_out_not_optimistic() {
        // The route DTO reports min_amount_out as the clearing output; this
        // mirrors the live-shape chain-130 USDC->WETH route where
        // min_amount_out < amount_out by the slippage.
        let json = serde_json::json!({
            "tx": {"to": "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf", "data": "0x1234", "value": "0"},
            "amountOut": "63501880513303921",
            "minAmountOut": "62866861708170881",
            "gas": "350000"
        });
        let r: dto::RouteResponse = serde_json::from_value(json).unwrap();
        assert!(r.min_amount_out < r.amount_out);
        assert_eq!(r.min_amount_out, U256::from(62_866_861_708_170_881_u128));
        assert!(r.tx.value.is_zero());
    }

    #[test]
    fn nonzero_value_is_detected() {
        let json = serde_json::json!({
            "tx": {"to": "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf", "data": "0x", "value": "1000000000000000000"},
            "amountOut": "1", "minAmountOut": "1", "gas": "350000"
        });
        let r: dto::RouteResponse = serde_json::from_value(json).unwrap();
        assert!(!r.tx.value.is_zero());
    }
}
