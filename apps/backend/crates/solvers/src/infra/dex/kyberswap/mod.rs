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

            let client = reqwest::Client::builder()
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

            let build = self
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
                    amount: build.amount_out,
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
    async fn build_route(
        &self,
        route_summary: dto::RouteSummary,
        _order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dto::BuildData, Error> {
        let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let slippage_tolerance = if slippage_bps > MAX_SLIPPAGE_BPS {
            tracing::warn!(
                requested = slippage_bps,
                clamp = MAX_SLIPPAGE_BPS,
                "slippage exceeds KyberSwap maximum, clamping",
            );
            MAX_SLIPPAGE_BPS
        } else {
            slippage_bps
        };

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
        response.data.ok_or(Error::BuildFailed)
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
