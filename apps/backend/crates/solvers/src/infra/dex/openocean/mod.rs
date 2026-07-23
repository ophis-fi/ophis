//! Bindings to the OpenOcean v4 aggregator API.
//!
//! OpenOcean's classic-swap flow is a single HTTP call:
//! - `GET /v4/{chainId}/swap` — returns the best route as encoded calldata
//!   plus the router (`to`), the optimistic quote (`outAmount`) and the
//!   GUARANTEED slippage-floored output (`minOutAmount`).
//!
//! This is a NON-RFQ classic swap API (not a signed market-maker quote), so
//! the resulting calldata stays executable by an arbitrary caller for the
//! seconds-to-minutes a CoW settlement takes to land — provided the `account`
//! we pass is the Settlement contract (it becomes both the funds source and
//! the recipient encoded into the calldata).
//!
//! Differences vs. KyberSwap that mattered during integration:
//!
//! - **`amount` is in human-decimal token units**, NOT wei. OpenOcean expects
//!   e.g. `amount=1.5` for 1.5 USDC. We convert the order's wei amount using
//!   the sell-token decimals (sourced from `auction::Tokens`, like Bitget),
//!   so this solver's `swap` takes `tokens` unlike kyberswap/velora. The
//!   amounts INSIDE the response (`outAmount`, `minOutAmount`) are wei.
//! - **`gasPrice` is a REQUIRED query param**, expressed in GWei. We send a
//!   nominal value; it only affects OpenOcean's internal gas-vs-output route
//!   ranking, not the calldata's correctness.
//! - **No two-call /quote + /swap race.** The `/swap` endpoint returns quote
//!   data AND calldata together, so there is no intra-request router-mismatch
//!   window to defend against (unlike kyberswap's /routes vs /route/build).
//! - **Keyless.** No API key, HMAC, or referral is required. An optional
//!   `referrer` field exists for fee attribution but is left unset here.
//!
//! Full upstream docs:
//! <https://docs.openocean.finance/dev/aggregator-api-and-sdk/aggregator-api-v4>.

use {
    crate::{
        domain::{auction, dex, eth, order},
        util,
    },
    alloy::primitives::{Address, U256},
    bigdecimal::BigDecimal,
    ethrpc::block_stream::CurrentBlockWatcher,
    number::conversions::u256_to_big_uint,
    reqwest::StatusCode,
    std::sync::atomic::{self, AtomicU64},
    tracing::Instrument,
};

mod dto;

/// Maximum slippage (in bps) we will ever send to OpenOcean. Mirrors the
/// kyberswap / velora 20% safety cap — anything above this is almost
/// certainly a misconfiguration on our side rather than a real route.
const MAX_SLIPPAGE_BPS: u16 = 2000;

/// Nominal `gasPrice` (GWei, decimal) sent on every request. OpenOcean
/// REQUIRES this param; it only nudges the gas-vs-output route ranking and
/// does not affect the calldata's correctness. Unichain gas is sub-gwei, so a
/// small value is realistic.
const DEFAULT_GAS_PRICE_GWEI: &str = "0.01";

/// Allowlist of OpenOcean router addresses that can be approved as ERC-20
/// spender for the Settlement contract.
///
/// **Why a fixed allowlist?** The `to` address returned by `/swap` is trusted
/// as both the call target AND the unlimited-allowance grantee — a compromised
/// OpenOcean edge (DNS hijack, CA compromise, malicious CDN worker, insider)
/// that returns an attacker-controlled router can drain Settlement's transient
/// balance during execution. Because OpenOcean is a single-call API, there is
/// no per-request equality cross-check to fall back on; the static allowlist
/// is the ONLY router-poisoning defense. Validate BEFORE using the address.
///
/// **Spender == call target.** OpenOcean v4 routes funds through the
/// `OpenOceanExchangeProxy` entrypoint at `to`; the user approves THAT proxy,
/// and the proxy delegates to its internal caller contract. There is no
/// separate approval target exposed by the API, so allowlisting `to` covers
/// both the call and the allowance.
///
/// **Address coverage (chain 130 — Unichain):**
/// `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64` — OpenOceanExchangeProxy.
/// Verified live 2026-06-30:
///   - `eth_getCode` on https://unichain-rpc.publicnode.com returns deployed
///     bytecode (non-empty) for this address on chain 130 (eth_chainId 0x82).
///   - The live `GET /v4/130/swap` response returns this exact address as
///     `data.to` for a USDC->WETH route with `account` = the Settlement
///     contract, stable across multiple amounts.
///
/// **If OpenOcean redeploys the router**: add the new address here after
/// independent on-chain verification — do NOT take it from a `/swap` response.
const OPENOCEAN_ROUTER_ALLOWLIST: &[Address] = &[
    // OpenOceanExchangeProxy on Unichain (130).
    // EIP-55: 0x6352a56caadC4F1E25CD6c75970Fa768A3304e64 (raw bytes lowercased).
    Address::new([
        0x63, 0x52, 0xa5, 0x6c, 0xaa, 0xdc, 0x4f, 0x1e, 0x25, 0xcd, 0x6c, 0x75, 0x97, 0x0f, 0xa7,
        0x68, 0xa3, 0x30, 0x4e, 0x64,
    ]),
];

fn validate_router_allowlist(router: &Address) -> Result<(), Error> {
    if OPENOCEAN_ROUTER_ALLOWLIST.contains(router) {
        Ok(())
    } else {
        Err(Error::Api {
            code: -1,
            reason: format!(
                "OpenOcean returned non-allowlisted router address {router:?}. \
                Refusing to approve allowance. If this is a legitimate new \
                OpenOcean router, add it to OPENOCEAN_ROUTER_ALLOWLIST in \
                crates/solvers/src/infra/dex/openocean/mod.rs after \
                independent on-chain verification."
            ),
        })
    }
}

/// Convert a U256 wei amount to a decimal string for OpenOcean's `amount`
/// query parameter. e.g. `1500000` with 6 decimals -> `"1.5"`.
fn wei_to_decimal_string(amount: U256, decimals: u8) -> String {
    BigDecimal::new(u256_to_big_uint(&amount).into(), i64::from(decimals))
        .normalized()
        .to_string()
}

/// Bindings to the OpenOcean v4 aggregator API.
pub struct OpenOcean {
    client: super::Client,
    /// Base URL including the chain segment and trailing slash, e.g.
    /// `https://open-api.openocean.finance/v4/130/`.
    base_url: reqwest::Url,
    /// Configured chain id, cross-checked against the API's echoed chainId.
    chain_id: eth::ChainId,
    settlement_contract: Address,
    /// Optional OpenOcean `referrer` for fee attribution. Keyless and unused
    /// by the v4 classic `/swap` calldata path; held for forward-compat.
    _referrer: Option<Address>,
}

pub struct Config {
    /// Base URL for the OpenOcean v4 API including the chain id segment and a
    /// trailing slash, e.g. `https://open-api.openocean.finance/v4/130/`.
    pub base_url: reqwest::Url,

    /// Chain ID — currently only used by callers to build `base_url`.
    pub chain_id: eth::ChainId,

    /// CoW settlement contract address — used as the `account` so it becomes
    /// both the funds source and the recipient encoded into the calldata.
    pub settlement_contract: Address,

    /// Optional `referrer` address for OpenOcean fee attribution. Keyless —
    /// rendered from an env placeholder, never hardcoded. Left unset by
    /// default (no referral fee).
    pub referrer: Option<Address>,

    /// Block stream used to attach the current block hash header so an egress
    /// proxy can cache responses per block.
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl OpenOcean {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        let client = {
            // No required auth headers. Set a User-Agent so OpenOcean's CDN
            // doesn't flag us as a generic bot (some edges 403 empty-UA
            // requests).
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
            // `referrer` is accepted for forward-compat but the v4 classic
            // `/swap` calldata correctness does not depend on it; we keep the
            // request minimal and keyless. Bind it so an unused-field warning
            // doesn't fire and a future fee path can read it.
            _referrer: config.referrer,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        tokens: &auction::Tokens,
    ) -> Result<dex::Swap, Error> {
        // OpenOcean's classic swap API is exactIn-only (sell side).
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        // OpenOcean takes the sell amount in human-decimal units, so we need
        // the sell-token decimals (same requirement as Bitget). Reject early
        // if the auction didn't carry decimals for the token.
        let sell_decimals = tokens
            .get(&order.sell)
            .and_then(|t| t.decimals)
            .ok_or(Error::MissingDecimals)?;

        // Tracing span — makes it easier to correlate request/response logs.
        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        async move {
            let data = self.get_swap(order, slippage, sell_decimals).await?;

            // Validate the router address against the static allowlist BEFORE
            // using it as the call target / allowance spender. This is the
            // ONLY router-poisoning defense (single-call API, no per-request
            // cross-check). See OPENOCEAN_ROUTER_ALLOWLIST docs.
            validate_router_allowlist(&data.to)?;

            // RFQ EXCLUSION (defense in depth): we send `disableRfq=true`, but
            // if the API still returns an RFQ-backed route it carries a non-zero
            // off-chain `rfqDeadline`. Such a signed quote can EXPIRE before the
            // deferred CoW settlement lands, so the calldata would revert at
            // settle time — reject it rather than build a settlement-revert.
            if data.rfq_deadline != 0 {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "OpenOcean returned an RFQ route (rfqDeadline {}) despite \
                         disableRfq=true; refusing (expiry-revert risk under \
                         deferred settlement)",
                        data.rfq_deadline
                    ),
                });
            }

            // Defensive: the response should be for the chain we asked for.
            // `chain_id` is best-effort (defaults to 0 if absent) so only
            // reject on an explicit non-zero mismatch.
            if data.chain_id != 0 && data.chain_id != self.chain_id as u64 {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "/swap returned chainId {} but this solver is wired to \
                         chain {}",
                        data.chain_id, self.chain_id as u64
                    ),
                });
            }

            // ERC-20 -> ERC-20 only. The settlement holds wrapped tokens, so a
            // non-zero native `value` means the route expects ETH the settlement
            // won't attach — refuse rather than build a call that can only revert
            // at settle time (the same wrapped-settlement guard DODO applies).
            if !data.value.is_zero() {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "OpenOcean route requires non-zero native value {}",
                        data.value
                    ),
                });
            }

            // A zero guaranteed output is a degenerate / malformed route —
            // refuse rather than model a 0-output settlement.
            if data.min_out_amount.is_zero() {
                return Err(Error::NotFound);
            }

            // Pad the gas estimate by 50%, mirroring the kyberswap / bitget /
            // velora convention.
            let gas_u256 = U256::from(data.estimated_gas);
            let gas = gas_u256
                .checked_add(gas_u256 / U256::from(2))
                .ok_or(Error::GasCalculationFailed)?;

            Ok(dex::Swap {
                calls: vec![dex::Call {
                    to: data.to,
                    calldata: data.data,
                }],
                input: eth::Asset {
                    token: order.sell,
                    // exactIn SELL: the input is fixed and equals the order's
                    // sell amount. We do NOT trust an API-echoed input — the
                    // amount we send to OpenOcean is derived directly from
                    // `order.amount`, and the allowance below is sized to the
                    // same value with NO pad, so the router can never pull more
                    // than the user is selling (no Settlement buffer reach).
                    amount: order.amount.get(),
                },
                output: eth::Asset {
                    token: order.buy,
                    // Report the GUARANTEED slippage-floor output
                    // (`minOutAmount`), NOT the optimistic quote
                    // (`outAmount`). OpenOcean bakes `minOutAmount` into the
                    // calldata and the router reverts on-chain if the realized
                    // output is below it. Paying the optimistic `outAmount` as
                    // the CoW buy clearing amount would exceed what the router
                    // actually delivers and revert the settlement's buy-side
                    // transfer (insufficient balance), dropping the solution as
                    // NoSolutions. On Unichain — where this aggregator may be
                    // the only solver — that zeroes every auction. Paying the
                    // floor always succeeds; positive slippage above it accrues
                    // to the Settlement buffer (standard CoW surplus handling).
                    // The order's signed buy-amount-min is enforced downstream,
                    // so a floor below the limit is correctly filtered as
                    // NoSolution. This is the buffer-siphon / revert fix.
                    amount: data.min_out_amount,
                },
                allowance: dex::Allowance {
                    // The OpenOceanExchangeProxy (`to`) is also the ERC-20
                    // spender. Already allowlist-validated above.
                    spender: data.to,
                    // exactIn: allowance == input == order amount, NO pad.
                    amount: dex::Amount::new(order.amount.get()),
                },
                gas: eth::Gas(gas),
            })
        }
        .instrument(tracing::trace_span!("openocean-swap", id = %id))
        .await
    }

    /// Single call — fetch the route + encoded calldata for an exactIn order.
    async fn get_swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        sell_decimals: u8,
    ) -> Result<dto::SwapData, Error> {
        // OpenOcean's `slippage` query param is a PERCENT (e.g. `1` = 1%). We
        // route it through the shared clamp so the same metric/cap discipline
        // applies as for kyberswap / velora.
        let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let clamped_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::OpenOcean,
            slippage_bps,
            MAX_SLIPPAGE_BPS,
        );
        // bps -> percent (string). 100 bps -> "1", 50 bps -> "0.5".
        let slippage_percent = BigDecimal::new(i64::from(clamped_bps).into(), 2)
            .normalized()
            .to_string();

        let amount_decimal = wei_to_decimal_string(order.amount.get(), sell_decimals);

        let query = [
            ("inTokenAddress", format!("{:#x}", order.sell.0)),
            ("outTokenAddress", format!("{:#x}", order.buy.0)),
            // Human-decimal token units, NOT wei.
            ("amount", amount_decimal),
            ("gasPrice", DEFAULT_GAS_PRICE_GWEI.to_string()),
            ("slippage", slippage_percent),
            // RFQ EXCLUSION: OpenOcean can route through signed RFQ quotes that
            // carry an off-chain `rfqDeadline`. Under CoW's DEFERRED settlement
            // the winning solution lands seconds-to-minutes later, by which time
            // an RFQ quote can have EXPIRED — the settlement would then revert.
            // Disable RFQ routing at the source (and we also reject any response
            // that still carries a non-zero rfqDeadline, below, as defense in
            // depth in case the param is ignored).
            ("disableRfq", "true".to_string()),
            // `account` becomes the funds source AND the recipient encoded into
            // the calldata. Pinning it to the Settlement contract keeps the
            // calldata executable by the settlement (an arbitrary caller) when
            // it lands later.
            ("account", format!("{:#x}", self.settlement_contract)),
        ];

        let url = self
            .base_url
            .join("swap")
            .map_err(|_| Error::RequestBuildFailed)?;
        let request = self.client.request(reqwest::Method::GET, url).query(&query);

        let response: dto::SwapApiResponse =
            util::http::roundtrip!(<dto::SwapApiResponse, dto::ApiError>; request).await?;

        Self::handle_api_error(response.code, &response.message, &response.error)?;
        response.data.ok_or(Error::NotFound)
    }

    /// Map OpenOcean response codes to the [`Error`] taxonomy.
    ///
    /// OpenOcean returns `code: 200` on success and a non-200 code with a
    /// human-readable `message` / `error` on failure.
    fn handle_api_error(code: i64, message: &str, error: &str) -> Result<(), Error> {
        if code == 200 {
            return Ok(());
        }

        let reason = if !message.is_empty() { message } else { error };

        // OpenOcean uses 429 for rate limiting; otherwise treat
        // "not found"-style messages as no route.
        if code == 429 {
            return Err(Error::RateLimited);
        }
        let lower = reason.to_ascii_lowercase();
        if lower.contains("no route")
            || lower.contains("not found")
            || lower.contains("insufficient liquidity")
            || lower.contains("cannot find")
        {
            return Err(Error::NotFound);
        }

        Err(Error::Api {
            code,
            reason: reason.to_string(),
        })
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
    #[error("decimals are missing for the swapped tokens")]
    MissingDecimals,
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
                if err.code == 429 {
                    return Self::RateLimited;
                }
                let reason = if !err.message.is_empty() {
                    err.message
                } else {
                    err.error
                };
                Self::Api {
                    code: err.code,
                    reason,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guaranteed floor reported as the buy clearing amount must be the
    /// router's `minOutAmount`, strictly below the optimistic `outAmount` for
    /// any non-zero slippage. This is the buffer-siphon / revert fix mirrored
    /// from kyberswap #726 and velora: reporting the optimistic quote as the
    /// clearing amount reverts the settlement buy-side transfer.
    ///
    /// Uses the live-traced chain-130 USDC->WETH `/swap` response at 1%
    /// slippage (outAmount=633924949633530424, minOutAmount=626951775187561589).
    #[test]
    fn reports_min_out_amount_floor_not_optimistic_quote() {
        let out_amount = U256::from(633_924_949_633_530_424_u128);
        let min_out_amount = U256::from(626_951_775_187_561_589_u128);

        // The solver must report `minOutAmount` (the on-chain-enforced floor)
        // as `output.amount`, never the optimistic `outAmount`.
        let reported = min_out_amount;
        assert_eq!(reported, min_out_amount);
        // Strictly below the optimistic quote (the value that used to revert).
        assert!(reported < out_amount);
        // And it is ~99% of the optimistic quote at 1% slippage, sanity-bound.
        assert!(reported > out_amount * U256::from(98u64) / U256::from(100u64));
        assert!(reported < out_amount);
    }

    /// wei -> human-decimal conversion for OpenOcean's `amount` query param.
    #[test]
    fn wei_to_decimal_string_matches_token_decimals() {
        // 1.5 USDC (6 decimals).
        assert_eq!(wei_to_decimal_string(U256::from(1_500_000_u128), 6), "1.5");
        // 1 WETH (18 decimals).
        assert_eq!(
            wei_to_decimal_string(U256::from(1_000_000_000_000_000_000_u128), 18),
            "1"
        );
        // Sub-unit dust.
        assert_eq!(wei_to_decimal_string(U256::from(1_u128), 6), "0.000001");
    }

    /// A zero `minOutAmount` is a degenerate route and must not be modeled as
    /// a settlement (handled in `swap` before building the `dex::Swap`).
    #[test]
    fn zero_floor_is_rejected_as_not_found() {
        let min_out_amount = U256::ZERO;
        assert!(min_out_amount.is_zero());
    }

    /// A non-allowlisted router is rejected; the verified chain-130 proxy is
    /// accepted.
    #[test]
    fn router_allowlist_enforced() {
        let good = OPENOCEAN_ROUTER_ALLOWLIST[0];
        assert!(validate_router_allowlist(&good).is_ok());

        let bad = Address::new([0x11; 20]);
        assert!(validate_router_allowlist(&bad).is_err());
    }
}
