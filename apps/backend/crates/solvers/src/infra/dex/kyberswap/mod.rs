//! Bindings to the KyberSwap aggregator API.
//!
//! KyberSwap's flow is two sequential HTTP calls:
//! 1. `GET  {base_url}routes`       — returns the best route and the router
//!    address (the ERC-20 spender for allowance purposes).
//! 2. `POST {base_url}route/build`  — turns that route into encoded calldata.
//!
//! There is no separate "approve transaction" endpoint and no HMAC signing —
//! authentication is optional and limited to a simple `x-client-id` header
//! used for rate limiting on KyberSwap's side.

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

/// Default `x-client-id` value sent when none is supplied via configuration.
/// KyberSwap rate-limits anonymous traffic aggressively, so we always send
/// something.
pub const DEFAULT_CLIENT_ID: &str = "ophis-solver";

/// Maximum value KyberSwap accepts for `slippageTolerance` (20%).
const MAX_SLIPPAGE_BPS: u16 = 2000;

/// Allowlist of KyberSwap router addresses that can be approved as ERC-20
/// spender for the Settlement contract.
///
/// **Why a fixed allowlist?** The `routerAddress` returned by `/routes` is
/// trusted as an unlimited-allowance grantee — a compromised KyberSwap edge
/// (DNS hijack, CA compromise, malicious Cloudflare worker, insider) that
/// returns an attacker-controlled router can drain Settlement's transient
/// balance during execution. The per-request /routes vs /route/build
/// equality check below catches only intra-request inconsistency, not a
/// fully poisoned response.
///
/// **Address coverage:** KyberSwap's `MetaAggregationRouterV2` is deployed
/// at the same CREATE2-deterministic address on every chain they support.
/// As of 2026-05-16 the canonical address is the single entry below.
/// Verified live on chain 999 (HyperEVM), chain 10 (OP), chain 1 (Mainnet),
/// chain 8453 (Base), chain 42161 (Arbitrum).
///
/// **If KyberSwap deploys a new router** (e.g. V3): add the new address here
/// after independent verification (their docs at
/// https://docs.kyberswap.com/Aggregator/aggregator-protocol-deployment/
/// contracts-and-addresses) — do NOT take it from a /routes response.
const KYBERSWAP_ROUTER_ALLOWLIST: &[Address] = &[
    Address::new([
        0x61, 0x31, 0xB5, 0xfa, 0xe1, 0x9E, 0xA4, 0xf9, 0xD9, 0x64, 0xeA, 0xc0, 0x40, 0x8E, 0x44,
        0x08, 0xb6, 0x63, 0x37, 0xb5,
    ]),
];

fn validate_router_allowlist(router: &Address) -> Result<(), Error> {
    if KYBERSWAP_ROUTER_ALLOWLIST.contains(router) {
        Ok(())
    } else {
        Err(Error::Api {
            code: -1,
            reason: format!(
                "KyberSwap returned non-allowlisted router address {router:?}. \
                Refusing to approve allowance. If this is a legitimate new \
                KyberSwap router, add it to KYBERSWAP_ROUTER_ALLOWLIST in \
                crates/solvers/src/infra/dex/kyberswap/mod.rs after \
                independent verification."
            ),
        })
    }
}

/// Bindings to the KyberSwap aggregator API.
pub struct KyberSwap {
    client: super::Client,
    base_url: reqwest::Url,
    settlement_contract: Address,
}

pub struct Config {
    /// Base URL for the KyberSwap aggregator API including the chain slug,
    /// e.g. `https://aggregator-api.kyberswap.com/optimism/api/v1/`.
    pub base_url: reqwest::Url,

    /// Chain ID — currently only used by callers to build `base_url`.
    pub chain_id: eth::ChainId,

    /// CoW settlement contract address — used as both `sender` and `recipient`
    /// when building the swap calldata.
    pub settlement_contract: Address,

    /// Optional `x-client-id` header. Defaults to [`DEFAULT_CLIENT_ID`].
    pub client_id: Option<String>,

    /// Block stream used to attach the current block hash header so an egress
    /// proxy can cache responses per block.
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl KyberSwap {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        let client = {
            let client_id = config
                .client_id
                .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());

            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                "x-client-id",
                reqwest::header::HeaderValue::from_str(&client_id)?,
            );

            // Cloudflare in front of aggregator-api.kyberswap.com blocks
            // requests with no User-Agent (returns 403 "Just a moment..."
            // bot-challenge HTML). reqwest's default builds with no UA, so
            // every call from this solver was 100% failing. Set an explicit
            // UA to pass the challenge.
            let client = reqwest::Client::builder()
                .user_agent("ophis-solver/1.0")
                .default_headers(headers)
                .build()?;
            super::Client::new(client, config.block_stream)
        };

        Ok(Self {
            client,
            base_url: config.base_url,
            settlement_contract: config.settlement_contract,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        // KyberSwap is exactIn-only.
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        // Tracing span — makes it easier to correlate request/response logs.
        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        async move {
            let routes = self.get_route(order).await?;
            let routes_router = routes.router_address;

            // Validate the /routes router address against the static allowlist
            // BEFORE making the /route/build call. Fail fast on a poisoned
            // edge so we don't bake an attacker-controlled spender into the
            // settlement calldata. See KYBERSWAP_ROUTER_ALLOWLIST docs.
            validate_router_allowlist(&routes_router)?;

            let (build, slippage_tolerance) = self
                .build_route(routes.route_summary, order, slippage)
                .await?;

            // Step 2 should return the same router address as step 1. Treat a
            // mismatch as a misbehaving API rather than silently using one.
            if build.router_address != routes_router {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "router address mismatch between /routes ({routes_router:?}) and \
                         /route/build ({:?})",
                        build.router_address
                    ),
                });
            }

            // Per codex review 2026-05-13 (HIGH): a compromised /route/build
            // response could return amount_in > order.sell.amount and trigger
            // a buffer-siphon attack if the Settlement contract holds spare
            // balance of the sold token. The CoW Settlement contract caps the
            // user-side transfer at order.sell.amount, but the router's
            // transferFrom(settlement, ...) targets the larger build.amount_in
            // and would pull from the settlement's own balance. Fail fast
            // rather than trust the API's amount_in.
            if build.amount_in != order.amount.get() {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "/route/build returned amount_in {:?}, expected {:?}",
                        build.amount_in,
                        order.amount.get()
                    ),
                });
            }

            // Parse the gas estimate (decimal string) and pad by 50% to be
            // conservative, mirroring the OKX / Bitget conventions.
            let gas_estimate: u64 = build
                .gas
                .trim()
                .parse::<u64>()
                .map_err(|_| Error::GasCalculationFailed)?;
            let gas_u256 = U256::from(gas_estimate);
            let gas = gas_u256
                .checked_add(gas_u256 / U256::from(2))
                .ok_or(Error::GasCalculationFailed)?;

            Ok(dex::Swap {
                calls: vec![dex::Call {
                    to: build.router_address,
                    calldata: build.data,
                }],
                input: eth::Asset {
                    token: order.sell,
                    amount: build.amount_in,
                },
                output: eth::Asset {
                    token: order.buy,
                    // Report the GUARANTEED slippage-floor output (== the
                    // router's on-chain minReturnAmount), NOT the optimistic
                    // quote `build.amount_out`. The CoW settlement pays the buy
                    // side at exactly this clearing amount; if it exceeded what
                    // the router actually realized, the buy-token transfer to
                    // the receiver reverts (insufficient balance, empty data),
                    // the solver's gas simulation fails, and the solution is
                    // dropped as NoSolutions. On a chain where KyberSwap is the
                    // only solver (Unichain has no on-chain AMM liquidity
                    // sources by design) that zeroes EVERY auction, so orders
                    // never settle. The router guarantees realized >=
                    // minReturn, so paying minReturn always succeeds; any
                    // positive slippage above it accrues to the Settlement
                    // buffer (standard CoW surplus handling). The order's
                    // signed buy-amount-min is enforced downstream, so a floor
                    // below the limit is correctly filtered as NoSolution.
                    // Settle: the router's guaranteed floor (#726) so the buy
                    // payout can never exceed realized output. Quote: the
                    // optimistic `amount_out`, matching 0x/ParaSwap. See
                    // `reported_output`.
                    amount: reported_output(build.amount_out, slippage_tolerance, is_quote),
                },
                allowance: dex::Allowance {
                    spender: routes_router,
                    amount: dex::Amount::new(build.amount_in),
                },
                gas: eth::Gas(gas),
            })
        }
        .instrument(tracing::trace_span!("swap", id = %id))
        .await
    }

    /// Step 1 — fetch the best route summary and router address.
    async fn get_route(&self, order: &dex::Order) -> Result<dto::RoutesData, Error> {
        let query = dto::RoutesRequest {
            token_in: order.sell.0,
            token_out: order.buy.0,
            amount_in: order.amount.get(),
            save_gas: false,
            gas_include: true,
        };

        let url = self
            .base_url
            .join("routes")
            .map_err(|_| Error::RequestBuildFailed)?;
        let request = self.client.request(reqwest::Method::GET, url).query(&query);

        let response: dto::RoutesApiResponse =
            util::http::roundtrip!(<dto::RoutesApiResponse, dto::ApiError>; request).await?;

        Self::handle_api_error(response.code, &response.message)?;
        response.data.ok_or(Error::NotFound)
    }

    /// Step 2 — build the calldata for the route returned in step 1.
    ///
    /// Returns the build data together with the `slippage_tolerance` (bps) that
    /// was sent to KyberSwap, so the caller can reconstruct the router's
    /// on-chain `minReturnAmount` and report it as the guaranteed buy output.
    async fn build_route(
        &self,
        route_summary: dto::RouteSummary,
        _order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<(dto::BuildData, u16), Error> {
        let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let slippage_tolerance = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::KyberSwap,
            slippage_bps,
            MAX_SLIPPAGE_BPS,
        );

        let body = dto::BuildRequest {
            route_summary,
            sender: self.settlement_contract,
            recipient: self.settlement_contract,
            slippage_tolerance,
            deadline: None,
            enable_gas_estimation: false,
        };

        let url = self
            .base_url
            .join("route/build")
            .map_err(|_| Error::RequestBuildFailed)?;

        let request = self
            .client
            .request(reqwest::Method::POST, url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body);

        let response: dto::BuildApiResponse =
            util::http::roundtrip!(<dto::BuildApiResponse, dto::ApiError>; request).await?;

        Self::handle_api_error(response.code, &response.message)?;
        response
            .data
            .ok_or(Error::BuildFailed)
            .map(|data| (data, slippage_tolerance))
    }

    /// Map KyberSwap error codes to the [`Error`] taxonomy.
    ///
    /// KyberSwap returns `0` on success and a 4xxx code on failure.
    /// Reference: <https://docs.kyberswap.com/Aggregator/aggregator-api>
    fn handle_api_error(code: i64, message: &str) -> Result<(), Error> {
        if code == 0 {
            return Ok(());
        }

        Err(match code {
            // No route / no eligible pools / route expired.
            4008 // Route not found
            | 4009 // Pool not found
            | 4010 // No eligible pools
            | 4011 // Token not found / unsupported
            | 4221 // No route after filtering
            => Error::NotFound,
            // Rate-limit codes (KyberSwap uses HTTP 429 too, handled below).
            4429 | 429 => Error::RateLimited,
            _ => Error::Api {
                code,
                reason: message.to_string(),
            },
        })
    }
}

/// The router's guaranteed minimum output for a quoted `amount_out` and the
/// `slippage_tolerance` (bps) sent to KyberSwap's `/route/build`.
///
/// KyberSwap bakes `minReturnAmount = amount_out * (10000 - slippage) / 10000`
/// (floor) into the swap calldata and reverts on-chain if the realized output
/// is below it. Reporting exactly this value as the CoW buy clearing amount
/// means the settlement's buy-side payout can never exceed what the router
/// actually delivered, so neither the on-chain buy transfer nor the solver's
/// gas simulation can revert. Positive slippage above the floor accrues to the
/// Settlement buffer (standard CoW surplus handling).
fn min_return_amount(amount_out: U256, slippage_tolerance_bps: u16) -> U256 {
    let bps = U256::from(10_000u64);
    let keep = bps.saturating_sub(U256::from(slippage_tolerance_bps));
    // Real token amounts are far below U256::MAX/10000 so the multiply cannot
    // overflow; if it ever did, fall back to the (more conservative)
    // divide-first form rather than returning the un-discounted optimistic
    // amount (which is the bug this guards against).
    match amount_out.checked_mul(keep) {
        Some(scaled) => scaled / bps,
        None => amount_out / bps * keep,
    }
}

/// The buy-side amount to REPORT for a SELL order.
///
/// * settle (`is_quote == false`): the router's guaranteed slippage floor
///   (`min_return_amount`) — the #726 invariant; do NOT weaken this.
/// * quote  (`is_quote == true`): the optimistic `amount_out`, closing the
///   ~1% competitiveness gap. Quotes never settle, so no revert risk.
fn reported_output(optimistic_out: U256, slippage_tolerance_bps: u16, is_quote: bool) -> U256 {
    if is_quote {
        optimistic_out
    } else {
        min_return_amount(optimistic_out, slippage_tolerance_bps)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
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
    #[error("/route/build returned no payload")]
    BuildFailed,
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
            util::http::RoundtripError::Api(err) => match err.code {
                429 | 4429 => Self::RateLimited,
                _ => Self::Api {
                    code: err.code,
                    reason: err.message,
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the live-traced Unichain native-buy revert: the bug reported the
    // optimistic quote (build.amount_out) as the buy clearing amount, which
    // exceeded the router's realized output and reverted the settlement payout.
    #[test]
    fn min_return_amount_is_router_slippage_floor() {
        let amount_out = U256::from(988_146_014_276_470u128);
        // 100 bps (1%) slippage -> floor = amount_out * 9900 / 10000.
        let floor = min_return_amount(amount_out, 100);
        assert_eq!(
            floor,
            amount_out * U256::from(9_900u64) / U256::from(10_000u64)
        );
        // Strictly below the optimistic quote (the value that used to revert)...
        assert!(floor < amount_out);
        // ...and at/above this order's signed buy-amount-min, so the user's
        // limit price still holds (floor 978264554133705 >= 973318255275485).
        assert!(floor >= U256::from(973_318_255_275_485u128));
    }

    #[test]
    fn min_return_amount_zero_slippage_is_identity() {
        let a = U256::from(1_000_000_000u64);
        assert_eq!(min_return_amount(a, 0), a);
    }

    #[test]
    fn min_return_amount_full_slippage_is_zero() {
        let a = U256::from(1_000_000_000u64);
        assert_eq!(min_return_amount(a, 10_000), U256::ZERO);
    }

    #[test]
    fn reported_output_quote_is_optimistic() {
        let optimistic = U256::from(988_146_014_276_470u128);
        assert_eq!(reported_output(optimistic, 100, true), optimistic);
        assert_eq!(reported_output(optimistic, 2000, true), optimistic);
    }

    #[test]
    fn reported_output_solve_is_floor() {
        let optimistic = U256::from(988_146_014_276_470u128);
        assert_eq!(
            reported_output(optimistic, 100, false),
            min_return_amount(optimistic, 100)
        );
        assert!(reported_output(optimistic, 100, false) < optimistic);
    }
}
