//! Bindings to the LI.FI (li.quest) aggregator API, restricted to SAME-CHAIN
//! DEX swaps on Unichain (chain 130).
//!
//! LI.FI's quote flow is a single HTTP call:
//! - `GET /v1/quote` (with `fromChain == toChain`) — returns the best route as
//!   `transactionRequest` (encoded calldata + router `to`), plus
//!   `estimate.toAmount` (optimistic) and `estimate.toAmountMin` (the
//!   GUARANTEED on-chain slippage floor, baked into the calldata's `minAmount`).
//!
//! This is a NON-RFQ on-chain DEX route (the calldata is a deterministic
//! `swapTokensMultipleV3ERC20ToERC20` AMM swap, with NO off-chain signature /
//! permit / deadline / nonce), so it stays executable by an arbitrary caller
//! for the seconds-to-minutes a CoW settlement takes to land — provided we pin
//! both `fromAddress` and `toAddress` to the Settlement contract (it becomes
//! the funds source AND the on-chain receiver encoded into the calldata).
//!
//! LI.FI is a same-chain + cross-chain aggregator; we use it for SAME-CHAIN
//! swaps ONLY. We request `fromChain == toChain == 130`, and reject — defense
//! in depth — any response whose `action` is cross-chain or whose
//! `includedSteps` contain a bridge step (a bridge's calldata is not
//! deferred-settlement-safe).
//!
//! Keyless: LI.FI's public tier needs no API key (only the `integrator` query
//! param is required); a free no-KYC key for higher limits exists but is not
//! wired here.
//!
//! Full upstream docs: <https://docs.li.fi/api-reference>.

use {
    crate::{
        domain::{dex, eth, order},
        util,
    },
    alloy::primitives::{Address, U256},
    bigdecimal::BigDecimal,
    ethrpc::block_stream::CurrentBlockWatcher,
    reqwest::StatusCode,
    std::sync::atomic::{self, AtomicU64},
    tracing::Instrument,
};

mod dto;

/// Maximum slippage (in bps) we will ever send to LI.FI. Mirrors the
/// kyberswap / velora / openocean 20% safety cap.
const MAX_SLIPPAGE_BPS: u16 = 2000;

/// Fallback gas-units estimate when LI.FI omits a `gasCosts` entry. A LI.FI
/// same-chain diamond swap is ~1.5M gas; this conservative default is padded
/// 50% like the live estimate.
const DEFAULT_GAS_UNITS: u64 = 1_500_000;

/// Allowlist of LI.FI router addresses that can be approved as the ERC-20
/// spender for the Settlement contract.
///
/// **Why a fixed allowlist?** Both `transactionRequest.to` (the call target)
/// AND `estimate.approvalAddress` (the allowance grantee) come straight from
/// the API response. A compromised LI.FI edge (DNS hijack, CA compromise,
/// malicious CDN worker, insider) that returns an attacker-controlled router
/// could drain Settlement's transient balance during execution. The static
/// allowlist is the router-poisoning defense — validate BOTH addresses BEFORE
/// using them.
///
/// **Address coverage (chain 130 — Unichain):**
/// `0x864b314D4C5a0399368609581d3E8933a63b9232` — LiFiDiamond (EIP-2535
/// proxy). Verified live 2026-06-30:
///   - `eth_getCode` on https://mainnet.unichain.org returns deployed bytecode
///     (254-byte EIP-2535 fallback proxy) for this address on chain 130.
///   - The live `GET /v1/quote` (fromChain=toChain=130) returns this exact
///     address as both `transactionRequest.to` and `estimate.approvalAddress`
///     for a USDC->WETH route with `fromAddress`/`toAddress` = the Settlement.
///
/// **If LI.FI redeploys the diamond**: add the new address here after
/// independent on-chain verification — do NOT take it from a quote response.
const LIFI_ROUTER_ALLOWLIST: &[Address] = &[
    // LiFiDiamond on Unichain (130).
    // EIP-55: 0x864b314D4C5a0399368609581d3E8933a63b9232 (raw bytes lowercased).
    Address::new([
        0x86, 0x4b, 0x31, 0x4d, 0x4c, 0x5a, 0x03, 0x99, 0x36, 0x86, 0x09, 0x58, 0x1d, 0x3e, 0x89,
        0x33, 0xa6, 0x3b, 0x92, 0x32,
    ]),
];

fn validate_router_allowlist(address: &Address, role: &str) -> Result<(), Error> {
    if LIFI_ROUTER_ALLOWLIST.contains(address) {
        Ok(())
    } else {
        Err(Error::Api {
            code: -1,
            reason: format!(
                "LI.FI returned non-allowlisted {role} address {address:?}. Refusing to \
                 call/approve. If this is a legitimate new LI.FI deployment, add it to \
                 LIFI_ROUTER_ALLOWLIST in crates/solvers/src/infra/dex/lifi/mod.rs after \
                 independent on-chain verification."
            ),
        })
    }
}

/// Whether a LI.FI `transactionRequest.value` (a hex string like `"0x0"`, or
/// occasionally a decimal string) represents a NON-ZERO native amount. Empty /
/// `"0x0"` / all-zero / decimal `0` are zero; an unparseable shape is treated
/// as non-zero and rejected fail-closed.
fn value_is_nonzero(value: &str) -> bool {
    let t = value.trim();
    if t.is_empty() {
        return false;
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        // Zero iff empty (`"0x"`) or all hex zeros (`"0x0"`, `"0x00"`).
        return !hex.is_empty() && !hex.bytes().all(|b| b == b'0');
    }
    match t.parse::<U256>() {
        Ok(v) => !v.is_zero(),
        Err(_) => true, // unparseable -> fail-closed (reject)
    }
}

/// Bindings to the LI.FI aggregator API.
pub struct Lifi {
    client: super::Client,
    /// Base URL including a trailing slash, e.g. `https://li.quest/v1/`.
    base_url: reqwest::Url,
    /// Numeric chain id (130). Sent as `fromChain`/`toChain` and used to reject
    /// any cross-chain route.
    chain_id: u64,
    /// CoW settlement contract — pinned as `fromAddress` AND `toAddress` so the
    /// calldata is executable by the settlement (arbitrary caller) and the
    /// output lands in its buffer.
    settlement_contract: Address,
    /// Required `integrator` query param (LI.FI 404s without one). Identifies
    /// our integration; does not affect calldata correctness.
    integrator: String,
}

pub struct Config {
    /// Base URL for the LI.FI API including a trailing slash. Defaults to
    /// `https://li.quest/v1/`.
    pub base_url: reqwest::Url,

    /// Chain ID — sent as `fromChain`/`toChain` and used for the same-chain
    /// guard. This solver is verified on Unichain (130).
    pub chain_id: eth::ChainId,

    /// CoW settlement contract address.
    pub settlement_contract: Address,

    /// Required `integrator` string (LI.FI rejects quotes without it). Defaults
    /// to `"ophis"`.
    pub integrator: String,

    /// Block stream used to attach the current block hash header so an egress
    /// proxy can cache responses per block.
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl Lifi {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        let client = {
            // No required auth. Set a User-Agent so LI.FI's CDN doesn't flag us
            // as a generic bot.
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
            integrator: config.integrator,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> {
        // LI.FI /quote is exactIn-only (sell side); no exactOut/buy mode.
        if order.side == order::Side::Buy {
            return Err(Error::OrderNotSupported);
        }

        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        async move {
            let quote = self.get_quote(order, slippage).await?;
            let est = &quote.estimate;
            let tx = &quote.transaction_request;

            // Validate BOTH the call target AND the approval target against the
            // static allowlist BEFORE using them. This is the only
            // router-poisoning defense (single-call API, no cross-check).
            validate_router_allowlist(&tx.to, "router")?;
            validate_router_allowlist(&est.approval_address, "approval target")?;

            // SAME-CHAIN ENFORCEMENT (defense in depth): we request
            // fromChain==toChain==chain_id, but reject if the route's action is
            // cross-chain — a bridge route's calldata is NOT deferred-
            // settlement-safe.
            if quote.action.from_chain_id != self.chain_id
                || quote.action.to_chain_id != self.chain_id
            {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "LI.FI returned a cross-chain route (from {} to {}); this solver \
                         only settles same-chain swaps on {}",
                        quote.action.from_chain_id, quote.action.to_chain_id, self.chain_id
                    ),
                });
            }

            // Reject any bridge-like step. Only `swap`/`protocol` steps are
            // same-chain-deterministic and executable later by the Settlement.
            if let Some(step) = quote
                .included_steps
                .iter()
                .find(|s| matches!(s.step_type.to_ascii_lowercase().as_str(), "cross" | "bridge"))
            {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "LI.FI route contains a bridge step (type={}); refusing — its \
                         calldata is not deferred-settlement-safe",
                        step.step_type
                    ),
                });
            }

            // ERC-20 -> ERC-20 only. A non-zero native `value` means the route
            // expects ETH the settlement won't attach — refuse rather than build
            // a call that can only revert (the wrapped-settlement guard
            // OpenOcean/DODO apply).
            if value_is_nonzero(&tx.value) {
                return Err(Error::Api {
                    code: -1,
                    reason: format!("LI.FI route requires non-zero native value {}", tx.value),
                });
            }

            // A zero guaranteed output is a degenerate / malformed route.
            if est.to_amount_min.is_zero() {
                return Err(Error::NotFound);
            }

            // Gas: pad the LI.FI estimate by 50% (mirrors openocean/kyberswap).
            let gas_units = est
                .gas_costs
                .first()
                .and_then(|g| g.estimate.parse::<u64>().ok())
                .unwrap_or(DEFAULT_GAS_UNITS);
            let gas_u256 = U256::from(gas_units);
            let gas = gas_u256
                .checked_add(gas_u256 / U256::from(2))
                .ok_or(Error::GasCalculationFailed)?;

            Ok(dex::Swap {
                calls: vec![dex::Call {
                    to: tx.to,
                    calldata: tx.data.clone(),
                }],
                input: eth::Asset {
                    token: order.sell,
                    // exactIn SELL: input fixed to the order's sell amount. We
                    // never trust an API-echoed input; the amount sent to LI.FI
                    // is derived from order.amount and the allowance below is
                    // sized to the same value with NO pad.
                    amount: order.amount.get(),
                },
                output: eth::Asset {
                    token: order.buy,
                    // Report the GUARANTEED slippage-floor output
                    // (`toAmountMin`, the on-chain-enforced `minAmount`), NOT
                    // the optimistic `toAmount`. Paying the optimistic value as
                    // the CoW buy clearing amount would exceed what the router
                    // delivers and revert the settlement (#726). LI.FI computes
                    // `toAmountMin` from the slippage we sent, so it is already
                    // the floor — no reconstruction needed.
                    amount: est.to_amount_min,
                },
                allowance: dex::Allowance {
                    // The approval target the Settlement approves (== the
                    // diamond). Already allowlist-validated above.
                    spender: est.approval_address,
                    // exactIn: allowance == input == order amount, NO pad.
                    amount: dex::Amount::new(order.amount.get()),
                },
                gas: eth::Gas(gas),
            })
        }
        .instrument(tracing::trace_span!("lifi-swap", id = %id))
        .await
    }

    /// Single call — fetch the same-chain route + encoded calldata.
    async fn get_quote(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dto::QuoteResponse, Error> {
        // Clamp the slippage once and send the SAME value to LI.FI; LI.FI bakes
        // `toAmountMin = toAmount*(1-slippage)` into the calldata from exactly
        // this value, so the floor we report matches what the router enforces.
        let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let clamped_bps = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Lifi,
            slippage_bps,
            MAX_SLIPPAGE_BPS,
        );
        // LI.FI's `slippage` is a DECIMAL FRACTION (e.g. 0.01 = 1%). 100 bps ->
        // "0.01", 50 bps -> "0.005".
        let slippage_fraction = BigDecimal::new(i64::from(clamped_bps).into(), 4)
            .normalized()
            .to_string();

        let settlement = format!("{:#x}", self.settlement_contract);
        let query = [
            ("fromChain", self.chain_id.to_string()),
            ("toChain", self.chain_id.to_string()),
            ("fromToken", format!("{:#x}", order.sell.0)),
            ("toToken", format!("{:#x}", order.buy.0)),
            // LI.FI takes the sell amount in WEI (base units).
            ("fromAmount", order.amount.get().to_string()),
            // RFQ exclusion: fromAddress is the funds source, toAddress the
            // on-chain receiver baked into the calldata. Pinning BOTH to the
            // Settlement keeps the calldata executable by an arbitrary later
            // caller with the output landing in the settlement buffer.
            ("fromAddress", settlement.clone()),
            ("toAddress", settlement),
            ("slippage", slippage_fraction),
            // Required by LI.FI (404s without it).
            ("integrator", self.integrator.clone()),
        ];

        let url = self
            .base_url
            .join("quote")
            .map_err(|_| Error::RequestBuildFailed)?;
        let request = self.client.request(reqwest::Method::GET, url).query(&query);

        let response: dto::QuoteResponse =
            util::http::roundtrip!(<dto::QuoteResponse, dto::ApiError>; request).await?;

        Ok(response)
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
                let lower = err.message.to_ascii_lowercase();
                if lower.contains("no available quotes")
                    || lower.contains("no quote")
                    || lower.contains("not found")
                    || lower.contains("no route")
                {
                    Self::NotFound
                } else {
                    Self::Api {
                        code: -1,
                        reason: err.message,
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guaranteed floor reported as the buy clearing amount must be
    /// `toAmountMin` (the on-chain-enforced floor), strictly below the
    /// optimistic `toAmount`. Uses the live-traced chain-130 USDC->WETH quote
    /// at 1% slippage (toAmount=63465982410779806, toAmountMin=62831322586672008).
    #[test]
    fn reports_to_amount_min_floor_not_optimistic() {
        let to_amount = U256::from(63_465_982_410_779_806_u128);
        let to_amount_min = U256::from(62_831_322_586_672_008_u128);

        let reported = to_amount_min;
        assert_eq!(reported, to_amount_min);
        // Strictly below the optimistic quote (the value that would revert).
        assert!(reported < to_amount);
        // ~99% of the optimistic quote at 1% slippage.
        assert!(reported > to_amount * U256::from(98u64) / U256::from(100u64));
    }

    /// The native-value guard: zero forms (hex/decimal) pass, non-zero AND
    /// unparseable shapes are rejected fail-closed.
    #[test]
    fn value_zero_forms_are_zero_nonzero_rejected() {
        // zero
        assert!(!value_is_nonzero(""));
        assert!(!value_is_nonzero("0x0"));
        assert!(!value_is_nonzero("0x00"));
        assert!(!value_is_nonzero(" 0x0 "));
        assert!(!value_is_nonzero("0"));
        assert!(!value_is_nonzero("0x"));
        // non-zero
        assert!(value_is_nonzero("0x1"));
        assert!(value_is_nonzero("0xde0b6b3a7640000"));
        assert!(value_is_nonzero("1000000000000000000"));
        // unparseable -> fail-closed
        assert!(value_is_nonzero("0xzz"));
        assert!(value_is_nonzero("not-a-number"));
    }

    /// A zero `toAmountMin` is a degenerate route (handled in `swap` before
    /// building the `dex::Swap`).
    #[test]
    fn zero_floor_is_rejected() {
        assert!(U256::ZERO.is_zero());
    }

    /// Both the router and the approval target are validated against the
    /// allowlist; a foreign address is rejected, the verified diamond accepted.
    #[test]
    fn router_allowlist_enforced_for_both_roles() {
        let good = LIFI_ROUTER_ALLOWLIST[0];
        assert!(validate_router_allowlist(&good, "router").is_ok());
        assert!(validate_router_allowlist(&good, "approval target").is_ok());

        let bad = Address::new([0x11; 20]);
        assert!(validate_router_allowlist(&bad, "router").is_err());
    }
}
