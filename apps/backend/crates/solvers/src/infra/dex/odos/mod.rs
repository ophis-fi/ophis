//! Bindings to the Odos Smart Order Router (SOR) v2 API.
//!
//! Odos's flow is two sequential HTTP calls (structurally identical to
//! KyberSwap's `/routes` + `/route/build`):
//! 1. `POST /sor/quote/v2` — returns a `pathId` and the optimistic
//!    `outAmounts`. No calldata, no router address.
//! 2. `POST /sor/assemble`  — turns that `pathId` into the encoded
//!    `transaction.{to, data, value, …}` ready to execute.
//!
//! There is no HMAC signing and no required API key. Anonymous usage is
//! rate-limited; an optional `referralCode` (free) can be supplied via config
//! for higher limits / partner attribution — it never touches the funds path.
//!
//! **Money-path invariants (mirror KyberSwap exactly):**
//!
//! 1. **RFQ exclusion / executable-by-anyone.** `userAddr` and `receiver` are
//!    set to the CoW Settlement contract on BOTH calls so the assembled
//!    calldata is executable by an arbitrary caller seconds-to-minutes after
//!    it is built. `disableRFQs = true` removes short-lived signed RFQ offers
//!    that would expire before the settlement is broadcast.
//!
//! 2. **Static router allowlist.** The `transaction.to` returned by
//!    `/sor/assemble` is trusted as both the call target and the ERC-20
//!    spender. A compromised Odos edge (DNS hijack, CA compromise, malicious
//!    CDN worker, insider) could return an attacker-controlled router and
//!    drain Settlement's transient buffer. We validate `transaction.to`
//!    against [`ODOS_ROUTER_ALLOWLIST`] BEFORE using it. The router is also
//!    the spender — Odos's V2 router pulls the input via its own
//!    `transferFrom`, there is no separate approval target.
//!
//! 3. **Slippage floor as `output.amount`.** Neither response carries a
//!    guaranteed-minimum field — `outAmounts` / `outputTokens` are the
//!    OPTIMISTIC quote. The actual floor (`outAmount * (1 -
//!    slippageLimitPercent/100)`) is what Odos bakes into the router calldata
//!    and enforces on-chain. We reconstruct that floor ourselves and report it
//!    as the CoW buy clearing amount — reporting the optimistic value would
//!    exceed the router's realized output and revert the settlement payout
//!    (the buffer-siphon / revert bug). For the exactIn SELL the input is
//!    pinned to `order.amount` (reject any mismatch) and the allowance equals
//!    the input with no pad.
//!
//! 4. **Slippage clamp.** The requested bps are clamped via
//!    [`crate::infra::metrics::clamp_slippage_bps`] before being converted to
//!    Odos's percentage form and before the floor is computed, so the modeled
//!    floor matches exactly what the router enforces.
//!
//! Odos's SOR is `exactIn`-only, so `Side::Buy` is rejected with
//! [`Error::OrderNotSupported`], same as KyberSwap.

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

/// Maximum slippage (in basis points) we will pass to Odos (20%). Anything
/// above this is routing-distortion territory and almost certainly a
/// misconfiguration. Matches the kyberswap / velora caps.
const MAX_SLIPPAGE_BPS: u16 = 2000;

/// Allowlist of Odos router addresses that can be used as the swap call target
/// and approved as ERC-20 spender for the Settlement contract.
///
/// **Why a fixed allowlist?** The `transaction.to` returned by `/sor/assemble`
/// is trusted as an unlimited-allowance grantee — a compromised Odos edge (DNS
/// hijack, CA compromise, malicious CDN worker, insider) that returns an
/// attacker-controlled router can drain Settlement's transient balance during
/// execution. Unlike KyberSwap, Odos exposes the router only in the assemble
/// response (the quote step has none), so there is no intra-request equality
/// check to fall back on — the static allowlist is the ONLY defense and is
/// load-bearing.
///
/// **Address coverage:** Odos deploys its `OdosRouterV2` per chain. The entry
/// below is Unichain (chain 130).
///   - Unichain (130): `0x6409722F3a1C4486A3b1FE566cBDd5e9D946A1f3`
///     Verified live 2026-06-30 via `eth_getCode` on
///     <https://unichain-rpc.publicnode.com> (chainId `0x82` = 130) — the
///     address has deployed bytecode (an `OdosRouterV2` with the
///     `swapCompact` / `swap` selectors).
///
/// **If Odos deploys a new router** (e.g. V3) or this solver is extended to a
/// new chain: add the new address here ONLY after independent `cast code`
/// verification — do NOT take it from a `/sor/assemble` response. Odos's
/// router-address registry: <https://docs.odos.xyz/build/contracts>.
const ODOS_ROUTER_ALLOWLIST: &[Address] = &[
    // Unichain (130) — OdosRouterV2.
    Address::new([
        0x64, 0x09, 0x72, 0x2f, 0x3a, 0x1c, 0x44, 0x86, 0xa3, 0xb1, 0xfe, 0x56, 0x6c, 0xbd, 0xd5,
        0xe9, 0xd9, 0x46, 0xa1, 0xf3,
    ]),
];

fn validate_router_allowlist(router: &Address) -> Result<(), Error> {
    if ODOS_ROUTER_ALLOWLIST.contains(router) {
        Ok(())
    } else {
        Err(Error::Api {
            code: -1,
            reason: format!(
                "Odos returned non-allowlisted router address {router:?}. \
                Refusing to call it / approve allowance. If this is a \
                legitimate new Odos router, add it to ODOS_ROUTER_ALLOWLIST in \
                crates/solvers/src/infra/dex/odos/mod.rs after independent \
                cast-code verification."
            ),
        })
    }
}

/// Bindings to the Odos SOR v2 aggregator API.
pub struct Odos {
    client: super::Client,
    base_url: reqwest::Url,
    chain_id: u64,
    settlement_contract: Address,
    referral_code: Option<u64>,
    api_key: Option<String>,
}

pub struct Config {
    /// Base URL for the Odos SOR API. Defaults to `https://api.odos.xyz/`.
    pub base_url: reqwest::Url,

    /// Chain ID — sent as `chainId` in the quote body. Odos validates it.
    pub chain_id: eth::ChainId,

    /// CoW settlement contract address — used as `userAddr` and `receiver` on
    /// both the quote and assemble calls so the calldata is executable by the
    /// settlement and the output lands in its buffer.
    pub settlement_contract: Address,

    /// Optional Odos referral code for partner attribution / volume
    /// monetization. Never affects the funds path.
    pub referral_code: Option<u64>,

    /// Optional Odos API key, sent as the `x-api-key` header. The anonymous
    /// tier is aggressively rate-limited (HTTP 429 even for a single solve), so
    /// a free-plan key (2 RPS / 4k daily) is effectively required for the solver
    /// to participate. Secret: rendered from `${ODOS_API_KEY}`, never committed.
    /// Never affects the funds path — auth/rate-limit only.
    pub api_key: Option<String>,

    /// Block stream used to attach the current block hash header so an egress
    /// proxy can cache responses per block.
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl Odos {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        let client = {
            // Odos's CDN flags requests with no User-Agent. Set an explicit UA
            // to avoid the bot challenge (same precaution as the kyberswap
            // client).
            let client = reqwest::Client::builder()
                .user_agent("ophis-solver/1.0")
                .build()?;
            super::Client::new(client, config.block_stream)
        };

        Ok(Self {
            client,
            base_url: config.base_url,
            chain_id: config.chain_id as u64,
            settlement_contract: config.settlement_contract,
            referral_code: config.referral_code,
            api_key: config.api_key,
        })
    }

    /// Attaches the `x-api-key` auth header when a key is configured. Returns
    /// the builder unchanged on the anonymous tier.
    fn with_api_key(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => request.header("x-api-key", key),
            None => request,
        }
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
        is_quote: bool,
    ) -> Result<dex::Swap, Error> {
        // Odos SOR is exactIn-only.
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        // Tracing span — correlate quote/assemble logs on a shared id.
        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        async move {
            // Clamp slippage ONCE, here, so the same value drives both the
            // request to Odos (which determines the on-chain floor baked into
            // the calldata) and our reconstructed `output.amount` floor.
            let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
            let slippage_bps = crate::infra::metrics::clamp_slippage_bps(
                crate::infra::metrics::Dex::Odos,
                slippage_bps,
                MAX_SLIPPAGE_BPS,
            );

            let quote = self.get_quote(order, slippage_bps).await?;

            // Odos SOR is exactIn — the quote must reflect the exact sell
            // amount. A mismatch means the API silently re-sized the input;
            // refuse rather than model an input the router won't pull. (Odos
            // does not echo `inAmounts` when `compact` is set in all versions,
            // so only enforce when present.)
            if let Some(in_amount) = quote.in_amounts.first()
                && *in_amount != order.amount.get()
            {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "/sor/quote/v2 returned input amount {:?}, expected exactIn order \
                         amount {:?}",
                        in_amount,
                        order.amount.get()
                    ),
                });
            }

            // Single output token requested → exactly one optimistic amount.
            let optimistic_out = *quote.out_amounts.first().ok_or(Error::NotFound)?;
            if optimistic_out.is_zero() {
                return Err(Error::NotFound);
            }

            let path_id = quote.path_id.clone();
            let assembled = self.assemble(path_id).await?;
            let router = assembled.transaction.to;

            // Validate the router BEFORE using it as the call target / spender.
            // This is the ONLY router-poisoning defense for Odos (no quote-vs-
            // assemble equality check is possible — the quote has no router).
            validate_router_allowlist(&router)?;

            // ERC-20 -> ERC-20 only. The settlement holds wrapped tokens, so a
            // non-zero native `value` means the route expects ETH the settlement
            // won't attach — refuse rather than build a call that can only revert
            // at settle time (the same wrapped-settlement guard DODO applies).
            if odos_value_is_nonzero(&assembled.transaction.value) {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "Odos route requires non-zero native value {}",
                        assembled.transaction.value
                    ),
                });
            }

            // Pad the gas estimate by 50% (mirrors kyberswap / velora). Prefer
            // the assemble `gas` (router-specific) and fall back to the quote
            // estimate if assemble returned 0.
            let gas_estimate = if assembled.transaction.gas > 0 {
                assembled.transaction.gas
            } else {
                quote.gas_estimate.ceil() as u64
            };
            if gas_estimate == 0 {
                return Err(Error::GasCalculationFailed);
            }
            let gas_u256 = U256::from(gas_estimate);
            let gas = gas_u256
                .checked_add(gas_u256 / U256::from(2))
                .ok_or(Error::GasCalculationFailed)?;

            Ok(dex::Swap {
                calls: vec![dex::Call {
                    to: router,
                    calldata: assembled.transaction.data,
                }],
                input: eth::Asset {
                    token: order.sell,
                    // exactIn: input is fixed to the order's sell amount. The
                    // quote/assemble can only have agreed to this amount (we
                    // pinned `inAmounts` above when present); the router pulls
                    // exactly this via transferFrom, so it can never reach
                    // Settlement's transient buffer.
                    amount: order.amount.get(),
                },
                output: eth::Asset {
                    token: order.buy,
                    // Report the GUARANTEED slippage-floor output (== the
                    // router's on-chain minimum, `optimistic_out * (10000 -
                    // slippage) / 10000`), NOT the optimistic quote
                    // `optimistic_out`. The CoW settlement pays the buy side at
                    // exactly this clearing amount; if it exceeded what the
                    // router actually realized, the buy-token transfer to the
                    // receiver reverts, the solver's gas simulation fails, and
                    // the solution is dropped as NoSolutions. The router
                    // guarantees realized >= floor, so paying the floor always
                    // succeeds; positive slippage above it accrues to the
                    // Settlement buffer (standard CoW surplus handling). The
                    // order's signed buy-amount-min is enforced downstream, so
                    // a floor below the limit is correctly filtered as a
                    // NoSolution.
                    // Settle: router floor (#726). Quote: optimistic_out, so the
                    // price shown matches 0x/ParaSwap. Quotes never settle.
                    amount: if is_quote {
                        optimistic_out
                    } else {
                        min_output_amount(optimistic_out, slippage_bps)
                    },
                },
                allowance: dex::Allowance {
                    // Odos's V2 router is the spender (it pulls the input via
                    // its own transferFrom) — no separate approval target.
                    spender: router,
                    // exactIn: allowance == input == order amount, no pad.
                    amount: dex::Amount::new(order.amount.get()),
                },
                gas: eth::Gas(gas),
            })
        }
        .instrument(tracing::trace_span!("odos-swap", id = %id))
        .await
    }

    /// Step 1 — fetch the best path (returns `pathId` + optimistic
    /// `outAmounts`).
    async fn get_quote(
        &self,
        order: &dex::Order,
        slippage_bps: u16,
    ) -> Result<dto::QuoteResponse, Error> {
        let body = dto::QuoteRequest {
            chain_id: self.chain_id,
            input_tokens: vec![dto::InputToken {
                token_address: order.sell.0,
                amount: order.amount.get(),
            }],
            output_tokens: vec![dto::OutputToken {
                token_address: order.buy.0,
                proportion: 1,
            }],
            user_addr: self.settlement_contract,
            // Odos takes a percentage: bps / 100.0 (e.g. 100 bps -> 1.0%).
            slippage_limit_percent: f64::from(slippage_bps) / 100.0,
            referral_code: self.referral_code,
            disable_rfqs: true,
            compact: true,
        };

        let url = self
            .base_url
            .join("sor/quote/v2")
            .map_err(|_| Error::RequestBuildFailed)?;

        let request = self.with_api_key(
            self.client
                .request(reqwest::Method::POST, url)
                .header(reqwest::header::CONTENT_TYPE, "application/json"),
        );
        let request = request.json(&body);

        let response: dto::QuoteResponse =
            util::http::roundtrip!(<dto::QuoteResponse, dto::ApiError>; request).await?;

        Ok(response)
    }

    /// Step 2 — assemble the calldata for the `pathId` from step 1.
    async fn assemble(&self, path_id: String) -> Result<dto::AssembleResponse, Error> {
        let body = dto::AssembleRequest {
            user_addr: self.settlement_contract,
            path_id,
            // The user (CoW Settlement) holds no balance at simulation time —
            // disable Odos's EOA-style simulation; we pad the gas ourselves.
            simulate: false,
            receiver: self.settlement_contract,
        };

        let url = self
            .base_url
            .join("sor/assemble")
            .map_err(|_| Error::RequestBuildFailed)?;

        let request = self.with_api_key(
            self.client
                .request(reqwest::Method::POST, url)
                .header(reqwest::header::CONTENT_TYPE, "application/json"),
        );
        let request = request.json(&body);

        let response: dto::AssembleResponse =
            util::http::roundtrip!(<dto::AssembleResponse, dto::ApiError>; request).await?;

        Ok(response)
    }
}

/// The router's guaranteed minimum output for an optimistic `out_amount` and
/// the `slippage_bps` we sent to `/sor/quote/v2`.
///
/// Odos bakes `outputMin = out_amount * (10000 - slippage) / 10000` (floor)
/// into the swap calldata and reverts on-chain if the realized output is below
/// it. Reporting exactly this value as the CoW buy clearing amount means the
/// settlement's buy-side payout can never exceed what the router actually
/// delivered, so neither the on-chain buy transfer nor the solver's gas
/// simulation can revert. Positive slippage above the floor accrues to the
/// Settlement buffer (standard CoW surplus handling). Mirrors kyberswap's
/// `min_return_amount` / velora's `velora_min_received`.
fn min_output_amount(out_amount: U256, slippage_bps: u16) -> U256 {
    let bps = U256::from(10_000u64);
    let keep = bps.saturating_sub(U256::from(slippage_bps));
    // Real token amounts are far below U256::MAX/10000 so the multiply cannot
    // overflow; if it ever did, fall back to the (more conservative)
    // divide-first form rather than returning the un-discounted optimistic
    // amount (which is the bug this guards against).
    match out_amount.checked_mul(keep) {
        Some(scaled) => scaled / bps,
        None => out_amount / bps * keep,
    }
}

/// Whether an Odos `/sor/assemble` `transaction.value` represents a non-zero
/// native amount. Odos returns it untyped (a decimal string or a JSON number),
/// so we tolerate either shape: null / empty / all-zero strings / numeric `0`
/// are zero; anything else — including an unparseable shape — is treated as a
/// native-ETH requirement the wrapped-token settlement cannot satisfy, and is
/// rejected fail-closed.
fn odos_value_is_nonzero(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Number(n) => n.as_u64().map(|v| v != 0).unwrap_or(true),
        serde_json::Value::String(s) => {
            let t = s.trim().trim_start_matches("0x");
            !t.is_empty() && !t.bytes().all(|b| b == b'0')
        }
        _ => true,
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
            util::http::RoundtripError::Api(err) => {
                let detail = err.detail.to_ascii_lowercase();
                if detail.contains("rate limit") || detail.contains("too many requests") {
                    Self::RateLimited
                } else if detail.contains("no path")
                    || detail.contains("no viable path")
                    || detail.contains("not found")
                    || detail.contains("unsupported")
                {
                    Self::NotFound
                } else {
                    Self::Api {
                        code: err.error_code.unwrap_or(-1),
                        reason: err.detail,
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the live-traced Unichain revert pattern (#726): reporting the
    // optimistic quote (`out_amount`) as the buy clearing amount exceeds the
    // router's realized output and reverts the settlement payout. The fix
    // reports the slippage floor instead.
    #[test]
    fn min_output_amount_is_router_slippage_floor() {
        // Representative live-shape chain-130 USDC->WETH quote (18-dec WETH).
        let out_amount = U256::from(988_146_014_276_470u128);
        // 100 bps (1%) slippage -> floor = out_amount * 9900 / 10000.
        let floor = min_output_amount(out_amount, 100);
        assert_eq!(
            floor,
            out_amount * U256::from(9_900u64) / U256::from(10_000u64)
        );
        // Strictly below the optimistic quote (the value that used to revert).
        assert!(floor < out_amount);
    }

    #[test]
    fn min_output_amount_zero_slippage_is_identity() {
        let a = U256::from(1_000_000_000u64);
        assert_eq!(min_output_amount(a, 0), a);
    }

    #[test]
    fn min_output_amount_full_slippage_is_zero() {
        let a = U256::from(1_000_000_000u64);
        assert_eq!(min_output_amount(a, 10_000), U256::ZERO);
    }

    #[test]
    fn min_output_amount_matches_one_percent_floor() {
        // 1_000_000 units at 1% -> 990_000 floor.
        assert_eq!(
            min_output_amount(U256::from(1_000_000u64), 100),
            U256::from(990_000u64)
        );
    }

    #[test]
    fn quote_reports_optimistic_solve_reports_floor() {
        // Mirrors the is_quote branch in `swap`: quote => optimistic_out,
        // solve => the router floor. Documents the SELL-side quote/settle split.
        let optimistic_out = U256::from(988_146_014_276_470u128);
        let quote = optimistic_out;
        let solve = min_output_amount(optimistic_out, 100);
        assert_eq!(quote, optimistic_out);
        assert!(solve < optimistic_out);
    }

    #[test]
    fn value_zero_forms_are_treated_as_zero() {
        use serde_json::json;
        // Null / absent, empty, and every all-zero decimal/hex string == zero.
        assert!(!odos_value_is_nonzero(&serde_json::Value::Null));
        assert!(!odos_value_is_nonzero(&json!("")));
        assert!(!odos_value_is_nonzero(&json!("0")));
        assert!(!odos_value_is_nonzero(&json!("000")));
        assert!(!odos_value_is_nonzero(&json!("0x0")));
        assert!(!odos_value_is_nonzero(&json!("  0 ")));
        assert!(!odos_value_is_nonzero(&json!(0)));
    }

    #[test]
    fn value_nonzero_forms_are_rejected_fail_closed() {
        use serde_json::json;
        // Any non-zero native value (string or number) must be flagged so the
        // wrapped-token settlement never builds a call that reverts on ETH it
        // cannot attach. Unparseable shapes fail closed (treated as non-zero).
        assert!(odos_value_is_nonzero(&json!("1")));
        assert!(odos_value_is_nonzero(&json!("1000000000000000000")));
        assert!(odos_value_is_nonzero(&json!(1)));
        assert!(odos_value_is_nonzero(&json!("not-a-number")));
        assert!(odos_value_is_nonzero(&json!(["unexpected", "shape"])));
    }
}
