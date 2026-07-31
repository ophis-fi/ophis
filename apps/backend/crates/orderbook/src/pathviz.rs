//! Orderbook-side pathviz service: turns an order (quote-time or settled)
//! into a [`PathVizGraph`], renders it via the pure `pathviz` crate, and
//! serves both from small caches.
//!
//! Split of concerns:
//! - The pure `pathviz` crate does all layout + SVG emission (I/O-free, so a
//!   later wasm build stays possible). THIS module does the I/O: DB reads,
//!   token-symbol lookups, the settlement-receipt fetch, and the venue
//!   registry.
//! - Graph ASSEMBLY (quote-time and settled) is kept in pure, unit-tested
//!   functions here ([`build_quote_graph`], [`build_settled_graph`],
//!   [`classify_settlement`]). The async methods are thin adapters that
//!   gather inputs and call them.
//!
//! Owner decisions applied: quote-time discloses solver names only, no
//! venue column (22); dark cosmic default theme lives in the render crate
//! (23); the venue registry degrades unowned addresses to bare hex, never
//! fabricated labels (27).

use {
    alloy::{
        primitives::{Address, B256, U256, address, b256},
        sol_types::SolEvent as _,
    },
    model::pathviz::{
        Fee, PathVizGraph, PathVizImageConfig, PathVizLink, PathVizLinkKind, PathVizNode,
        PathVizNodeKind, PathVizSolverBid, Surplus, MAX_SOLVERS, MAX_VENUES,
    },
    std::{
        collections::{HashMap, HashSet},
        hash::{Hash, Hasher},
        path::Path,
        sync::Arc,
    },
    token_info::TokenInfoFetching,
};

/// `keccak256("Transfer(address,address,uint256)")`.
const TRANSFER_TOPIC: B256 =
    b256!("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");

/// GPv2 `Trade` event topic, taken from the contract binding rather than
/// hardcoded so it cannot drift from the deployed ABI. The settlement emits one
/// `Trade` per order in the batch, so the count of these logs is how we tell a
/// single-order settlement (venues are attributable to the requested order)
/// from a multi-order batch (they are not: see `classify_settlement`).
const TRADE_TOPIC: B256 = contracts::GPv2Settlement::GPv2Settlement::Trade::SIGNATURE_HASH;

/// The GPv2 settlement contract on the Ophis-operated chains. Transfers to
/// or from this address are the batch hub, not a venue (spec value).
pub const SETTLEMENT_CONTRACT: Address = address!("310784c7FCE12d578dA6f53460777bAc9718B859");

/// Which lifecycle stage a graph describes. Serialized in the endpoint
/// response `context` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VizContext {
    /// Quoted but not yet on-chain: solver names only, no venue column.
    QuotedOnly,
    /// The winning solution is being submitted.
    Executing,
    /// Settled on-chain: full venue column + surplus.
    Traded,
}

impl VizContext {
    pub fn as_str(self) -> &'static str {
        match self {
            VizContext::QuotedOnly => "quotedOnly",
            VizContext::Executing => "executing",
            VizContext::Traded => "traded",
        }
    }
}

/// A decoded ERC-20 `Transfer` from a settlement receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferLog {
    pub token: Address,
    pub from: Address,
    pub to: Address,
    pub value: U256,
}

/// What a settlement receipt yields for the venue column: the ERC-20 transfers
/// and the count of GPv2 `Trade` events (one per order in the batch).
struct ReceiptData {
    transfers: Vec<TransferLog>,
    trade_count: usize,
}


/// Settlement-counterparty registry, loaded from TOML.
///
/// The route column is an ALLOWLIST: a settlement counterparty is drawn only if
/// it is an approved `[venues]` entry. Everything else -- known aggregator
/// routers, downstream pools an aggregator internally hopped through, unknown
/// addresses, and every counterparty seen when the registry could not be loaded
/// -- is NOT drawn. This fails closed for the cases the registry can decide on
/// its own: a missing, malformed, or empty file draws nothing, and an unknown
/// address is never drawn. The route column can only ever name an address an
/// operator explicitly listed under `[venues]`, mirroring how the frontend
/// gates solver names through the display-alias layer.
///
/// The one gap it CANNOT close on its own: an address an operator wrongly lists
/// under `[venues]` is drawn even if it is a competitor. The in-file disjointness
/// check below rejects an address that is in both `[venues]` and `[routers]`, but
/// the authoritative router set is the driver's `custom_allowlist` in a different
/// crate, and cross-checking it at runtime would couple orderbook to the driver.
/// Keeping `[routers]` in sync with that list is therefore an operator
/// responsibility (see the ownership note in the venues file), not a guarantee
/// enforced here.
///
/// `[venues]` are real liquidity venues (AMM/PMM pools) that ARE drawn, each
/// with a human label.
///
/// `[routers]` are aggregator routers Ophis solvers call. Ophis routes THROUGH
/// them but they are competitors and are never drawn. Under the allowlist they
/// would be excluded anyway (they are not `[venues]`); the section is kept as
/// documentation AND as a load-time guardrail: an address may not appear in both
/// tables, so a known competitor already recorded here can never be promoted to
/// a drawn venue. On chains that settle exclusively through aggregator routers
/// (Optimism today) `[venues]` is empty, so the column is empty and the graph
/// degrades to solver -> out.
#[derive(Clone, Debug, Default)]
pub struct VenueRegistry {
    labels: HashMap<Address, String>,
    routers: HashSet<Address>,
}

impl VenueRegistry {
    /// Parse `[venues]` (address = "label", the drawn allowlist) and `[routers]`
    /// (address = "note", known aggregators kept out of the allowlist).
    /// Ownership of this file is assigned to infra ops (decision 27). Errors if
    /// an address is listed in both tables: a router must never be drawable.
    pub fn from_toml(src: &str) -> anyhow::Result<Self> {
        #[derive(serde::Deserialize)]
        struct Doc {
            #[serde(default)]
            venues: HashMap<String, String>,
            #[serde(default)]
            routers: HashMap<String, String>,
        }
        let parse_addr = |addr: &str| -> anyhow::Result<Address> {
            addr.parse()
                .map_err(|e| anyhow::anyhow!("venue key {addr:?} is not an address: {e}"))
        };
        let doc: Doc = toml::from_str(src)?;
        let mut labels = HashMap::new();
        for (addr, label) in doc.venues {
            labels.insert(parse_addr(&addr)?, label);
        }
        let mut routers = HashSet::new();
        for addr in doc.routers.keys() {
            let addr = parse_addr(addr)?;
            // A known aggregator router must never also be a drawable venue.
            if labels.contains_key(&addr) {
                anyhow::bail!("address {addr} is listed as both a [venues] entry and a [routers]; a router must never be drawable");
            }
            routers.insert(addr);
        }
        Ok(Self { labels, routers })
    }

    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let src = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("reading venue registry {}: {e}", path.display()))?;
        Self::from_toml(&src)
    }

    /// The approved label for a drawable venue, or `None` when the address is
    /// not an allowlisted `[venues]` entry. This is the ONLY draw predicate: an
    /// address absent from `[venues]` (a router, a downstream pool, an unknown,
    /// or anything at all when the registry failed to load) is never drawn.
    pub fn labeled_venue(&self, address: Address) -> Option<String> {
        self.labels.get(&address).cloned()
    }

    /// The registry label, or the checksummed bare address as a fallback.
    pub fn label_for(&self, address: Address) -> String {
        self.labels
            .get(&address)
            .cloned()
            .unwrap_or_else(|| address.to_string())
    }

    /// True when the address is a known aggregator router: a competitor Ophis
    /// routes through, never drawn as a route hop or named in public copy.
    pub fn is_router(&self, address: Address) -> bool {
        self.routers.contains(&address)
    }

    /// Count of known aggregator routers (documented, for the startup log).
    pub fn router_count(&self) -> usize {
        self.routers.len()
    }

    pub fn len(&self) -> usize {
        self.labels.len()
    }

    pub fn is_empty(&self) -> bool {
        self.labels.is_empty()
    }
}

/// Short `0x1234…abcd` form for solver/label fallbacks.
fn short_address(a: Address) -> String {
    let s = a.to_string();
    if s.len() > 12 {
        format!("{}…{}", &s[..6], &s[s.len() - 4..])
    } else {
        s
    }
}

/// Insert a decimal point into an atom string given `decimals`, trimming to
/// at most 4 fractional digits. Best-effort display only; the atom string
/// remains the source of truth.
pub fn format_atoms(atoms: &str, decimals: u8, symbol: &str) -> String {
    let decimals = decimals as usize;
    let digits: String = atoms.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return format!("0 {symbol}");
    }
    let value = if decimals == 0 {
        digits
    } else if digits.len() <= decimals {
        let frac = format!("{:0>width$}", digits, width = decimals);
        let frac = &frac[..decimals];
        let trimmed = frac.trim_end_matches('0');
        if trimmed.is_empty() {
            "0".to_string()
        } else {
            format!("0.{}", &trimmed[..trimmed.len().min(4)])
        }
    } else {
        let split = digits.len() - decimals;
        let int = &digits[..split];
        let frac = &digits[split..];
        let frac = frac.trim_end_matches('0');
        if frac.is_empty() {
            int.to_string()
        } else {
            format!("{int}.{}", &frac[..frac.len().min(4)])
        }
    };
    format!("{value} {symbol}")
}

/// Compute surplus of executed vs the signed minimum, mirroring the
/// frontend `calcSurplus` convention: `(executed - signed) / signed` on the
/// buy side for sell orders. Returns `None` when not settled or the signed
/// minimum is zero.
pub fn surplus_fraction(executed_buy: &U256, signed_buy: &U256) -> Option<f64> {
    if signed_buy.is_zero() || executed_buy.is_zero() {
        return None;
    }
    // U256 has no direct f64 conversion; go through its decimal string.
    let exec = executed_buy.to_string().parse::<f64>().ok()?;
    let signed = signed_buy.to_string().parse::<f64>().ok()?;
    if signed == 0.0 {
        return None;
    }
    Some((exec - signed) / signed)
}

/// Inputs shared by the graph builders (already-resolved, pure).
pub struct TokenView {
    pub address: Address,
    pub symbol: String,
    pub decimals: u8,
}

/// Build the QUOTE-TIME graph: input token -> winning solver -> output
/// token. Solver NAME only, no venue column (owner decision 22). No surplus
/// (not settled yet).
pub fn build_quote_graph(
    sell: &TokenView,
    buy: &TokenView,
    sell_atoms: &str,
    buy_atoms: &str,
    solver_name: &str,
) -> PathVizGraph {
    let mut g = PathVizGraph::new();
    g.nodes.push(PathVizNode {
        id: "in".into(),
        label: sell.symbol.clone(),
        kind: PathVizNodeKind::Token,
        column: 0,
        address: Some(sell.address.to_string()),
    });
    g.nodes.push(PathVizNode {
        id: "solver".into(),
        label: solver_name.to_string(),
        kind: PathVizNodeKind::Solver,
        column: 1,
        address: None,
    });
    g.nodes.push(PathVizNode {
        id: "out".into(),
        label: buy.symbol.clone(),
        kind: PathVizNodeKind::Token,
        column: 3,
        address: Some(buy.address.to_string()),
    });
    g.links.push(PathVizLink {
        from: "in".into(),
        to: "solver".into(),
        kind: PathVizLinkKind::Route,
        amount_atoms: Some(sell_atoms.to_string()),
        amount_display: Some(format_atoms(sell_atoms, sell.decimals, &sell.symbol)),
        token_symbol: Some(sell.symbol.clone()),
    });
    g.links.push(PathVizLink {
        from: "solver".into(),
        to: "out".into(),
        kind: PathVizLinkKind::Route,
        amount_atoms: Some(buy_atoms.to_string()),
        amount_display: Some(format_atoms(buy_atoms, buy.decimals, &buy.symbol)),
        token_symbol: Some(buy.symbol.clone()),
    });
    g.solvers.push(PathVizSolverBid {
        name: solver_name.to_string(),
        winner: true,
        executed_sell_atoms: None,
        executed_buy_atoms: None,
    });
    g
}

/// Compute the surplus callout for a settled order, mirroring the frontend
/// `calcSurplus`: on the buy side for sell orders, the sell side for buy
/// orders. Returns `None` when there is no positive surplus or amounts are
/// unparseable.
pub fn compute_surplus(
    sell: &TokenView,
    buy: &TokenView,
    is_sell_order: bool,
    signed_sell_atoms: &str,
    signed_buy_atoms: &str,
    executed_sell_atoms: &str,
    executed_buy_atoms: &str,
) -> Option<Surplus> {
    let parse = |s: &str| s.parse::<U256>().ok();

    // The signed amounts are the FULL order's limit. A partially-filled order
    // must be measured against the limit SCALED to the filled fraction, or the
    // surplus is nonsense: a partial sell would show none (executed_buy is only
    // a fraction of the full signed_buy), and a partial buy would report the
    // unfilled sell remainder as if it were surplus. For a full fill the scale
    // is the identity, so this matches the previous behaviour exactly.
    let signed_sell = parse(signed_sell_atoms)?;
    let signed_buy = parse(signed_buy_atoms)?;
    let executed_sell = parse(executed_sell_atoms)?;
    let executed_buy = parse(executed_buy_atoms)?;

    // scaled = whole * num / den, mul-before-div to keep precision. `round_up`
    // ceilings the result. Returns None on a zero denominator or a mul/add
    // overflow rather than a wrong number: surplus is a display field, degrade
    // it, never fabricate it.
    let scale = |whole: U256, num: U256, den: U256, round_up: bool| -> Option<U256> {
        if den.is_zero() {
            return None;
        }
        let prod = whole.checked_mul(num)?;
        if round_up {
            // ceil(prod/den) = (prod + den - 1) / den; den >= 1 so no underflow.
            Some(prod.checked_add(den - U256::from(1u8))? / den)
        } else {
            Some(prod / den)
        }
    };

    if is_sell_order {
        // Filled fraction = executed_sell / signed_sell. The pro-rated minimum
        // buy is signed_buy * that fraction, rounded UP: the settlement math
        // uses ceiling division for the smallest permitted executed buy, so
        // flooring here would under-state the minimum and report up to 1 atom of
        // phantom surplus on a ratio that does not divide evenly.
        let scaled_min_buy = scale(signed_buy, executed_sell, signed_sell, true)?;
        let diff = executed_buy.checked_sub(scaled_min_buy).filter(|d| !d.is_zero())?;
        Some(Surplus {
            amount_atoms: diff.to_string(),
            token_symbol: buy.symbol.clone(),
            amount_display: Some(format_atoms(&diff.to_string(), buy.decimals, &buy.symbol)),
            percent: surplus_fraction(&executed_buy, &scaled_min_buy),
        })
    } else {
        // Buy order: filled fraction = executed_buy / signed_buy. The pro-rated
        // maximum sell is signed_sell * that fraction, rounded DOWN (the tightest
        // bound the trader is protected by); surplus is how far executed_sell
        // came in under it.
        let scaled_max_sell = scale(signed_sell, executed_buy, signed_buy, false)?;
        let diff = scaled_max_sell.checked_sub(executed_sell).filter(|d| !d.is_zero())?;
        Some(Surplus {
            amount_atoms: diff.to_string(),
            token_symbol: sell.symbol.clone(),
            amount_display: Some(format_atoms(&diff.to_string(), sell.decimals, &sell.symbol)),
            percent: surplus_fraction(&scaled_max_sell, &executed_sell),
        })
    }
}

/// Everything the endpoint gathers from the DB to assemble an order graph.
pub struct OrderVizParams {
    /// Order uid, used as the settlement-cache key for traded orders.
    pub uid: String,
    pub sell_token: Address,
    pub buy_token: Address,
    pub is_sell_order: bool,
    pub signed_sell_atoms: String,
    pub signed_buy_atoms: String,
    pub executed_sell_atoms: Option<String>,
    pub executed_buy_atoms: Option<String>,
    /// Executed sell BEFORE fees, for surplus/limit math only (the graph's route
    /// label keeps the gross `executed_sell_atoms`). Using the gross amount here
    /// subtracts the fee as if it were route spend and hides real surplus, even
    /// on a full fill for buy orders. Mirrors the frontend surplus calculation.
    pub executed_sell_before_fees_atoms: Option<String>,
    pub solvers: Vec<PathVizSolverBid>,
    pub context: VizContext,
    pub owner: Address,
    /// Effective buy-token receiver (`order.data.receiver` or the owner). Kept
    /// out of the venue set so a custom recipient is not drawn as a route hop.
    pub receiver: Address,
    /// Partially-fillable orders can settle across multiple transactions, so
    /// their graph is NOT immutable and must not be cached by uid.
    pub partially_fillable: bool,
    pub settlement_tx: Option<B256>,
    pub fee: Option<Fee>,
}

/// Classify settlement transfers into the venues Ophis DIRECTLY settled with:
/// the counterparty of every transfer whose other endpoint is the settlement
/// hub. Addresses reached BEHIND that counterparty (an aggregator's internal
/// router <-> pool hops, where the settlement contract is neither endpoint) are
/// the aggregator's own routing, not where we settled, so they are excluded even
/// if they happen to be an allowlisted pool used elsewhere for direct settlement
/// (otherwise a pool an aggregator merely passed through would be misattributed
/// as this order's venue). Returns the ordered, de-duplicated direct-counterparty
/// set (UNCAPPED) plus the matched-in-batch evidence flag. The caller applies the
/// `[venues]` allowlist and only then caps to MAX_VENUES, so an eligible pool late
/// in a large receipt is not lost to excluded counterparties ahead of it.
pub fn classify_settlement(
    transfers: &[TransferLog],
    trader: Address,
    receiver: Address,
) -> (Vec<Address>, bool) {
    let mut venues: Vec<Address> = Vec::new();
    let mut seen: HashSet<Address> = HashSet::new();
    let mut trader_out = false;
    let mut trader_in = false;
    for t in transfers {
        if t.from == trader {
            trader_out = true;
        }
        if t.to == trader {
            trader_in = true;
        }
        // Only a DIRECT settlement counterparty is a venue: the transfer's other
        // endpoint must be the settlement hub. A transfer where neither endpoint
        // is the hub is an aggregator-internal hop and is skipped entirely.
        let party = if t.from == SETTLEMENT_CONTRACT {
            t.to
        } else if t.to == SETTLEMENT_CONTRACT {
            t.from
        } else {
            continue;
        };
        // The trader and the receiver (the buy-token payout target, which may
        // differ from the owner on a custom-receiver order) are settlement
        // endpoints, not venues. When there is no custom receiver it equals the
        // trader, so that arm is a no-op.
        if party == trader || party == receiver || party == SETTLEMENT_CONTRACT || party.is_zero() {
            continue;
        }
        if seen.insert(party) {
            venues.push(party);
        }
    }
    // NOT capped here: the caller applies the allowlist first, then caps, so a
    // drawable pool is never dropped in favour of an excluded counterparty.
    // "Matched in batch" evidence: the trader both sent and received directly
    // against the settlement hub without a venue leg is a weak signal; a
    // safe, evidence-only heuristic is that any transfer both endpoints of
    // which are non-venues (trader <-> settlement only) implies internal
    // coverage. Keep it conservative: require both directions present.
    let matched = trader_out && trader_in && !transfers.is_empty();
    (venues, matched)
}

/// Build the SETTLED graph: full 4-column story with the venue column,
/// solver competition, surplus, and optional fee.
#[allow(clippy::too_many_arguments)]
pub fn build_settled_graph(
    sell: &TokenView,
    buy: &TokenView,
    executed_sell_atoms: &str,
    executed_buy_atoms: &str,
    solvers: Vec<PathVizSolverBid>,
    venues: &[(Address, String)],
    surplus: Option<Surplus>,
    fee: Option<Fee>,
) -> PathVizGraph {
    let mut g = PathVizGraph::new();
    g.nodes.push(PathVizNode {
        id: "in".into(),
        label: sell.symbol.clone(),
        kind: PathVizNodeKind::Token,
        column: 0,
        address: Some(sell.address.to_string()),
    });
    // Winning solver (column 1). Losing bids still appear as solver nodes.
    let winner = solvers
        .iter()
        .find(|b| b.winner)
        .map(|b| b.name.clone())
        .unwrap_or_else(|| "solver".to_string());
    let mut solver_nodes = 0usize;
    for bid in solvers.iter().take(MAX_SOLVERS) {
        g.nodes.push(PathVizNode {
            id: format!("solver:{}", bid.name),
            label: bid.name.clone(),
            kind: PathVizNodeKind::Solver,
            column: 1,
            address: None,
        });
        solver_nodes += 1;
    }
    if solver_nodes == 0 {
        g.nodes.push(PathVizNode {
            id: format!("solver:{winner}"),
            label: winner.clone(),
            kind: PathVizNodeKind::Solver,
            column: 1,
            address: None,
        });
    }
    // Venue column (column 2), registry-labelled or bare address.
    for (addr, label) in venues.iter().take(MAX_VENUES) {
        g.nodes.push(PathVizNode {
            id: format!("venue:{addr}"),
            label: label.clone(),
            kind: PathVizNodeKind::Venue,
            column: 2,
            address: Some(addr.to_string()),
        });
    }
    g.nodes.push(PathVizNode {
        id: "out".into(),
        label: buy.symbol.clone(),
        kind: PathVizNodeKind::Token,
        column: 3,
        address: Some(buy.address.to_string()),
    });

    let winner_id = format!("solver:{winner}");
    g.links.push(PathVizLink {
        from: "in".into(),
        to: winner_id.clone(),
        kind: PathVizLinkKind::Route,
        amount_atoms: Some(executed_sell_atoms.to_string()),
        amount_display: Some(format_atoms(executed_sell_atoms, sell.decimals, &sell.symbol)),
        token_symbol: Some(sell.symbol.clone()),
    });
    if venues.is_empty() {
        // Degraded (no receipt evidence): straight to output.
        g.links.push(PathVizLink {
            from: winner_id.clone(),
            to: "out".into(),
            kind: PathVizLinkKind::Route,
            amount_atoms: Some(executed_buy_atoms.to_string()),
            amount_display: Some(format_atoms(executed_buy_atoms, buy.decimals, &buy.symbol)),
            token_symbol: Some(buy.symbol.clone()),
        });
    } else {
        for (addr, _) in venues.iter().take(MAX_VENUES) {
            let vid = format!("venue:{addr}");
            g.links.push(PathVizLink {
                from: winner_id.clone(),
                to: vid.clone(),
                kind: PathVizLinkKind::Route,
                amount_atoms: None,
                amount_display: None,
                token_symbol: None,
            });
            g.links.push(PathVizLink {
                from: vid,
                to: "out".into(),
                kind: PathVizLinkKind::Route,
                amount_atoms: None,
                amount_display: None,
                token_symbol: Some(buy.symbol.clone()),
            });
        }
    }

    g.solvers = solvers;
    g.surplus = surplus;
    g.fee = fee;
    g
}

// ---------------------------------------------------------------------------
// The stateful service (caches + I/O).
// ---------------------------------------------------------------------------

/// Metrics for the pathviz feature.
#[derive(prometheus_metric_storage::MetricStorage, Clone, Debug)]
#[metric(subsystem = "pathviz")]
struct PathVizMetrics {
    /// Total renders, labelled by lifecycle context and cache hit/miss.
    #[metric(labels("context", "cache_hit"))]
    renders_total: prometheus::IntCounterVec,

    /// Render wall time (cache misses only).
    #[metric(labels("context"), buckets(0.001, 0.005, 0.01, 0.05, 0.1, 0.5))]
    render_duration_seconds: prometheus::HistogramVec,
}

/// Assembles, renders, and caches pathviz graphs.
pub struct PathVizService {
    token_info: Arc<dyn TokenInfoFetching>,
    provider: Option<ethrpc::AlloyProvider>,
    registry: Arc<VenueRegistry>,
    /// Immutable settled graphs, keyed by order uid. Errors are never
    /// inserted, so a transient failure is retried next call.
    settlement_cache: moka::future::Cache<String, Arc<PathVizGraph>>,
    /// Rendered SVGs keyed by a hash of (graph, config), TTI 15 minutes.
    render_cache: moka::sync::Cache<u64, String>,
    metrics: &'static PathVizMetrics,
}

impl PathVizService {
    pub fn new(
        token_info: Arc<dyn TokenInfoFetching>,
        provider: Option<ethrpc::AlloyProvider>,
        registry: Arc<VenueRegistry>,
    ) -> Self {
        let metrics = PathVizMetrics::instance(observe::metrics::get_storage_registry())
            .expect("pathviz metrics registered once");
        Self {
            token_info,
            provider,
            registry,
            settlement_cache: moka::future::Cache::new(512),
            render_cache: moka::sync::Cache::builder()
                .max_capacity(2048)
                .time_to_idle(std::time::Duration::from_secs(15 * 60))
                .build(),
            metrics,
        }
    }

    pub fn registry(&self) -> &VenueRegistry {
        &self.registry
    }

    /// Resolve a token's symbol + decimals, degrading to a short address and
    /// 18 decimals when the node lookup fails (hostile-safe: the symbol is
    /// escaped downstream).
    async fn token_view(&self, address: Address) -> TokenView {
        let infos = self.token_info.get_token_infos(&[address]).await;
        let info = infos.get(&address);
        let symbol = info
            .and_then(|i| i.symbol.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| short_address(address));
        let decimals = info.and_then(|i| i.decimals).unwrap_or(18);
        TokenView {
            address,
            symbol,
            decimals,
        }
    }

    /// Render a graph to SVG, memoized on (graph, config). Records the
    /// `renders_total` + duration metrics.
    pub fn render(
        &self,
        graph: &PathVizGraph,
        config: Option<&PathVizImageConfig>,
        context: VizContext,
    ) -> Result<String, pathviz::RenderError> {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        serde_json::to_string(graph).unwrap_or_default().hash(&mut hasher);
        serde_json::to_string(&config)
            .unwrap_or_default()
            .hash(&mut hasher);
        let key = hasher.finish();

        if let Some(svg) = self.render_cache.get(&key) {
            self.metrics
                .renders_total
                .with_label_values(&[context.as_str(), "true"])
                .inc();
            return Ok(svg);
        }
        let started = std::time::Instant::now();
        let svg = pathviz::render_svg(graph, config)?;
        self.metrics
            .render_duration_seconds
            .with_label_values(&[context.as_str()])
            .observe(started.elapsed().as_secs_f64());
        self.metrics
            .renders_total
            .with_label_values(&[context.as_str(), "false"])
            .inc();
        self.render_cache.insert(key, svg.clone());
        Ok(svg)
    }

    /// Best-effort settlement transfer fetch. Returns an empty vec (the
    /// venue column degrades away) when there is no provider, the receipt is
    /// missing, or any decode fails. Never fails the request.
    /// Fetch a settlement receipt and extract what the venue column needs: the
    /// ERC-20 transfers and the number of GPv2 `Trade` events (= orders settled
    /// in the batch).
    ///
    /// Returns `None` when the receipt could NOT be read (provider absent, not
    /// yet mined, or an RPC error). That is deliberately distinct from
    /// `Some(empty)`: the caller must not cache a `None`, so a transient RPC
    /// failure retries on the next request instead of pinning a venue-less
    /// diagram forever.
    async fn fetch_receipt(&self, tx_hash: B256) -> Option<ReceiptData> {
        let provider = self.provider.as_ref()?;
        use alloy::providers::Provider as _;
        let receipt = match provider.get_transaction_receipt(tx_hash).await {
            Ok(Some(r)) => r,
            // No receipt yet is transient (indexer/RPC lag), not a settled fact.
            Ok(None) => return None,
            Err(err) => {
                tracing::warn!(?err, "pathviz: settlement receipt fetch failed; will retry");
                return None;
            }
        };
        let mut transfers = Vec::new();
        let mut trade_count = 0usize;
        for log in receipt.inner.logs() {
            let topics = log.topics();
            match topics.first() {
                // One Trade per order settled by the hub. Match the emitter too
                // so an unrelated contract's same-topic log cannot inflate the
                // count.
                Some(t) if *t == TRADE_TOPIC && log.address() == SETTLEMENT_CONTRACT => {
                    trade_count += 1;
                }
                Some(t) if *t == TRANSFER_TOPIC && topics.len() >= 3 => {
                    // Standard Transfer data is a single 32-byte word; guard
                    // against non-standard payloads so `from_be_slice` cannot
                    // panic.
                    let data = log.data().data.as_ref();
                    let word = if data.len() >= 32 {
                        &data[data.len() - 32..]
                    } else {
                        data
                    };
                    transfers.push(TransferLog {
                        token: log.address(),
                        from: Address::from_word(topics[1]),
                        to: Address::from_word(topics[2]),
                        value: U256::from_be_slice(word),
                    });
                }
                _ => {}
            }
        }
        Some(ReceiptData {
            transfers,
            trade_count,
        })
    }

    /// Assemble (and optionally render) the QUOTE-TIME view for a quote
    /// response. Best-effort: any failure warns and returns `None` for the
    /// affected field, so a viz problem never fails the quote (owner
    /// warn-and-degrade rule). Solver is disclosed by short address only; no
    /// venue column at quote time (decision 22).
    #[allow(clippy::too_many_arguments)]
    pub async fn build_quote_view(
        &self,
        sell_token: Address,
        buy_token: Address,
        sell_atoms: String,
        buy_atoms: String,
        solver: Address,
        want_graph: bool,
        want_image: bool,
        config: Option<&PathVizImageConfig>,
    ) -> (Option<PathVizGraph>, Option<String>) {
        let sell = self.token_view(sell_token).await;
        let buy = self.token_view(buy_token).await;
        let solver_name = short_address(solver);
        let graph = build_quote_graph(&sell, &buy, &sell_atoms, &buy_atoms, &solver_name);

        let image = if want_image {
            match self.render(&graph, config, VizContext::QuotedOnly) {
                Ok(svg) => Some(pathviz::svg_to_base64(&svg)),
                Err(err) => {
                    tracing::warn!(?err, "pathviz: quote-time render failed; degrading image");
                    None
                }
            }
        } else {
            None
        };
        let graph = want_graph.then_some(graph);
        (graph, image)
    }

    /// Resolve the venue column for a settled order, or `None` when the receipt
    /// could not be read (so the caller does not cache a transient failure). A
    /// multi-order batch resolves to `Some(empty)`: the same degradation as a
    /// genuinely venue-less settlement, and cacheable, but never someone else's
    /// venues, because a shared receipt cannot attribute counterparties to one
    /// order.
    async fn venues_for_settlement(
        &self,
        tx_hash: B256,
        trader: Address,
        receiver: Address,
    ) -> Option<Vec<(Address, String)>> {
        let receipt = self.fetch_receipt(tx_hash).await?;
        // A shared receipt cannot attribute its counterparties to one order, so
        // a batch of more than one order degrades to no venue column rather than
        // drawing the other orders' pools as this order's route.
        if receipt.trade_count > 1 {
            return Some(Vec::new());
        }
        let (venues, _matched) = classify_settlement(&receipt.transfers, trader, receiver);
        Some(
            venues
                .into_iter()
                // ALLOWLIST: draw a counterparty only if it is an approved
                // `[venues]` pool. Known aggregator routers, downstream pools an
                // aggregator internally hopped through, unknown addresses, and
                // everything at all when the registry failed to load are dropped,
                // so the column never names or draws a competitor and fails
                // closed on a missing/stale registry. Filtering BEFORE the cap
                // means an eligible pool late in a large receipt is not lost to
                // excluded counterparties ahead of it. On chains that settle only
                // through routers (Optimism) `[venues]` is empty, so the column is
                // empty and the graph degrades to solver -> out.
                .filter_map(|addr| self.registry.labeled_venue(addr).map(|label| (addr, label)))
                .take(MAX_VENUES)
                .collect(),
        )
    }

    /// Assemble the graph for an existing order (quote-time or settled).
    /// Resolves token symbols, computes surplus, and (for traded orders)
    /// fetches the settlement receipt for the venue column, degrading the
    /// venue column away on any receipt failure.
    pub async fn build_order_graph(&self, p: OrderVizParams) -> PathVizGraph {
        let sell = self.token_view(p.sell_token).await;
        let buy = self.token_view(p.buy_token).await;

        if p.context == VizContext::Traded {
            // Settled graphs are immutable ONCE we have the receipt, so serve a
            // cached one when present.
            if let Some(cached) = self.settlement_cache.get(&p.uid).await {
                return (*cached).clone();
            }
            // `None` means the receipt could not be read (RPC failure, not yet
            // mined, or no settlement tx recorded): build a degraded graph but
            // do NOT cache it, so the next request retries. Only a successfully
            // read receipt (even a multi-order one with no venues) is cacheable.
            let venue_result = match p.settlement_tx {
                Some(tx) => self.venues_for_settlement(tx, p.owner, p.receiver).await,
                None => None,
            };
            // Cacheable only when the receipt was read AND the order can receive
            // no further fills. A partially-fillable order can settle again with
            // different executed amounts, solver competition, and settlement tx,
            // so caching its graph by uid would pin the first fill forever.
            let cacheable = venue_result.is_some() && !p.partially_fillable;
            let venues = venue_result.unwrap_or_default();
            let exec_sell = p
                .executed_sell_atoms
                .clone()
                .unwrap_or_else(|| p.signed_sell_atoms.clone());
            let exec_buy = p
                .executed_buy_atoms
                .clone()
                .unwrap_or_else(|| p.signed_buy_atoms.clone());
            // Surplus uses the BEFORE-FEES executed sell (falling back to the
            // gross only if unavailable): the fee is a protocol cost, not route
            // spend, and counting it hides real surplus, especially on buy orders.
            let exec_sell_for_surplus = p
                .executed_sell_before_fees_atoms
                .clone()
                .unwrap_or_else(|| exec_sell.clone());
            let surplus = compute_surplus(
                &sell,
                &buy,
                p.is_sell_order,
                &p.signed_sell_atoms,
                &p.signed_buy_atoms,
                &exec_sell_for_surplus,
                &exec_buy,
            );
            let graph = build_settled_graph(
                &sell, &buy, &exec_sell, &exec_buy, p.solvers, &venues, surplus, p.fee,
            );
            // Cache only when the receipt was actually read; a graph built from
            // a failed/absent receipt must be re-derived next time.
            if cacheable {
                self.settlement_cache
                    .insert(p.uid.clone(), Arc::new(graph.clone()))
                    .await;
            }
            graph
        } else {
            // Not settled: the quote-time 3-column view (solver name only).
            let solver_name = p
                .solvers
                .iter()
                .find(|b| b.winner)
                .map(|b| b.name.clone())
                .unwrap_or_else(|| "pending".to_string());
            let mut g = build_quote_graph(
                &sell,
                &buy,
                &p.signed_sell_atoms,
                &p.signed_buy_atoms,
                &solver_name,
            );
            if !p.solvers.is_empty() {
                g.solvers = p.solvers;
            }
            g
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tv(sym: &str, decimals: u8) -> TokenView {
        TokenView {
            address: Address::with_last_byte(1),
            symbol: sym.into(),
            decimals,
        }
    }

    #[test]
    fn committed_op_venue_registry_loads() {
        // Guards the checked-in registry: every key must be a valid EIP-55
        // address and the file must parse. Mirrors the invariant scripts that
        // pin other user-facing literals. On OP every counterparty is an
        // aggregator router, so [venues] is empty and nothing is drawable.
        let src = include_str!(
            "../../../../../infra/optimism-mainnet/configs/pathviz-venues.toml"
        );
        let reg = VenueRegistry::from_toml(src).expect("committed venue registry must parse");
        assert_eq!(reg.len(), 0, "OP settles only through routers: no drawable venues");
        assert_eq!(reg.router_count(), 10, "expected the 10 documented OP routers");
        // The competitor aggregators are NOT drawable (absent from the allowlist)
        // and are recorded as routers.
        let odos: Address = "0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680".parse().unwrap();
        assert!(reg.labeled_venue(odos).is_none(), "a router is never drawn");
        assert!(reg.is_router(odos));
        let kyber: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5".parse().unwrap();
        assert!(reg.labeled_venue(kyber).is_none());
        assert!(reg.is_router(kyber));
    }

    #[test]
    fn venue_registry_allowlist_draws_only_listed_venues() {
        let toml = r#"
[venues]
"0x9c12939390052919aF3155f41Bf4160Fd3666A6f" = "Velodrome"

[routers]
"0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680" = "Odos"
"#;
        let reg = VenueRegistry::from_toml(toml).unwrap();
        assert_eq!(reg.len(), 1);
        // An allowlisted pool is drawn with its label.
        let known: Address = "0x9c12939390052919aF3155f41Bf4160Fd3666A6f".parse().unwrap();
        assert_eq!(reg.labeled_venue(known).as_deref(), Some("Velodrome"));
        // A router is documented but NOT drawable.
        let odos: Address = "0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680".parse().unwrap();
        assert!(reg.labeled_venue(odos).is_none());
        assert!(reg.is_router(odos));
        assert_eq!(reg.router_count(), 1);
        // An unknown address is NOT drawable either (allowlist fails closed).
        let unknown = Address::with_last_byte(0xAB);
        assert!(reg.labeled_venue(unknown).is_none());
        assert!(!reg.is_router(unknown));
    }

    #[test]
    fn default_registry_draws_nothing() {
        // The fail-closed state used when the registry cannot be loaded: an empty
        // allowlist, so no counterparty is ever drawable.
        let reg = VenueRegistry::default();
        assert!(reg.labeled_venue(Address::with_last_byte(0xAA)).is_none());
        assert!(reg.labeled_venue(Address::with_last_byte(0xCA)).is_none());
    }

    #[test]
    fn registry_rejects_router_also_listed_as_venue() {
        // The load-time guardrail: a known competitor may not be promoted to a
        // drawable venue, even by an operator editing the file.
        let toml = r#"
[venues]
"0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680" = "Totally A Pool"

[routers]
"0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680" = "Odos"
"#;
        assert!(VenueRegistry::from_toml(toml).is_err());
    }

    #[test]
    fn format_atoms_scales_by_decimals() {
        assert_eq!(format_atoms("1000000000000000000", 18, "WETH"), "1 WETH");
        assert_eq!(format_atoms("1500000000000000000", 18, "WETH"), "1.5 WETH");
        assert_eq!(format_atoms("3214700000", 6, "USDC"), "3214.7 USDC");
        assert_eq!(format_atoms("500000", 6, "USDC"), "0.5 USDC");
        assert_eq!(format_atoms("0", 6, "USDC"), "0 USDC");
        assert_eq!(format_atoms("42", 0, "PT"), "42 PT");
    }

    #[test]
    fn surplus_fraction_matches_calc_surplus() {
        let executed = U256::from(103u64);
        let signed = U256::from(100u64);
        let frac = surplus_fraction(&executed, &signed).unwrap();
        assert!((frac - 0.03).abs() < 1e-9);
        assert!(surplus_fraction(&U256::ZERO, &signed).is_none());
        assert!(surplus_fraction(&executed, &U256::ZERO).is_none());
    }

    #[test]
    fn quote_graph_is_three_columns_solver_name_only() {
        let g = build_quote_graph(
            &tv("WETH", 18),
            &tv("USDC", 6),
            "1000000000000000000",
            "3214700000",
            "odos-solver",
        );
        g.validate().unwrap();
        // No venue column at quote time (decision 22).
        assert!(!g.nodes.iter().any(|n| n.kind == PathVizNodeKind::Venue));
        assert_eq!(g.solvers.len(), 1);
        assert_eq!(g.solvers[0].name, "odos-solver");
        assert!(g.surplus.is_none());
    }

    #[test]
    fn classify_settlement_finds_venues_excluding_hub_and_trader() {
        let trader = Address::with_last_byte(0x11);
        let venue_a = Address::with_last_byte(0xAA);
        let venue_b = Address::with_last_byte(0xBB);
        let token = Address::with_last_byte(0x01);
        let transfers = vec![
            // trader -> settlement (sell leg)
            TransferLog { token, from: trader, to: SETTLEMENT_CONTRACT, value: U256::from(100u64) },
            // settlement -> venue_a
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: venue_a, value: U256::from(60u64) },
            // venue_a -> settlement
            TransferLog { token, from: venue_a, to: SETTLEMENT_CONTRACT, value: U256::from(59u64) },
            // settlement -> venue_b
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: venue_b, value: U256::from(40u64) },
            // settlement -> trader (buy leg)
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: trader, value: U256::from(98u64) },
        ];
        // No custom receiver: the payout target is the trader itself.
        let (venues, matched) = classify_settlement(&transfers, trader, trader);
        assert_eq!(venues, vec![venue_a, venue_b]);
        assert!(matched); // trader both sent and received
    }

    #[test]
    fn classify_settlement_excludes_custom_receiver() {
        // Custom-receiver order: the buy leg pays out to `receiver`, not the
        // owner. That address is a settlement endpoint, not a liquidity venue,
        // and must not be drawn as a route hop.
        let trader = Address::with_last_byte(0x11);
        let receiver = Address::with_last_byte(0x22);
        let venue = Address::with_last_byte(0xAA);
        let token = Address::with_last_byte(0x01);
        let transfers = vec![
            TransferLog { token, from: trader, to: SETTLEMENT_CONTRACT, value: U256::from(100u64) },
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: venue, value: U256::from(100u64) },
            TransferLog { token, from: venue, to: SETTLEMENT_CONTRACT, value: U256::from(98u64) },
            // buy leg pays the custom receiver, not the trader
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: receiver, value: U256::from(98u64) },
        ];
        let (venues, _matched) = classify_settlement(&transfers, trader, receiver);
        assert_eq!(venues, vec![venue]);
        assert!(!venues.contains(&receiver));
    }

    // Mirrors venues_for_settlement's draw rule: allowlist, then cap.
    fn drawn_venues(reg: &VenueRegistry, venues: Vec<Address>) -> Vec<(Address, String)> {
        venues
            .into_iter()
            .filter_map(|a| reg.labeled_venue(a).map(|l| (a, l)))
            .take(MAX_VENUES)
            .collect()
    }

    #[test]
    fn classify_excludes_addresses_reached_behind_a_router() {
        // The OP topology plus a downstream pool the aggregator internally hopped
        // through. Only the router transacts DIRECTLY with the settlement hub, so
        // classify returns the router alone; the downstream pool (router <-> pool,
        // hub not an endpoint) is the aggregator's own routing and is excluded.
        let trader = Address::with_last_byte(0x11);
        let router = Address::with_last_byte(0xCA); // outer aggregator router
        let downstream_pool = Address::with_last_byte(0xDD); // internal hop
        let token = Address::with_last_byte(0x01);
        let transfers = vec![
            TransferLog { token, from: trader, to: SETTLEMENT_CONTRACT, value: U256::from(100u64) },
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: router, value: U256::from(100u64) },
            // aggregator-internal hop: router <-> pool, settlement not involved
            TransferLog { token, from: router, to: downstream_pool, value: U256::from(100u64) },
            TransferLog { token, from: downstream_pool, to: router, value: U256::from(98u64) },
            TransferLog { token, from: router, to: SETTLEMENT_CONTRACT, value: U256::from(98u64) },
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: trader, value: U256::from(98u64) },
        ];
        let (venues, _matched) = classify_settlement(&transfers, trader, trader);
        assert_eq!(venues, vec![router], "only the direct settlement counterparty");
        assert!(!venues.contains(&downstream_pool), "a pool behind the router is not a venue");
    }

    #[test]
    fn allowlisted_pool_behind_a_router_is_not_misattributed() {
        // finding 1: a pool that is allowlisted for DIRECT settlement, but which
        // an aggregator merely passed through as an internal hop, must NOT be
        // drawn for this order. Because it is not a direct settlement
        // counterparty here, classify never surfaces it, so the allowlist never
        // sees it. The SAME pool, when the settlement hub transacts with it
        // directly, IS drawn.
        let trader = Address::with_last_byte(0x11);
        let router = Address::with_last_byte(0xCA);
        let pool = Address::with_last_byte(0xBB); // allowlisted for direct settlement
        let token = Address::with_last_byte(0x01);
        let reg = {
            let toml = format!("[venues]\n\"{pool}\" = \"RealPool\"\n[routers]\n\"{router}\" = \"SomeAggregator\"\n");
            VenueRegistry::from_toml(&toml).unwrap()
        };

        // (a) pool reached only behind the router -> not drawn.
        let behind = vec![
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: router, value: U256::from(100u64) },
            TransferLog { token, from: router, to: pool, value: U256::from(100u64) },
            TransferLog { token, from: pool, to: router, value: U256::from(98u64) },
            TransferLog { token, from: router, to: SETTLEMENT_CONTRACT, value: U256::from(98u64) },
        ];
        let (venues, _) = classify_settlement(&behind, trader, trader);
        assert!(drawn_venues(&reg, venues).is_empty(), "pool behind a router is not attributed");

        // (b) same pool, settled through directly -> drawn.
        let direct = vec![
            TransferLog { token, from: SETTLEMENT_CONTRACT, to: pool, value: U256::from(100u64) },
            TransferLog { token, from: pool, to: SETTLEMENT_CONTRACT, value: U256::from(98u64) },
        ];
        let (venues, _) = classify_settlement(&direct, trader, trader);
        assert_eq!(drawn_venues(&reg, venues), vec![(pool, "RealPool".to_string())]);
    }

    #[test]
    fn allowlist_is_applied_before_the_cap() {
        // A large receipt whose only allowlisted pool is the LAST counterparty,
        // after MAX_VENUES non-drawable ones. Filtering before the cap keeps it;
        // the pre-fix order (cap in classify, then filter) would have truncated
        // it away. (finding 1)
        let trader = Address::with_last_byte(0x11);
        let token = Address::with_last_byte(0x01);
        let pool = Address::with_last_byte(0xEE);
        let mut transfers = vec![TransferLog {
            token,
            from: trader,
            to: SETTLEMENT_CONTRACT,
            value: U256::from(1u64),
        }];
        // MAX_VENUES + 5 unlisted counterparties ahead of the pool. Offset 0x20
        // keeps them distinct from trader (0x11), token (0x01), and pool (0xEE).
        for i in 0..(MAX_VENUES as u8 + 5) {
            let filler = Address::with_last_byte(0x20 + i);
            transfers.push(TransferLog { token, from: SETTLEMENT_CONTRACT, to: filler, value: U256::from(1u64) });
        }
        transfers.push(TransferLog { token, from: SETTLEMENT_CONTRACT, to: pool, value: U256::from(1u64) });
        transfers.push(TransferLog { token, from: SETTLEMENT_CONTRACT, to: trader, value: U256::from(1u64) });

        let reg = {
            let toml = format!("[venues]\n\"{pool}\" = \"RealPool\"\n");
            VenueRegistry::from_toml(&toml).unwrap()
        };
        let (venues, _matched) = classify_settlement(&transfers, trader, trader);
        assert!(venues.len() > MAX_VENUES, "more candidates than the cap");
        let drawn = drawn_venues(&reg, venues);
        assert_eq!(drawn, vec![(pool, "RealPool".to_string())], "the late pool survives the cap");
    }

    #[test]
    fn settled_graph_has_full_venue_column() {
        let venue = Address::with_last_byte(0xAA);
        let solvers = vec![PathVizSolverBid {
            name: "odos-solver".into(),
            winner: true,
            executed_sell_atoms: Some("2000000000000000000".into()),
            executed_buy_atoms: Some("6430000000".into()),
        }];
        let g = build_settled_graph(
            &tv("WETH", 18),
            &tv("USDC", 6),
            "2000000000000000000",
            "6430000000",
            solvers,
            &[(venue, "Uniswap v3".to_string())],
            Some(Surplus {
                amount_atoms: "42800000".into(),
                token_symbol: "USDC".into(),
                amount_display: Some("42.8 USDC".into()),
                percent: Some(0.0067),
            }),
            Some(Fee {
                amount_atoms: "1286000".into(),
                token_symbol: "USDC".into(),
                amount_display: Some("1.29 USDC".into()),
                bps: Some("2".into()),
            }),
        );
        g.validate().unwrap();
        assert_eq!(
            g.nodes.iter().filter(|n| n.kind == PathVizNodeKind::Venue).count(),
            1
        );
        assert_eq!(g.nodes.iter().find(|n| n.kind == PathVizNodeKind::Venue).unwrap().label, "Uniswap v3");
        assert!(g.surplus.is_some());
        assert!(g.fee.is_some());
    }

    #[test]
    fn settled_graph_degrades_without_venues() {
        let g = build_settled_graph(
            &tv("WETH", 18),
            &tv("USDC", 6),
            "2000000000000000000",
            "6430000000",
            vec![PathVizSolverBid { name: "s".into(), winner: true, executed_sell_atoms: None, executed_buy_atoms: None }],
            &[],
            None,
            None,
        );
        g.validate().unwrap();
        // No venue nodes: solver links straight to output.
        assert!(!g.nodes.iter().any(|n| n.kind == PathVizNodeKind::Venue));
        assert!(g.links.iter().any(|l| l.from == "solver:s" && l.to == "out"));
    }

    #[test]
    fn surplus_full_fill_sell_unchanged() {
        // A fully-filled sell order: executed_sell == signed_sell, so the scaled
        // minimum equals the signed minimum and behaviour matches pre-fix.
        let s = compute_surplus(&tv("USDC", 6), &tv("WETH", 18), true, "1000", "500", "1000", "530").unwrap();
        assert_eq!(s.amount_atoms, "30"); // 530 executed_buy - 500 signed_buy
        assert_eq!(s.token_symbol, "WETH");
    }

    #[test]
    fn surplus_partial_sell_scales_the_minimum() {
        // Half-filled sell: executed_sell=500 of signed_sell=1000, signed_buy=500.
        // Scaled min buy = 500 * 500/1000 = 250. executed_buy=270 -> surplus 20.
        // The pre-fix code compared 270 against the FULL 500 and showed NONE.
        let s = compute_surplus(&tv("USDC", 6), &tv("WETH", 18), true, "1000", "500", "500", "270").unwrap();
        assert_eq!(s.amount_atoms, "20");
    }

    #[test]
    fn surplus_partial_sell_exact_shows_none() {
        // Half-filled at exactly the pro-rated minimum: no surplus, not a spurious one.
        assert!(compute_surplus(&tv("USDC", 6), &tv("WETH", 18), true, "1000", "500", "500", "250").is_none());
    }

    #[test]
    fn surplus_sell_minimum_ceilings_no_phantom_atom() {
        // A ratio that does not divide evenly: signed_buy=100, executed_sell=1,
        // signed_sell=3 -> exact min buy = 100/3 = 33.33. Flooring gives 33, so
        // executed_buy=34 would falsely show 1 atom of surplus. Ceiling gives 34,
        // and 34 executed against a 34 minimum is NOT surplus.
        assert!(compute_surplus(&tv("USDC", 6), &tv("WETH", 18), true, "3", "100", "1", "34").is_none());
        // One atom above the ceilinged minimum IS real surplus.
        let s = compute_surplus(&tv("USDC", 6), &tv("WETH", 18), true, "3", "100", "1", "35").unwrap();
        assert_eq!(s.amount_atoms, "1");
    }

    #[test]
    fn surplus_partial_buy_does_not_report_unfilled_remainder() {
        // Buy order: signed_sell=1000 max, signed_buy=500. Half filled:
        // executed_buy=250 -> scaled max sell = 1000*250/500 = 500.
        // executed_sell=480 -> surplus 20 (came in under the pro-rated max).
        // The pre-fix code did 1000 - 480 = 520, reporting the unfilled half as surplus.
        let s = compute_surplus(&tv("WETH", 18), &tv("USDC", 6), false, "1000", "500", "480", "250").unwrap();
        assert_eq!(s.amount_atoms, "20");
        assert_eq!(s.token_symbol, "WETH");
    }

    #[test]
    fn surplus_none_on_zero_signed_denominator() {
        assert!(compute_surplus(&tv("USDC", 6), &tv("WETH", 18), true, "0", "500", "0", "10").is_none());
    }
}
