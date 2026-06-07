//! Bindings to the Velora (formerly ParaSwap) aggregator API.
//!
//! Velora's two-step flow is structurally similar to KyberSwap's:
//! 1. `GET  /prices`               — returns the best route and an opaque
//!    `priceRoute` blob, plus the router address (`contractAddress`).
//! 2. `POST /transactions/{chain}` — turns that `priceRoute` into encoded
//!    calldata + the `to` address.
//!
//! Differences vs. KyberSwap that mattered during integration:
//!
//! - **Default API version is v5**, which is deprecated. We pin
//!   `version=6.2` on every `/prices` call.
//! - The **`priceRoute` blob is HMAC-protected**: any mutation (re-serializing
//!   with different field order, dropping unknown fields) invalidates it. We
//!   pass it through as `serde_json::Value` to round-trip every byte.
//! - **`/transactions` requires `ignoreChecks=true`** when the `userAddress`
//!   is a smart contract (it is, in our case: CoW Settlement). Without it,
//!   Velora's preflight does an EOA-style `balanceOf` and returns 400.
//! - **`excludeRFQ=true`** on `/prices` — RFQ quotes from native market
//!   makers carry short-lived signed offers that expire before a CoW
//!   settlement is broadcast. We don't want them in the route.
//! - Router contract address is **the same on all supported chains** via
//!   CREATE2 vanity salt: `0x6a000f20005980200259b80c5102003040001068`.
//! - **API domain is still `api.paraswap.io`** despite the rebrand. The
//!   SDK constant has not changed; there's no redirect from
//!   `api.velora.xyz`.
//!
//! Full upstream docs: <https://developers.velora.xyz/api/velora-api>.

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

/// Default `partner` identifier sent on every request. Used by Velora for
/// analytics and partner-fee attribution. Free-tier (anonymous) is `"anon"`
/// — we use our own ID so volume rolls up against Ophis if/when we apply
/// for a Pro API key.
pub const DEFAULT_PARTNER: &str = "ophis";

/// Velora API version. v5 is deprecated; v6.2 is current as of 2026-05-16.
/// Pinned explicitly on every `/prices` call (the API default would
/// otherwise downgrade to v5).
pub const API_VERSION: &str = "6.2";

/// Maximum value Velora accepts for `slippage` in bps. The API accepts up
/// to 10000 (100%) but anything > 2000 (20%) is in routing-distortion
/// territory and almost certainly a misconfiguration on our side. We clamp
/// to 2000 to match the kyberswap solver's safety cap.
const MAX_SLIPPAGE_BPS: u16 = 2000;

/// Allowlist of Velora Augustus V6.2 router addresses that can be approved
/// as ERC-20 spender for the Settlement contract.
///
/// **Why a fixed allowlist?** The `contractAddress` returned by `/prices`
/// is trusted as an unlimited-allowance grantee — a compromised Velora
/// edge (DNS hijack, CA compromise, malicious CDN worker, insider) that
/// returns an attacker-controlled router can drain Settlement's transient
/// balance during execution. The per-request equality check between the
/// `/prices` and `/transactions` router (below) catches only intra-request
/// inconsistency, not a fully poisoned response. Pinning to a static
/// hardcoded allowlist closes the larger window.
///
/// **Address coverage:** Velora deploys Augustus V6.2 at the same
/// CREATE2-deterministic address on every chain they support (note the
/// vanity leading `6a` and trailing `0068` — that's salt-mined, not
/// coincidence). Independently verified on Ethereum, Optimism, Base,
/// Arbitrum, Polygon explorers via etherscan-family.
///
/// **If Velora deploys a new router** (e.g. V7): add the new address here
/// after independent verification via the developer docs at
/// <https://developers.velora.xyz/augustus-swapper> — do NOT take it from
/// a `/prices` response.
const VELORA_ROUTER_ALLOWLIST: &[Address] = &[
    // Augustus V6.2 — same address on all 10 supported chains:
    //   Ethereum (1), Optimism (10), BSC (56), Gnosis (100),
    //   Unichain (130), Polygon (137), Sonic (146), Base (8453),
    //   Arbitrum (42161), Avalanche (43114).
    // Verified live 2026-05-16 via `cast code` on the chains we run
    // (Optimism: 49127 bytes) and via the upstream docs:
    // https://developers.velora.xyz/augustus-swapper/augustus-v6.2-smart-contracts
    Address::new([
        0x6a, 0x00, 0x0f, 0x20, 0x00, 0x59, 0x80, 0x20, 0x02, 0x59, 0xb8, 0x0c, 0x51, 0x02, 0x00,
        0x30, 0x40, 0x00, 0x10, 0x68,
    ]),
];

/// Chain IDs Velora deploys Augustus V6.2 on as of 2026-05-16.
///
/// Probed via `GET https://api.paraswap.io/tokens/{chainId}` on 2026-05-16
/// — unsupported chains return:
///   `{"error":"Invalid network. Supported chains: 1, 10, 56, 100, 130,
///    137, 146, 8453, 42161, 43114"}`
///
/// Notably **HyperEVM (999) is NOT in this list.** Solver `try_new` panics
/// if configured with chain 999 — fail-fast at startup is preferable to a
/// silent solver that returns 0 routes for every order.
const VELORA_SUPPORTED_CHAINS: &[u64] = &[1, 10, 56, 100, 130, 137, 146, 8453, 42161, 43114];

fn validate_router_allowlist(router: &Address) -> Result<(), Error> {
    if VELORA_ROUTER_ALLOWLIST.contains(router) {
        Ok(())
    } else {
        Err(Error::Api {
            code: -1,
            reason: format!(
                "Velora returned non-allowlisted router address {router:?}. \
                Refusing to approve allowance. If this is a legitimate new \
                Velora router, add it to VELORA_ROUTER_ALLOWLIST in \
                crates/solvers/src/infra/dex/velora/mod.rs after independent \
                verification via the developer docs."
            ),
        })
    }
}

/// The Velora `/prices` + `/transactions` `side` parameter for a CoW order
/// side. SELL = exactIn, BUY = exactOut.
fn velora_side(side: order::Side) -> &'static str {
    match side {
        order::Side::Sell => "SELL",
        order::Side::Buy => "BUY",
    }
}

/// Assemble the validated [`dex::Swap`] from a Velora `priceRoute` and the
/// built calldata. Pure (no I/O) so the side-dependent exactIn/exactOut
/// invariants are unit-testable without the live API.
///
/// **Buffer-siphon defense (audit 2026-05-21, mirrors KyberSwap).** Both
/// `src_amount` and `dest_amount` come from Velora's API and are fully
/// attacker-controlled if an edge is compromised (DNS hijack, CA compromise,
/// malicious CDN worker). We pin the order's FIXED side against
/// `order.amount`:
///
/// - **SELL (exactIn):** the input is fixed. Pin `src_amount == order.amount`
///   and grant an allowance of exactly `src_amount` — the router can never
///   pull more than the user is selling, so it can't reach Settlement's
///   transient buffer balance.
/// - **BUY (exactOut):** the output is fixed. Pin `dest_amount ==
///   order.amount`. The input is intrinsically variable, so we grant a
///   bounded allowance of `src_amount * (1 + slippage)` (the same max-input
///   Velora bakes into the calldata) — NOT an unbounded `U256::MAX` (the
///   anti-pattern OKX's buy path uses). An inflated `src_amount` from a
///   poisoned edge is still bounded downstream: the framework's
///   [`dex::Swap::satisfies`] rejects any solution whose input exceeds the
///   user's signed max-sell (`order.sell.amount`), and the on-chain
///   settlement reverts if the executed input breaches that limit.
fn build_swap(
    order: &dex::Order,
    slippage: &dex::Slippage,
    prices: &dto::PriceRoute,
    router: Address,
    calldata: Vec<u8>,
) -> Result<dex::Swap, Error> {
    // Parse gas as decimal string. /transactions returns no `gas` when
    // `ignoreChecks=true` is set (which we always do because the user is a
    // smart contract), so use the /prices estimate (`gasCost`). Pad by 50%
    // to mirror the kyberswap convention.
    let gas_estimate: u64 = prices
        .gas_cost
        .trim()
        .parse::<u64>()
        .map_err(|_| Error::GasCalculationFailed)?;
    let gas_u256 = U256::from(gas_estimate);
    let gas = gas_u256
        .checked_add(gas_u256 / U256::from(2))
        .ok_or(Error::GasCalculationFailed)?;

    // Pin the fixed side against the order amount, then size the COMMITTED
    // INPUT. This single value is used for BOTH the solution's modeled input
    // (what the user is charged, via `into_dex_solution`) AND the ERC-20
    // allowance granted to the router. Keeping them equal is the exactOut
    // safety invariant: the user is charged exactly the maximum the router
    // can pull, so a compromised API consuming the full approval skims only
    // from what the user already committed (bounded by their signed max-sell),
    // never from Settlement's shared transient buffer.
    let committed_input = match order.side {
        order::Side::Sell => {
            if prices.src_amount != order.amount.get() {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "/prices returned src_amount {:?}, expected exactIn order \
                         amount {:?}",
                        prices.src_amount,
                        order.amount.get()
                    ),
                });
            }
            // exactIn: the input is fixed; allowance == input == order amount.
            prices.src_amount
        }
        order::Side::Buy => {
            if prices.dest_amount != order.amount.get() {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "/prices returned dest_amount {:?}, expected exactOut order \
                         amount {:?}",
                        prices.dest_amount,
                        order.amount.get()
                    ),
                });
            }
            if prices.src_amount.is_zero() {
                // A zero input for a non-zero output is a degenerate /
                // malformed route — refuse rather than model a 0 input.
                return Err(Error::NotFound);
            }
            // exactOut: the router pulls *up to* the slippage-padded max
            // input Velora bakes into the calldata. We model the user's
            // charge AND the allowance at that same max (`slippage.add`
            // div_ceils the tolerance so it never under-covers and the swap
            // can't revert for insufficient allowance). Positive slippage
            // between quote and settlement accrues to the protocol buffer
            // rather than the user — the conservative exactOut model that
            // keeps the buffer out of the trust path. Bounded by the order
            // limit price via `Swap::satisfies` / `allowance_within_sell_limit`.
            slippage.add(prices.src_amount)
        }
    };

    Ok(dex::Swap {
        calls: vec![dex::Call {
            to: router,
            calldata,
        }],
        input: eth::Asset {
            token: order.sell,
            amount: committed_input,
        },
        output: eth::Asset {
            token: order.buy,
            amount: prices.dest_amount,
        },
        allowance: dex::Allowance {
            spender: router,
            amount: dex::Amount::new(committed_input),
        },
        gas: eth::Gas(gas),
    })
}

/// Bindings to the Velora aggregator API.
pub struct Velora {
    client: super::Client,
    base_url: reqwest::Url,
    chain_id: u64,
    settlement_contract: Address,
    partner: String,
    partner_address: Option<Address>,
    partner_fee_bps: Option<u32>,
}

pub struct Config {
    /// Base URL for the Velora API (no chain suffix — chain is encoded in
    /// the request body). Defaults to `https://api.paraswap.io/`.
    pub base_url: reqwest::Url,

    /// Chain ID — used for the `network` query param and the
    /// `/transactions/{network}` path.
    pub chain_id: eth::ChainId,

    /// CoW settlement contract address — used as `userAddress` (sender) and
    /// `receiver` when building the swap.
    pub settlement_contract: Address,

    /// Velora `partner` identifier. Defaults to [`DEFAULT_PARTNER`].
    pub partner: Option<String>,

    /// Optional partner-fee recipient address. If set, Velora skims
    /// `partner_fee_bps` bps of the destination token to this address.
    /// Must be set together with `partner_fee_bps`.
    pub partner_address: Option<Address>,

    /// Optional partner-fee in basis points. Capped by Velora at 200 bps
    /// in Delta-intent context; uncapped in regular swaps but anything
    /// > 100 bps eats routing competitiveness.
    pub partner_fee_bps: Option<u32>,

    /// Block stream used to attach the current block hash header so an
    /// egress proxy can cache responses per block.
    pub block_stream: Option<CurrentBlockWatcher>,
}

impl Velora {
    pub fn try_new(config: Config) -> Result<Self, CreationError> {
        // Fail fast on unsupported chains. The solver is useless on
        // chains where Velora doesn't run — better to refuse startup than
        // burn auction slots returning NotFound.
        //
        // `ChainId` is a #[repr]-less enum with explicit discriminants
        // (1=Mainnet, 10=Optimism, …, 999=HyperEvm). `as u64` returns the
        // discriminant directly, matching VELORA_SUPPORTED_CHAINS.
        let chain_id = config.chain_id as u64;
        if !VELORA_SUPPORTED_CHAINS.contains(&chain_id) {
            return Err(CreationError::UnsupportedChain(chain_id));
        }

        // Partner-fee config: address and bps must be set together (else
        // Velora ignores the partial config silently — surprising for the
        // operator). Refuse a half-configured fee at startup.
        match (config.partner_address, config.partner_fee_bps) {
            (Some(_), None) | (None, Some(_)) => {
                return Err(CreationError::PartialPartnerFee);
            }
            _ => {}
        }

        let client = {
            // No required auth headers. We do set a User-Agent so Velora's
            // CDN doesn't flag us as a generic bot.
            let client = reqwest::Client::builder()
                .user_agent("ophis-solver/1.0")
                .build()?;
            super::Client::new(client, config.block_stream)
        };

        Ok(Self {
            client,
            base_url: config.base_url,
            chain_id,
            settlement_contract: config.settlement_contract,
            partner: config.partner.unwrap_or_else(|| DEFAULT_PARTNER.to_string()),
            partner_address: config.partner_address,
            partner_fee_bps: config.partner_fee_bps,
        })
    }

    pub async fn swap(
        &self,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dex::Swap, Error> {
        // Velora v6.2 supports both SELL (exactIn) and BUY (exactOut).
        // SELL pins the input (`srcAmount`) and lets `slippage` reduce the
        // guaranteed output; BUY pins the output (`destAmount`) and lets
        // `slippage` raise the max input. The side-dependent invariants
        // (which amount is pinned, how the allowance is sized) live in the
        // pure `build_swap` below. Unlike OKX/KyberSwap — which reject BUY
        // because their wrapped APIs are exactIn-only — Velora's API
        // genuinely serves exactOut, so we support it here. Funds are
        // bounded downstream: the framework's `Swap::satisfies` rejects any
        // solution whose input exceeds the user's signed max-sell, and
        // `Swap::allowance_within_sell_limit` caps the approval at that
        // limit so the slippage-padded BUY allowance can't reach the
        // Settlement buffer.

        // BUY + direct partner-fee skim is not yet net-output verified: the
        // partner fee is taken from the destination token, so Velora's
        // exactOut `destAmount` may be quoted GROSS of the fee, leaving the
        // settlement short of the pinned output. Partner fee is disabled on
        // OP (the only chain with exactOut enabled), so reject this combo
        // until it has a dedicated test rather than risk a net-vs-gross
        // shortfall on a live settlement.
        if order.side == order::Side::Buy && self.partner_fee_bps.is_some() {
            return Err(Error::OrderNotSupported);
        }

        // Tracing span — correlate /prices and /transactions calls on a
        // shared request id.
        static ID: AtomicU64 = AtomicU64::new(0);
        let id = ID.fetch_add(1, atomic::Ordering::Relaxed);

        async move {
            let prices = self.get_prices(order).await?;
            let prices_router = prices.contract_address;

            // M1 hardening: validate the router BEFORE making the
            // /transactions call. Fail fast on a poisoned `/prices`
            // response so we don't bake an attacker-controlled spender
            // into the settlement calldata.
            validate_router_allowlist(&prices_router)?;

            // v6.2 unified router and tokenTransferProxy. If a future
            // version diverges and the proxy points elsewhere, the
            // settlement contract's approval would target the wrong
            // address and the swap would fail at execution. Refuse
            // here instead.
            if prices.token_transfer_proxy != prices_router {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "Velora /prices reported a separate tokenTransferProxy \
                         {:?} from contractAddress {prices_router:?} — this \
                         solver only supports v6.2 where the two are unified. \
                         If Velora has shipped v7 with a split proxy, update \
                         VELORA_ROUTER_ALLOWLIST and revise the allowance \
                         spender path.",
                        prices.token_transfer_proxy
                    ),
                });
            }

            // Validate dest amount against quoted USD value when both are
            // present. A grossly mismatched destUSD/srcUSD ratio signals
            // a stale or corrupt route — kyberswap doesn't have this
            // check but Velora exposes USD values we can sanity-bound.
            // We don't enforce a tight ratio (oracle vs route can
            // legitimately drift) — only refuse zero amounts.
            if prices.dest_amount.is_zero() {
                return Err(Error::NotFound);
            }

            let tx = self.build_transaction(&prices, order, slippage).await?;

            // Step 2 should return the same router as step 1. Treat a
            // mismatch as API misbehavior.
            if tx.to != prices_router {
                return Err(Error::Api {
                    code: -1,
                    reason: format!(
                        "router address mismatch between /prices ({prices_router:?}) \
                         and /transactions ({:?})",
                        tx.to
                    ),
                });
            }

            // Pure assembly + side-dependent integrity checks. Extracted so
            // the exactIn vs exactOut invariants are unit-testable without
            // hitting the live API.
            build_swap(order, slippage, &prices, prices_router, tx.data)
        }
        .instrument(tracing::trace_span!("velora-swap", id = %id))
        .await
    }

    /// Step 1 — fetch the best `priceRoute` from `/prices`.
    async fn get_prices(&self, order: &dex::Order) -> Result<dto::PriceRoute, Error> {
        let mut query = vec![
            ("srcToken", format!("{:#x}", order.sell.0.0)),
            ("destToken", format!("{:#x}", order.buy.0.0)),
            // `amount` is denominated in the FIXED side's token: source
            // units for SELL (exactIn), destination units for BUY
            // (exactOut). `order.amount` already follows this convention
            // (`dex::Order::new` picks sell.amount for SELL, buy.amount
            // for BUY), so the same line serves both sides.
            ("amount", order.amount.get().to_string()),
            ("side", velora_side(order.side).to_string()),
            ("network", self.chain_id.to_string()),
            ("version", API_VERSION.to_string()),
            // CoW Settlement is a smart contract — Velora's default
            // EOA-style balance preflight would 400. We don't use the
            // priceRoute's `userAddress` for the build step.
            ("userAddress", format!("{:#x}", self.settlement_contract)),
            // RFQ routes carry signed off-chain quotes that expire fast.
            // A CoW solver signs and submits later — RFQ would routinely
            // revert. Exclude.
            ("excludeRFQ", "true".to_string()),
            ("partner", self.partner.clone()),
        ];

        if let (Some(addr), Some(bps)) = (self.partner_address, self.partner_fee_bps) {
            query.push(("partnerAddress", format!("{addr:#x}")));
            query.push(("partnerFeeBps", bps.to_string()));
        }

        let url = self
            .base_url
            .join("prices/")
            .map_err(|_| Error::RequestBuildFailed)?;
        let request = self.client.request(reqwest::Method::GET, url).query(&query);

        let response: dto::PricesResponse =
            util::http::roundtrip!(<dto::PricesResponse, dto::ApiError>; request).await?;

        // Velora returns 200 + `priceRoute: null` for un-routable pairs.
        // Also surface their explicit error envelope here.
        if let Some(err) = response.error {
            return Err(Self::classify_error(&err));
        }

        response.price_route.ok_or(Error::NotFound)
    }

    /// Step 2 — build the calldata for the `priceRoute` returned in step 1.
    async fn build_transaction(
        &self,
        prices: &dto::PriceRoute,
        order: &dex::Order,
        slippage: &dex::Slippage,
    ) -> Result<dto::TransactionResponse, Error> {
        let slippage_bps = slippage.as_bps().ok_or(Error::InvalidSlippage)?;
        let slippage_clamped = crate::infra::metrics::clamp_slippage_bps(
            crate::infra::metrics::Dex::Velora,
            slippage_bps,
            MAX_SLIPPAGE_BPS,
        );

        // `/transactions` takes `srcAmount` XOR `destAmount` — the fixed
        // side. For SELL pin the input; for BUY pin the output and let
        // Velora derive the slippage-padded max input.
        let (src_amount, dest_amount) = match order.side {
            order::Side::Sell => (Some(order.amount.get()), None),
            order::Side::Buy => (None, Some(order.amount.get())),
        };

        let body = dto::TransactionRequest {
            src_token: order.sell.0,
            src_decimals: prices.src_decimals,
            dest_token: order.buy.0,
            dest_decimals: prices.dest_decimals,
            src_amount,
            dest_amount,
            slippage: slippage_clamped as u32,
            user_address: self.settlement_contract,
            receiver: self.settlement_contract,
            partner: self.partner.clone(),
            partner_address: self.partner_address,
            partner_fee_bps: self.partner_fee_bps,
            // Settlement contract has no claim infra — bake the fee
            // transfer into the swap tx itself so the Safe receives the
            // partner-fee atomically.
            is_direct_fee_transfer: self.partner_fee_bps.is_some(),
            take_surplus: false,
            price_route: prices.raw.clone(),
        };

        // `ignoreChecks=true` is REQUIRED when userAddress is a smart
        // contract. Without it Velora 400s with
        // "Not enough <token> balance".
        let url = self
            .base_url
            .join(&format!("transactions/{}?ignoreChecks=true", self.chain_id))
            .map_err(|_| Error::RequestBuildFailed)?;

        let request = self
            .client
            .request(reqwest::Method::POST, url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body);

        let response: dto::TransactionApiResponse =
            util::http::roundtrip!(<dto::TransactionApiResponse, dto::ApiError>; request).await?;

        match response {
            dto::TransactionApiResponse::Success(tx) => Ok(tx),
            dto::TransactionApiResponse::Error(err) => Err(Self::classify_error(&err)),
        }
    }

    /// Map Velora error responses to the [`Error`] taxonomy.
    fn classify_error(err: &dto::ApiError) -> Error {
        // Velora's error envelope is `{"error": "...string..."}`. We
        // pattern-match the message text for the common stable cases —
        // less robust than a code-based mapping but Velora's API is
        // string-based for these.
        let msg = err.error.as_str();
        if msg.contains("No routes found")
            || msg.contains("Invalid token")
            || msg.contains("not available for trading")
        {
            return Error::NotFound;
        }
        if msg.contains("rate limit") || msg.contains("Too Many Requests") {
            return Error::RateLimited;
        }
        if msg.contains("rate has changed") {
            return Error::RateChanged;
        }
        Error::Api {
            code: -1,
            reason: err.error.clone(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CreationError {
    #[error(
        "Velora does not support chain id {0}. Supported: 1, 10, 56, 100, 130, 137, 146, 8453, \
         42161, 43114. Verify upstream support before adding to VELORA_SUPPORTED_CHAINS."
    )]
    UnsupportedChain(u64),
    #[error(
        "partner-fee partially configured — set either both partnerAddress and partnerFeeBps, or \
         neither"
    )]
    PartialPartnerFee,
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
    #[error(
        "priceRoute became stale between /prices and /transactions — caller should retry from \
         /prices"
    )]
    RateChanged,
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
            util::http::RoundtripError::Api(err) => Self::classify_error(&err),
        }
    }
}

// Helper so `From<RoundtripError>` can reuse the message classifier as a
// free function.
impl Error {
    fn classify_error(err: &dto::ApiError) -> Self {
        Velora::classify_error(err)
    }
}

#[cfg(test)]
mod build_swap_tests {
    use {
        super::*,
        crate::domain::{dex::Amount, dex::Order, dex::Slippage, eth::TokenAddress, order::Side},
        alloy::primitives::{address, U256},
    };

    const ROUTER: Address = address!("0x6a000f20005980200259b80c5102003040001068");
    // USDC.e / native-USDC on OP (6 decimals).
    const USDC: Address = address!("0x0b2c639c533813f4aa9d7837caf62653d097ff85");
    // WETH on OP (18 decimals).
    const WETH: Address = address!("0x4200000000000000000000000000000000000006");

    /// Construct a `dto::PriceRoute` fixture. `raw` is irrelevant to
    /// `build_swap` (it's only echoed to `/transactions`, which runs
    /// before this function), so `Null` is fine.
    fn price_route(src_amount: U256, dest_amount: U256) -> dto::PriceRoute {
        dto::PriceRoute {
            src_amount,
            src_decimals: 6,
            dest_amount,
            dest_decimals: 18,
            contract_address: ROUTER,
            token_transfer_proxy: ROUTER,
            gas_cost: "150000".to_string(),
            raw: serde_json::Value::Null,
        }
    }

    fn order(side: Side, sell: Address, buy: Address, amount: U256) -> Order {
        Order {
            sell: TokenAddress(sell),
            buy: TokenAddress(buy),
            side,
            amount: Amount::new(amount),
            owner: address!("0x0494f503912c101bfd76b88e4f5d8a33de284d1a"),
        }
    }

    // --- SELL (exactIn): input is pinned, allowance is exact ---

    #[test]
    fn sell_pins_src_and_grants_exact_allowance() {
        let sell_amount = U256::from(100_000_000_000_000_000_u128); // 0.1 WETH
        let dest_out = U256::from(180_000_000_u128); // 180 USDC
        let o = order(Side::Sell, WETH, USDC, sell_amount);
        let p = price_route(sell_amount, dest_out);

        let swap = build_swap(&o, &Slippage::one_percent(), &p, ROUTER, vec![]).unwrap();

        assert_eq!(swap.input.token, o.sell);
        assert_eq!(swap.input.amount, sell_amount);
        assert_eq!(swap.output.token, o.buy);
        assert_eq!(swap.output.amount, dest_out);
        assert_eq!(swap.allowance.spender, ROUTER);
        // Input is fixed → allowance is exactly the input, no slippage pad.
        assert_eq!(swap.allowance.amount.get(), sell_amount);
    }

    #[test]
    fn sell_rejects_src_mismatch() {
        let sell_amount = U256::from(100_000_000_000_000_000_u128);
        let o = order(Side::Sell, WETH, USDC, sell_amount);
        // API returns a src_amount that doesn't match the exactIn order.
        let p = price_route(sell_amount + U256::from(1), U256::from(180_000_000_u128));

        let err = build_swap(&o, &Slippage::one_percent(), &p, ROUTER, vec![]).unwrap_err();
        assert!(matches!(err, Error::Api { .. }), "got {err:?}");
    }

    // --- BUY (exactOut): output is pinned, allowance is slippage-padded ---

    #[test]
    fn buy_pins_dest_and_grants_slippage_padded_allowance() {
        let buy_amount = U256::from(45_900_000_000_000_000_u128); // 0.0459 WETH out
        let src_in = U256::from(74_764_580_u128); // ~74.76 USDC in
        // Buy WETH paying USDC: sell=USDC, buy=WETH, amount=the WETH out.
        let o = order(Side::Buy, USDC, WETH, buy_amount);
        let p = price_route(src_in, buy_amount);

        let slippage = Slippage::one_percent();
        let swap = build_swap(&o, &slippage, &p, ROUTER, vec![]).unwrap();

        let max_src = slippage.add(src_in);
        assert_eq!(swap.input.token, o.sell);
        assert_eq!(swap.output.token, o.buy);
        assert_eq!(swap.output.amount, buy_amount);
        assert_eq!(swap.allowance.spender, ROUTER);
        // exactOut safety invariant: the modeled input (user charge) and the
        // allowance are BOTH the slippage-padded max input, and equal to each
        // other — so a full-approval pull can't reach the buffer. Both exceed
        // the raw estimate by the slippage pad.
        assert_eq!(swap.input.amount, max_src);
        assert_eq!(swap.allowance.amount.get(), max_src);
        assert_eq!(swap.input.amount, swap.allowance.amount.get());
        assert!(max_src > src_in);
    }

    #[test]
    fn buy_rejects_dest_mismatch() {
        let buy_amount = U256::from(45_900_000_000_000_000_u128);
        let o = order(Side::Buy, USDC, WETH, buy_amount);
        // API returns a dest_amount that doesn't match the exactOut order.
        let p = price_route(U256::from(74_764_580_u128), buy_amount - U256::from(1));

        let err = build_swap(&o, &Slippage::one_percent(), &p, ROUTER, vec![]).unwrap_err();
        assert!(matches!(err, Error::Api { .. }), "got {err:?}");
    }

    #[test]
    fn buy_rejects_zero_src() {
        let buy_amount = U256::from(45_900_000_000_000_000_u128);
        let o = order(Side::Buy, USDC, WETH, buy_amount);
        // Degenerate: zero input for a non-zero output.
        let p = price_route(U256::ZERO, buy_amount);

        let err = build_swap(&o, &Slippage::one_percent(), &p, ROUTER, vec![]).unwrap_err();
        assert!(matches!(err, Error::NotFound), "got {err:?}");
    }
}
