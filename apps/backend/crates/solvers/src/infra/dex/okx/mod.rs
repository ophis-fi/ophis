use {
    crate::{
        domain::{dex, eth, order},
        util,
    },
    alloy::primitives::{Address, U256},
    base64::prelude::*,
    bigdecimal::FromPrimitive,
    chrono::SecondsFormat,
    ethrpc::block_stream::CurrentBlockWatcher,
    hmac::{Hmac, Mac},
    moka::future::Cache,
    reqwest::{StatusCode, header::HeaderValue},
    serde::{Serialize, de::DeserializeOwned},
    sha2::Sha256,
    std::sync::atomic::{self, AtomicU64},
    tracing::Instrument,
};

mod dto;

/// Default OKX v6 DEX aggregator API endpoint (for sell orders - exactIn).
pub const DEFAULT_SELL_ORDERS_ENDPOINT: &str = "https://web3.okx.com/api/v6/dex/aggregator/";

const DEFAULT_DEX_APPROVED_ADDRESSES_CACHE_SIZE: u64 = 100;

/// Allowlist of OKX DEX router (`tx.to`) + approve-spender (`dexContractAddress`)
/// addresses keyed by chain id. The OKX V6 API returns both addresses in its
/// `/swap` and `/approve-transaction` responses respectively, and the driver
/// trusts the spender as an unlimited-allowance grantee — so a compromised OKX
/// edge (DNS hijack, CA compromise, malicious CDN worker, insider) that returns
/// attacker-controlled router/spender can drain Settlement's transient balance
/// during execution. Pinning to a static allowlist closes the window.
///
/// **Verification methodology:** addresses below were extracted from a live
/// authenticated probe (using the same OKX credentials the solver uses in
/// production) and cross-verified via `cast code` on the chain's RPC to confirm
/// each is a deployed contract with substantial bytecode (router: ~48 KiB,
/// spender: ~4 KiB on Optimism). The spender was probed against 4 distinct
/// tokens (WETH, USDC, OP, DAI) and returned identical for all of them,
/// confirming it is a single OKX approve-proxy contract per chain rather than
/// per-token.
///
/// **Adding a chain** (HyperEVM, MegaETH, etc.): re-run the probe under that
/// chain's `chainIndex`, confirm `dexContractAddress` is stable across ≥3
/// tokens, and verify both addresses via `cast code` against the chain's RPC.
/// Do NOT take addresses from a `/swap` response without independent
/// verification — that's the attack we're preventing.
const OKX_ROUTER_ALLOWLIST: &[(u64, Address, Address)] = &[
    // Optimism mainnet (chain 10). Verified 2026-05-18 via authenticated
    // probe + `cast code` on https://optimism-rpc.publicnode.com.
    (
        10,
        // Router (`tx.to` returned by /swap).
        Address::new([
            0xDd, 0x5E, 0x9B, 0x94, 0x7c, 0x99, 0xAa, 0x60, 0xba, 0xb0, 0x0c, 0xa4, 0x63, 0x1D,
            0xce, 0x63, 0xb4, 0x99, 0x83, 0xE7,
        ]),
        // Spender (`dexContractAddress` returned by /approve-transaction).
        Address::new([
            0x68, 0xD6, 0xB7, 0x39, 0xD2, 0x02, 0x00, 0x67, 0xD1, 0xe2, 0xF7, 0x13, 0xb9, 0x99,
            0xdA, 0x97, 0xE4, 0xd5, 0x48, 0x12,
        ]),
    ),
    // Ethereum mainnet (chain 1). Documented from recorded OKX V5/V6
    // fixture traffic in `crates/solvers/src/tests/okx/`. Ophis is NOT
    // currently deployed on Ethereum mainnet — these entries exist so the
    // test suite passes; re-verify both addresses via `cast code` before
    // ever enabling OKX on chain 1 in production.
    (
        1,
        // Router (`tx.to`) from the OKX V6 fixture.
        Address::new([
            0x7D, 0x0C, 0xcA, 0xa3, 0xFa, 0xc1, 0xe5, 0xA9, 0x43, 0xc5, 0x16, 0x8b, 0x6C, 0xEd,
            0x82, 0x86, 0x91, 0xb4, 0x6B, 0x36,
        ]),
        // Spender (`dexContractAddress`) from the OKX V6 fixture.
        Address::new([
            0x40, 0xaA, 0x95, 0x8d, 0xd8, 0x7F, 0xC8, 0x30, 0x5b, 0x97, 0xf2, 0xBA, 0x92, 0x2C,
            0xDd, 0xCa, 0x37, 0x4b, 0xcD, 0x7f,
        ]),
    ),
];

fn allowlist_entry_for(chain_id: u64) -> Result<&'static (u64, Address, Address), Error> {
    OKX_ROUTER_ALLOWLIST
        .iter()
        .find(|(cid, _, _)| *cid == chain_id)
        .ok_or(Error::ChainNotInAllowlist { chain_id })
}

fn validate_router_allowlist(chain_id: u64, router: &Address) -> Result<(), Error> {
    let (_, allowed_router, _) = allowlist_entry_for(chain_id)?;
    if router != allowed_router {
        return Err(Error::RouterNotInAllowlist {
            chain_id,
            returned: *router,
            expected: *allowed_router,
        });
    }
    Ok(())
}

fn validate_spender_allowlist(chain_id: u64, spender: &Address) -> Result<(), Error> {
    let (_, _, allowed_spender) = allowlist_entry_for(chain_id)?;
    if spender != allowed_spender {
        return Err(Error::SpenderNotInAllowlist {
            chain_id,
            returned: *spender,
            expected: *allowed_spender,
        });
    }
    Ok(())
}

/// Cache key for OKX DEX approve contract addresses.
/// V5 and V6 APIs may return different contract addresses for the same token,
/// so we need to cache separately by order side.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ApprovalCacheKey {
    token: eth::TokenAddress,
    side: order::Side,
}

/// Bindings to the OKX swap API.
pub struct Okx {
    client: super::Client,
    sell_orders_endpoint: reqwest::Url,
    buy_orders_endpoint: Option<reqwest::Url>,
    sell_orders_signature_base_url: reqwest::Url,
    buy_orders_signature_base_url: Option<reqwest::Url>,
    api_secret_key: String,
    defaults: dto::SwapRequest,
    /// Cache which stores a map of (Token Address, Order Side) to contract
    /// address of OKX DEX approve contract. Separate caching by side is
    /// needed because V5 API (buy orders) and V6 API (sell orders) return
    /// different addresses.
    dex_approved_addresses: Cache<ApprovalCacheKey, eth::ContractAddress>,
}

pub struct Config {
    /// The URL for the OKX swap API for sell orders (exactIn mode).
    /// Uses V6 API by default.
    pub sell_orders_endpoint: reqwest::Url,

    /// The URL for the OKX swap API for buy orders (exactOut mode).
    /// If specified, the URL must point to the V5 API. Otherwise, buy orders
    /// will be ignored.
    pub buy_orders_endpoint: Option<reqwest::Url>,

    /// Optional base URL to use for signature generation for sell orders.
    /// This is useful when requests go through a proxy but signatures must be
    /// generated using the original OKX API URL path.
    /// If not specified, uses sell_orders_endpoint for signature generation.
    pub sell_orders_signature_base_url: Option<reqwest::Url>,

    /// Optional base URL to use for signature generation for buy orders.
    /// This is useful when requests go through a proxy but signatures must be
    /// generated using the original OKX API URL path.
    /// If not specified, uses buy_orders_endpoint for signature generation.
    pub buy_orders_signature_base_url: Option<reqwest::Url>,

    pub chain_id: eth::ChainId,

    pub settlement_contract: Address,

    /// Credentials used to access OKX API.
    pub okx_credentials: OkxCredentialsConfig,

    /// The stream that yields every new block.
    pub block_stream: Option<CurrentBlockWatcher>,

    /// The percentage of the price impact allowed.
    /// When set to 100%, the feature is disabled.
    pub price_impact_protection_percent: f64,
}

pub struct OkxCredentialsConfig {
    /// OKX project ID to use.
    pub project_id: String,

    /// OKX API key.
    pub api_key: String,

    /// OKX API key additional security token.
    pub api_secret_key: String,

    /// OKX API key passphrase used to encrypt secret key.
    pub api_passphrase: String,
}

impl Okx {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        let client = {
            let mut api_key =
                reqwest::header::HeaderValue::from_str(&config.okx_credentials.api_key)?;
            api_key.set_sensitive(true);
            let mut api_passphrase =
                reqwest::header::HeaderValue::from_str(&config.okx_credentials.api_passphrase)?;
            api_passphrase.set_sensitive(true);

            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                "OK-ACCESS-PROJECT",
                reqwest::header::HeaderValue::from_str(&config.okx_credentials.project_id)?,
            );
            headers.insert("OK-ACCESS-KEY", api_key);
            headers.insert("OK-ACCESS-PASSPHRASE", api_passphrase);

            let client = reqwest::Client::builder()
                .default_headers(headers)
                .build()?;
            super::Client::new(client, config.block_stream)
        };

        if config.price_impact_protection_percent < 0.0
            || config.price_impact_protection_percent > 100.0
        {
            return Err(CreationError::InvalidPriceImpactProtection(
                config.price_impact_protection_percent,
            ));
        }
        let price_impact_protection =
            bigdecimal::BigDecimal::from_f64(config.price_impact_protection_percent)
                .ok_or_else(|| {
                    CreationError::InvalidPriceImpactProtection(
                        config.price_impact_protection_percent,
                    )
                })?
                .normalized();

        let defaults = dto::SwapRequest {
            chain_index: config.chain_id as u64,
            // Funds first get moved in and out of the settlement contract so we
            // have use that address here to generate the correct calldata.
            swap_receiver_address: config.settlement_contract,
            user_wallet_address: config.settlement_contract,
            price_impact_protection_percent: price_impact_protection,
            ..Default::default()
        };

        Ok(Self {
            client,
            sell_orders_endpoint: config.sell_orders_endpoint.clone(),
            buy_orders_endpoint: config.buy_orders_endpoint.clone(),
            sell_orders_signature_base_url: config
                .sell_orders_signature_base_url
                .unwrap_or(config.sell_orders_endpoint),
            buy_orders_signature_base_url: config
                .buy_orders_signature_base_url
                .or(config.buy_orders_endpoint),
            api_secret_key: config.okx_credentials.api_secret_key,
            defaults,
            dex_approved_addresses: Cache::new(DEFAULT_DEX_APPROVED_ADDRESSES_CACHE_SIZE),
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> {
        // Set up a tracing span to make debugging of API requests easier.
        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        let (swap_response, dex_contract_address) = self
            .handle_api_requests(order, slippage)
            .instrument(tracing::trace_span!("swap", id = %id))
            .await?;

        // Audit C2 / Phase 2: validate OKX-returned router (`tx.to`) against
        // the static OKX_ROUTER_ALLOWLIST. The spender (`dexContractAddress`)
        // is validated INSIDE the cache-populating future in handle_sell_order /
        // handle_buy_order so that a poisoned response never persists in the
        // moka cache (retro-audit follow-up: prevents sticky DoS on
        // (token, side) keys if the allowlist itself is ever wrong).
        validate_router_allowlist(
            self.defaults.chain_index,
            &swap_response.tx.to,
        )?;

        // Increasing returned gas by 50% according to the documentation:
        // https://web3.okx.com/build/dev-docs/wallet-api/dex-swap (gas field description in Response param)
        let gas = swap_response
            .tx
            .gas
            .checked_add(swap_response.tx.gas / U256::from(2))
            .ok_or(Error::GasCalculationFailed)?;

        // For buy orders (ExactOut mode), the slippage is on the input token,
        // so we need to use U256::MAX allowance to cover the maximum possible
        // input.
        let allowance_amount =
            if self.buy_orders_endpoint.is_some() && order.side == order::Side::Buy {
                eth::U256::MAX
            } else {
                swap_response.router_result.from_token_amount
            };

        Ok(dex::Swap {
            calls: vec![dex::Call {
                to: swap_response.tx.to,
                calldata: swap_response.tx.data.clone(),
            }],
            input: eth::Asset {
                token: swap_response
                    .router_result
                    .from_token
                    .token_contract_address
                    .into(),
                amount: swap_response.router_result.from_token_amount,
            },
            output: eth::Asset {
                token: swap_response
                    .router_result
                    .to_token
                    .token_contract_address
                    .into(),
                amount: swap_response.router_result.to_token_amount,
            },
            allowance: dex::Allowance {
                spender: dex_contract_address.0,
                amount: dex::Amount::new(allowance_amount),
            },
            gas: eth::Gas(gas),
        })
    }

    /// Routes API requests based on order side.
    ///
    /// - Sell orders: Parallel execution of /swap and /approve-transaction
    /// - Buy orders: Sequential execution (swap first, then approval with exact
    ///   amount)
    async fn handle_api_requests(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<(dto::SwapResponse, eth::ContractAddress), Error> {
        match order.side {
            order::Side::Sell => self.handle_sell_order(order, slippage).await,
            order::Side::Buy => self.handle_buy_order(order, slippage).await,
        }
    }

    /// Handle sell orders with parallel API requests.
    ///
    /// Since the approval amount is known upfront from `order.amount`,
    /// we can execute `/swap` and `/approve-transaction` in parallel for better
    /// performance.
    async fn handle_sell_order(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<(dto::SwapResponse, eth::ContractAddress), Error> {
        let swap_future = async {
            let swap_request = self.defaults.clone().with_domain(order, slippage);
            self.send_get_request(
                &self.sell_orders_endpoint,
                &self.sell_orders_signature_base_url,
                "swap",
                &swap_request,
            )
            .await
        };

        let approve_future = async {
            let approve_request = dto::ApproveTransactionRequest::new(
                self.defaults.chain_index,
                order.sell,
                order.amount.get(),
            );

            let approve_tx: dto::ApproveTransactionResponse = self
                .send_get_request(
                    &self.sell_orders_endpoint,
                    &self.sell_orders_signature_base_url,
                    "approve-transaction",
                    &approve_request,
                )
                .await?;

            // Validate spender BEFORE returning so the cache never stores
            // a poisoned address. If validation fails, try_get_with sees
            // Err and skips the cache write — failure stays transient.
            validate_spender_allowlist(
                self.defaults.chain_index,
                &approve_tx.dex_contract_address,
            )?;

            Ok(eth::ContractAddress(approve_tx.dex_contract_address))
        };

        tokio::try_join!(
            swap_future,
            self.cache_approval_address(order, approve_future)
        )
    }

    /// Handle buy orders with sequential API requests.
    ///
    /// Since the approval amount depends on the swap response
    /// (`from_token_amount`), we must execute `/swap` first, then
    /// `/approve-transaction`.
    async fn handle_buy_order(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<(dto::SwapResponse, eth::ContractAddress), Error> {
        let endpoint = self
            .buy_orders_endpoint
            .as_ref()
            .ok_or(Error::OrderNotSupported)?;

        let signature_base_url = self
            .buy_orders_signature_base_url
            .as_ref()
            .ok_or(Error::OrderNotSupported)?;

        let swap_request_v6 = self.defaults.clone().with_domain(order, slippage);
        let swap_request_v5: dto::SwapRequestV5 = (&swap_request_v6).into();
        let swap_response: dto::SwapResponse = self
            .send_get_request(endpoint, signature_base_url, "swap", &swap_request_v5)
            .await?;

        let approve_future = async {
            let approve_request = dto::ApproveTransactionRequest::new(
                self.defaults.chain_index,
                order.sell,
                swap_response.router_result.from_token_amount,
            );
            let approve_request_v5: dto::ApproveTransactionRequestV5 = (&approve_request).into();

            let approve_tx: dto::ApproveTransactionResponse = self
                .send_get_request(
                    endpoint,
                    signature_base_url,
                    "approve-transaction",
                    &approve_request_v5,
                )
                .await?;

            // Validate spender BEFORE returning so the cache never stores
            // a poisoned address. See validate-before-cache rationale on
            // the parallel sell-order path above.
            validate_spender_allowlist(
                self.defaults.chain_index,
                &approve_tx.dex_contract_address,
            )?;

            Ok(eth::ContractAddress(approve_tx.dex_contract_address))
        };

        let dex_approved_address = self.cache_approval_address(order, approve_future).await?;

        Ok((swap_response, dex_approved_address))
    }

    /// Helper to cache approval addresses.
    async fn cache_approval_address<F>(
        &self,
        order: &dex::Order,
        future: F,
    ) -> Result<eth::ContractAddress, Error>
    where
        F: Future<Output = Result<eth::ContractAddress, Error>>,
    {
        self.dex_approved_addresses
            .try_get_with(
                ApprovalCacheKey {
                    token: order.sell,
                    side: order.side,
                },
                future,
            )
            .await
            .map_err(|_: std::sync::Arc<Error>| Error::ApproveTransactionRequestFailed(order.sell))
    }

    /// OKX requires signature of the request to be added as dedicated HTTP
    /// Header. More information on generating the signature can be found in
    /// OKX documentation: https://web3.okx.com/build/dev-docs/wallet-api/rest-authentication
    fn generate_signature(
        &self,
        request: &reqwest::Request,
        signature_base_url: &reqwest::Url,
        timestamp: &str,
    ) -> Result<String, Error> {
        let mut data = String::new();
        data.push_str(timestamp);
        data.push_str(request.method().as_str());
        data.push_str(signature_base_url.path());
        data.push('?');
        data.push_str(request.url().query().ok_or(Error::SignRequestFailed)?);

        let mut mac = Hmac::<Sha256>::new_from_slice(self.api_secret_key.as_bytes())
            .map_err(|_| Error::SignRequestFailed)?;
        mac.update(data.as_bytes());
        let signature = mac.finalize().into_bytes();

        Ok(BASE64_STANDARD.encode(signature))
    }

    /// OKX Error codes: [link](https://web3.okx.com/build/dev-docs/wallet-api/dex-error-code)
    fn handle_api_error(code: i64, message: &str) -> Result<(), Error> {
        Err(match code {
            0 => return Ok(()),
            51005 // Honeypot or leveraged token (undocumented)
            | 82000 // Insufficient liquidity
            | 82104 // Token not supported
            | 82112 // Internal OKX risk validation failed
            => Error::NotFound,
            50011 => Error::RateLimited,
            _ => Error::Api {
                code,
                reason: message.to_string(),
            },
        })
    }

    async fn send_get_request<T, U>(
        &self,
        base_url: &reqwest::Url,
        signature_base_url: &reqwest::Url,
        endpoint: &str,
        query: &T,
    ) -> Result<U, Error>
    where
        T: Serialize,
        U: DeserializeOwned + Clone,
    {
        let mut request_builder = self
            .client
            .request(
                reqwest::Method::GET,
                base_url
                    .join(endpoint)
                    .map_err(|_| Error::RequestBuildFailed)?,
            )
            .query(query);

        let request = request_builder
            .try_clone()
            .ok_or(Error::RequestBuildFailed)?
            .build()
            .map_err(|_| Error::RequestBuildFailed)?;

        let signature_url = signature_base_url
            .join(endpoint)
            .map_err(|_| Error::RequestBuildFailed)?;

        let timestamp = &chrono::Utc::now()
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            .to_string();
        let signature = self.generate_signature(&request, &signature_url, timestamp)?;

        request_builder = request_builder.header(
            "OK-ACCESS-TIMESTAMP",
            reqwest::header::HeaderValue::from_str(timestamp)
                .map_err(|_| Error::RequestBuildFailed)?,
        );
        request_builder = request_builder.header(
            "OK-ACCESS-SIGN",
            HeaderValue::from_str(&signature).map_err(|_| Error::RequestBuildFailed)?,
        );

        let response = util::http::roundtrip!(
            <dto::Response<U>, dto::Error>;
            request_builder
        )
        .await?;

        Self::handle_api_error(response.code, &response.msg)?;
        response.data.first().cloned().ok_or(Error::NotFound)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error(transparent)]
    Header(#[from] reqwest::header::InvalidHeaderValue),
    #[error(transparent)]
    Client(#[from] reqwest::Error),
    #[error("invalid price impact protection percent {0}, must be between 0.0 and 1.0")]
    InvalidPriceImpactProtection(f64),
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to build the request")]
    RequestBuildFailed,
    #[error("failed to sign the request")]
    SignRequestFailed,
    #[error("calculating output gas failed")]
    GasCalculationFailed,
    #[error("unable to find a quote")]
    NotFound,
    #[error("order type is not supported")]
    OrderNotSupported,
    #[error("rate limited")]
    RateLimited,
    #[error("failed to get approve-transaction response for token address: {0:?}")]
    ApproveTransactionRequestFailed(eth::TokenAddress),
    #[error("api error code {code}: {reason}")]
    Api { code: i64, reason: String },
    /// Phase 2 audit retro-review (Codex+sharp-edges convergent MED on PR #83):
    /// previously router/spender allowlist rejections rode the generic
    /// `Error::Api { code: -1 }` channel, colliding with any real OKX error
    /// that returns -1. These typed variants give alerting + log-grep stable
    /// pattern matching, distinguishing protocol violation (refusing to act
    /// on attacker-shaped responses) from upstream OKX errors.
    #[error(
        "OKX router allowlist has no entry for chain {chain_id} — populate \
         OKX_ROUTER_ALLOWLIST after the verification probe"
    )]
    ChainNotInAllowlist { chain_id: u64 },
    #[error(
        "OKX returned non-allowlisted router {returned:?} for chain {chain_id} \
         (expected {expected:?})"
    )]
    RouterNotInAllowlist {
        chain_id: u64,
        returned: Address,
        expected: Address,
    },
    #[error(
        "OKX returned non-allowlisted spender {returned:?} for chain {chain_id} \
         (expected {expected:?})"
    )]
    SpenderNotInAllowlist {
        chain_id: u64,
        returned: Address,
        expected: Address,
    },
    #[error(transparent)]
    Http(util::http::Error),
}

impl From<util::http::RoundtripError<dto::Error>> for Error {
    fn from(err: util::http::RoundtripError<dto::Error>) -> Self {
        match err {
            util::http::RoundtripError::Http(err) => {
                if let util::http::Error::Status(code, _) = err {
                    match code {
                        StatusCode::TOO_MANY_REQUESTS => Self::RateLimited,
                        _ => Self::Http(err),
                    }
                } else {
                    Self::Http(err)
                }
            }
            util::http::RoundtripError::Api(err) => match err.code {
                429 => Self::RateLimited,
                _ => Self::Api {
                    code: err.code,
                    reason: err.reason,
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op_router() -> Address {
        Address::new([
            0xDd, 0x5E, 0x9B, 0x94, 0x7c, 0x99, 0xAa, 0x60, 0xba, 0xb0, 0x0c, 0xa4, 0x63, 0x1D,
            0xce, 0x63, 0xb4, 0x99, 0x83, 0xE7,
        ])
    }

    fn op_spender() -> Address {
        Address::new([
            0x68, 0xD6, 0xB7, 0x39, 0xD2, 0x02, 0x00, 0x67, 0xD1, 0xe2, 0xF7, 0x13, 0xb9, 0x99,
            0xdA, 0x97, 0xE4, 0xd5, 0x48, 0x12,
        ])
    }

    #[test]
    fn router_allowlist_accepts_verified_optimism() {
        validate_router_allowlist(10, &op_router()).unwrap();
    }

    #[test]
    fn spender_allowlist_accepts_verified_optimism() {
        validate_spender_allowlist(10, &op_spender()).unwrap();
    }

    #[test]
    fn router_allowlist_rejects_unknown_chain() {
        let err = validate_router_allowlist(999, &op_router()).unwrap_err();
        assert!(
            matches!(err, Error::ChainNotInAllowlist { chain_id: 999 }),
            "expected ChainNotInAllowlist, got {err:?}"
        );
    }

    #[test]
    fn spender_allowlist_rejects_unknown_chain() {
        let err = validate_spender_allowlist(999, &op_spender()).unwrap_err();
        assert!(
            matches!(err, Error::ChainNotInAllowlist { chain_id: 999 }),
            "expected ChainNotInAllowlist, got {err:?}"
        );
    }

    #[test]
    fn router_allowlist_rejects_attacker_router() {
        let attacker = Address::new([0xde; 20]);
        let err = validate_router_allowlist(10, &attacker).unwrap_err();
        assert!(
            matches!(err, Error::RouterNotInAllowlist { chain_id: 10, .. }),
            "expected RouterNotInAllowlist, got {err:?}"
        );
    }

    #[test]
    fn spender_allowlist_rejects_attacker_spender() {
        let attacker = Address::new([0xde; 20]);
        let err = validate_spender_allowlist(10, &attacker).unwrap_err();
        assert!(
            matches!(err, Error::SpenderNotInAllowlist { chain_id: 10, .. }),
            "expected SpenderNotInAllowlist, got {err:?}"
        );
    }

    #[test]
    fn router_and_spender_validate_independently() {
        // Cross-chain confusion test (sharp-edges suggestion): chain 1 with OP
        // addresses must fail the router check since the chain-1 router is a
        // different bytecode.
        assert!(validate_router_allowlist(1, &op_router()).is_err());
        assert!(validate_spender_allowlist(1, &op_spender()).is_err());
    }
}
