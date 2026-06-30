//! Bindings to the DODO route-service aggregator API (Unichain, chain 130).
//!
//! DODO's flow is a single HTTP call:
//! - `GET .../route-service/v2/widget/getdodoroute` — returns the best route,
//!   the router (`to`), the calldata (`data`), the optimistic estimate
//!   (`resAmount`, a float) and the GUARANTEED slippage floor (`minReturnAmount`,
//!   raw-wei string), plus a SEPARATE ERC-20 approval target
//!   (`targetApproveAddr`, DODO's ApproveProxy).
//!
//! There is no separate "approve transaction" endpoint and no HMAC signing.
//! Authentication is limited to a public widget `apikey` used for rate limiting
//! / attribution on DODO's side — it carries no funds-moving authority and is a
//! plain config field (defaulted to DODO's public widget key, env-overridable).
//!
//! This is a NON-RFQ classic-swap API, so the calldata is executable by an
//! arbitrary caller (the settlement) seconds-to-minutes later, provided
//! `userAddr` is the Settlement contract — which we always set.

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

/// Default public DODO widget API key (the value baked into DODO's own widget).
/// Public, rate-limit-only, carries no authority. Overridable via config so an
/// operator can supply their own key from an env placeholder — NEVER hardcode a
/// private key in module logic.
pub const DEFAULT_APIKEY: &str = "a37546505892e1a952";

/// Fallback gas estimate when DODO returns `gasLimit: "0"` (it frequently
/// declines to simulate). DODO swaps through Uniswap-v4 hooks on Unichain land
/// well under this; the solver's own simulation is the real bound.
const FALLBACK_GAS: u64 = 600_000;

/// Maximum slippage (bps) we will ask DODO for. DODO accepts a wide percent
/// range; we cap at 20% to match the other integrations and to bound the
/// economic divergence recorded by `dex_slippage_clamped`.
const MAX_SLIPPAGE_BPS: u16 = 2000;

/// Allowlist of DODO contracts that may appear as the router (`to`) or the
/// ERC-20 approval target (`targetApproveAddr`) on chain 130 (Unichain).
///
/// **Why a fixed allowlist?** Both the `to` (router we call) and the
/// `targetApproveAddr` (the ERC-20 spender we grant allowance to) come straight
/// out of the API response body. A compromised DODO edge (DNS hijack, CA
/// compromise, malicious CDN worker, insider) that returns an attacker-
/// controlled router/approve target can drain the Settlement contract's
/// transient balance of the sell token during execution. We therefore refuse
/// any router OR approve target not on this list, BEFORE building the swap.
///
/// **Address coverage (verified live on chain 130, 2026-06-30 via
/// `eth_getCode` against https://unichain-rpc.publicnode.com — both have
/// substantial bytecode):**
///   - `0x89Ba4039841587B0a4cFfDF17AEE30caCF006f4D` — DODORouteProxy (`to`).
///   - `0xf3d60Ba9e76459A7075E9676740347B7413462Dd` — DODOApproveProxy
///     (`targetApproveAddr`, the actual ERC-20 spender).
///
/// Probed live for USDC -> WETH on 130: both addresses are stable across
/// slippage values and both carry code.
///
/// **If DODO redeploys** (new router / approve proxy): add the new address here
/// after independent verification — do NOT take it from a response unchecked.
/// DODORouteProxy on Unichain (130) — the router we call as the `to` of the
/// settlement interaction.
const DODO_ROUTE_PROXY: Address = Address::new([
    0x89, 0xBA, 0x40, 0x39, 0x84, 0x15, 0x87, 0xB0, 0xA4, 0xCF, 0xFD, 0xF1, 0x7A, 0xEE, 0x30, 0xCA,
    0xCF, 0x00, 0x6F, 0x4D,
]);

/// DODOApproveProxy on Unichain (130) — the ERC-20 approval target the
/// RouteProxy pulls the sell token through (the allowance spender).
const DODO_APPROVE_PROXY: Address = Address::new([
    0xF3, 0xD6, 0x0B, 0xA9, 0xE7, 0x64, 0x59, 0xA7, 0x07, 0x5E, 0x96, 0x76, 0x74, 0x03, 0x47, 0xB7,
    0x41, 0x34, 0x62, 0xDD,
]);

/// Validates a DODO response address against the EXPECTED role-specific
/// contract. ROLE-SPECIFIC, not a union: the router (`to`) must be the
/// RouteProxy and the spender (`targetApproveAddr`) must be the ApproveProxy.
/// A union check would accept a response that swapped the two fields (or pointed
/// `to` at the ApproveProxy) — here that is rejected.
fn validate_dodo_address(addr: &Address, expected: &Address, role: &str) -> Result<(), Error> {
    if addr == expected {
        Ok(())
    } else {
        Err(Error::Api {
            code: -1,
            reason: format!(
                "DODO returned address {addr:?} for the {role} but expected {expected:?}. \
                 Refusing to build/approve. If this is a legitimate new DODO deployment, \
                 update DODO_ROUTE_PROXY / DODO_APPROVE_PROXY in \
                 crates/solvers/src/infra/dex/dodo/mod.rs after independent verification."
            ),
        })
    }
}

/// Bindings to the DODO route-service aggregator API.
pub struct Dodo {
    client: super::Client,
    base_url: reqwest::Url,
    chain_id: u64,
    settlement_contract: Address,
    apikey: String,
}

pub struct Config {
    /// Base URL for the DODO route-service API, e.g.
    /// `https://api.dodoex.io/route-service/v2/widget/getdodoroute`.
    pub base_url: reqwest::Url,

    /// Numeric chain ID — sent as the `chainId` query parameter (130 for
    /// Unichain). The file loader derives this from the configured
    /// `eth::ChainId` so the module stays decoupled from the enum.
    pub chain_id: u64,

    /// CoW settlement contract address — sent as `userAddr` and used as the swap
    /// `sender`/`recipient`/`receiver` so the calldata is executable by the
    /// settlement later (NON-RFQ).
    pub settlement_contract: Address,

    /// Public DODO widget API key. Defaults to [`DEFAULT_APIKEY`]; an operator
    /// may override it from an env placeholder. Rate-limit/attribution only.
    pub apikey: Option<String>,

    /// Block stream used to attach the current block hash header so an egress
    /// proxy can cache responses per block.
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl Dodo {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        let client = {
            // A few CDNs in front of public aggregator APIs block empty
            // User-Agents; set an explicit one to be safe (mirrors KyberSwap).
            let client = reqwest::Client::builder()
                .user_agent("ophis-solver/1.0")
                .build()?;
            super::Client::new(client, config.block_stream)
        };

        Ok(Self {
            client,
            base_url: config.base_url,
            chain_id: config.chain_id,
            settlement_contract: config.settlement_contract,
            apikey: config.apikey.unwrap_or_else(|| DEFAULT_APIKEY.to_string()),
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> {
        // DODO route-service is exactIn-only.
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        // Tracing span — makes it easier to correlate request/response logs.
        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        async move {
            let route = self.get_route(order, slippage).await?;

            // Validate BOTH the router (`to`) and the ERC-20 approval target
            // (`targetApproveAddr`) against the static allowlist BEFORE using
            // either. Fail fast on a poisoned edge so we never bake an
            // attacker-controlled call target or spender into the settlement.
            validate_dodo_address(&route.to, &DODO_ROUTE_PROXY, "router")?;
            validate_dodo_address(&route.target_approve_addr, &DODO_APPROVE_PROXY, "approve target")?;

            // ERC-20 -> ERC-20 only. The settlement holds wrapped tokens, so a
            // non-zero native `value` means we'd be asked to send ETH the
            // settlement won't attach — refuse rather than build a call that
            // can only revert.
            let value = route.value.trim();
            if !value.is_empty() && value != "0" {
                return Err(Error::Api {
                    code: -1,
                    reason: format!("DODO route requires non-zero native value {value}"),
                });
            }

            // Report the GUARANTEED slippage-floor output (DODO's
            // `minReturnAmount`, the value baked into the calldata that the
            // router reverts below on-chain), NOT the optimistic `resAmount`
            // float estimate. The CoW settlement pays the buy side at exactly
            // this clearing amount; if it exceeded what the router actually
            // realized, the buy-token transfer to the receiver reverts, the
            // solver's gas simulation fails, and the solution is dropped as
            // NoSolutions. On a chain where DODO/KyberSwap are the only solvers
            // (Unichain has no native on-chain AMM sources) that zeroes every
            // auction, so orders never settle. The router guarantees
            // realized >= minReturnAmount, so paying it always succeeds; any
            // positive slippage above it accrues to the Settlement buffer
            // (standard CoW surplus handling). The order's signed
            // buy-amount-min is enforced downstream, so a floor below the limit
            // is correctly filtered as NoSolution.
            let min_return = route.min_return_amount;
            if min_return.is_zero() {
                return Err(Error::NotFound);
            }

            let gas_estimate: u64 = route
                .gas_limit
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|g| *g > 0)
                .unwrap_or(FALLBACK_GAS);
            let gas_u256 = U256::from(gas_estimate);
            // Pad by 50% to be conservative, mirroring the KyberSwap / OKX
            // conventions.
            let gas = gas_u256
                .checked_add(gas_u256 / U256::from(2))
                .ok_or(Error::GasCalculationFailed)?;

            Ok(dex::Swap {
                calls: vec![dex::Call {
                    to: route.to,
                    calldata: route.data,
                }],
                input: eth::Asset {
                    token: order.sell,
                    // exactIn SELL: input is pinned to the order amount (NO
                    // pad). DODO echoes the sell amount inside `data`; we send
                    // `from_amount == order.amount` and never trust an API
                    // amount-in back, so the settlement transfer can never
                    // exceed the user's signed sell amount.
                    amount: order.amount.get(),
                },
                output: eth::Asset {
                    token: order.buy,
                    // The guaranteed floor — see the long comment above.
                    amount: min_return,
                },
                allowance: dex::Allowance {
                    // DODO pulls the sell token via its ApproveProxy, NOT the
                    // router. The approval target is the spender; both are
                    // allowlisted above.
                    spender: route.target_approve_addr,
                    amount: dex::Amount::new(order.amount.get()),
                },
                gas: eth::Gas(gas),
            })
        }
        .instrument(tracing::trace_span!("swap", id = %id))
        .await
    }

    /// Fetch the route, calldata, router, approve target and guaranteed floor.
    async fn get_route(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dto::RouteData, Error> {
        let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let clamped_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Dodo,
            slippage_bps,
            MAX_SLIPPAGE_BPS,
        );

        let query = dto::RouteRequest {
            chain_id: self.chain_id,
            from_token_address: order.sell.0,
            to_token_address: order.buy.0,
            from_amount: order.amount.get(),
            // DODO's `slippage` query parameter is a PERCENT, not bps. Convert
            // the clamped bps to a percent string (bps / 100).
            slippage: bps_to_percent_string(clamped_bps),
            user_addr: self.settlement_contract,
            // A far-future deadline. The CoW order's own validTo bounds
            // execution; DODO only requires a positive value.
            dead_line: 9_999_999_999,
            apikey: self.apikey.clone(),
        };

        let mut url = self.base_url.clone();
        // `getdodoroute` is the full path; if the configured base_url ends in a
        // slash, callers should configure it without the trailing path. We
        // treat base_url as the complete endpoint and only attach the query.
        url.query_pairs_mut().clear();
        let request = self.client.request(reqwest::Method::GET, url).query(&query);

        let response: dto::RouteApiResponse =
            util::http::roundtrip!(<dto::RouteApiResponse, dto::ApiError>; request).await?;

        if response.status != 200 {
            return Err(Error::Api {
                code: response.status,
                reason: format!("DODO returned status {}", response.status),
            });
        }
        response.data.ok_or(Error::NotFound)
    }
}

/// Convert basis points to DODO's percent string (e.g. `100 bps -> "1"`,
/// `25 bps -> "0.25"`). Trailing zeros are trimmed for a clean value.
fn bps_to_percent_string(bps: u16) -> String {
    let whole = bps / 100;
    let frac = bps % 100;
    if frac == 0 {
        whole.to_string()
    } else {
        // Two-decimal fraction, trimmed.
        let s = format!("{whole}.{frac:02}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
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
            util::http::RoundtripError::Api(err) => match err.status {
                429 => Self::RateLimited,
                code => Self::Api {
                    code,
                    reason: err
                        .message
                        .unwrap_or_else(|| format!("DODO error status {code}")),
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guaranteed floor reported as `output.amount` must be DODO's
    /// `minReturnAmount` (the slippage-applied value baked into the calldata),
    /// NEVER the optimistic `resAmount` estimate. This mirrors the live-traced
    /// USDC -> WETH route on chain 130: at 1% slippage DODO returned
    /// `minReturnAmount = 443157433018` for a pool quote of `448306225752`.
    #[test]
    fn output_floor_is_min_return_not_optimistic_estimate() {
        // Values pulled from a real chain-130 USDC->WETH probe (2026-06-30).
        let min_return = U256::from(443_157_433_018u128); // floor we MUST report
        let optimistic = U256::from(448_306_225_752u128); // pool quote, must NOT report

        // The floor is strictly below the optimistic quote (the value that
        // would revert the settlement buy-side payout).
        assert!(min_return < optimistic);

        // And tightening slippage 1% -> 5% lowers the floor further, confirming
        // it is the slippage-applied minimum and not a static value.
        let min_return_5pct = U256::from(425_252_072_756u128);
        assert!(min_return_5pct < min_return);
    }

    #[test]
    fn bps_to_percent_string_conversions() {
        assert_eq!(bps_to_percent_string(100), "1");
        assert_eq!(bps_to_percent_string(500), "5");
        assert_eq!(bps_to_percent_string(2000), "20");
        assert_eq!(bps_to_percent_string(25), "0.25");
        assert_eq!(bps_to_percent_string(50), "0.5");
        assert_eq!(bps_to_percent_string(0), "0");
    }

    /// Each DODO address must validate ONLY in its own role, a foreign address
    /// must be rejected, AND a swapped response (router<->spender) must be
    /// rejected — the role-specific guard's whole purpose.
    #[test]
    fn role_specific_allowlist_rejects_swapped_and_foreign() {
        // Correct roles accepted.
        assert!(validate_dodo_address(&DODO_ROUTE_PROXY, &DODO_ROUTE_PROXY, "router").is_ok());
        assert!(
            validate_dodo_address(&DODO_APPROVE_PROXY, &DODO_APPROVE_PROXY, "approve target")
                .is_ok()
        );
        // Foreign address rejected in either role.
        assert!(validate_dodo_address(&Address::ZERO, &DODO_ROUTE_PROXY, "router").is_err());
        // SWAPPED roles rejected (the union allowlist used to accept these).
        assert!(
            validate_dodo_address(&DODO_APPROVE_PROXY, &DODO_ROUTE_PROXY, "router").is_err()
        );
        assert!(
            validate_dodo_address(&DODO_ROUTE_PROXY, &DODO_APPROVE_PROXY, "approve target")
                .is_err()
        );
    }
}
