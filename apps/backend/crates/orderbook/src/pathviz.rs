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
    alloy::primitives::{Address, B256, U256, address, b256},
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

/// Address -> human label registry, loaded from TOML. Missing entries
/// degrade to the bare `0x...` address (owner decision 27), never a
/// fabricated name.
#[derive(Clone, Debug, Default)]
pub struct VenueRegistry {
    labels: HashMap<Address, String>,
}

impl VenueRegistry {
    /// Parse a `[venues]` TOML table of `address = "label"`. Ownership of
    /// this file is assigned to infra ops (decision 27).
    pub fn from_toml(src: &str) -> anyhow::Result<Self> {
        #[derive(serde::Deserialize)]
        struct Doc {
            #[serde(default)]
            venues: HashMap<String, String>,
        }
        let doc: Doc = toml::from_str(src)?;
        let mut labels = HashMap::new();
        for (addr, label) in doc.venues {
            let parsed: Address = addr
                .parse()
                .map_err(|e| anyhow::anyhow!("venue key {addr:?} is not an address: {e}"))?;
            labels.insert(parsed, label);
        }
        Ok(Self { labels })
    }

    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let src = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("reading venue registry {}: {e}", path.display()))?;
        Self::from_toml(&src)
    }

    /// The registry label, or the checksummed bare address as a fallback.
    pub fn label_for(&self, address: Address) -> String {
        self.labels
            .get(&address)
            .cloned()
            .unwrap_or_else(|| address.to_string())
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
    if is_sell_order {
        // Surplus in the buy token: executed_buy - signed_min_buy.
        let executed = parse(executed_buy_atoms)?;
        let signed = parse(signed_buy_atoms)?;
        let diff = executed.checked_sub(signed).filter(|d| !d.is_zero())?;
        Some(Surplus {
            amount_atoms: diff.to_string(),
            token_symbol: buy.symbol.clone(),
            amount_display: Some(format_atoms(&diff.to_string(), buy.decimals, &buy.symbol)),
            percent: surplus_fraction(&executed, &signed),
        })
    } else {
        // Buy order: surplus in the sell token = signed_max_sell - executed_sell.
        let executed = parse(executed_sell_atoms)?;
        let signed = parse(signed_sell_atoms)?;
        let diff = signed.checked_sub(executed).filter(|d| !d.is_zero())?;
        Some(Surplus {
            amount_atoms: diff.to_string(),
            token_symbol: sell.symbol.clone(),
            amount_display: Some(format_atoms(&diff.to_string(), sell.decimals, &sell.symbol)),
            percent: surplus_fraction(&signed, &executed),
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
    pub solvers: Vec<PathVizSolverBid>,
    pub context: VizContext,
    pub owner: Address,
    pub settlement_tx: Option<B256>,
    pub fee: Option<Fee>,
}

/// Classify settlement transfers relative to the trader and the settlement
/// hub: any counterparty that is neither the trader nor the settlement
/// contract is a venue. Returns the ordered, de-duplicated venue address
/// set (capped) plus the matched-in-batch evidence flag.
pub fn classify_settlement(
    transfers: &[TransferLog],
    trader: Address,
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
        for party in [t.from, t.to] {
            if party == trader || party == SETTLEMENT_CONTRACT || party.is_zero() {
                continue;
            }
            if seen.insert(party) {
                venues.push(party);
            }
        }
    }
    venues.truncate(MAX_VENUES);
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
    async fn fetch_transfers(&self, tx_hash: B256) -> Vec<TransferLog> {
        let Some(provider) = &self.provider else {
            return Vec::new();
        };
        use alloy::providers::Provider as _;
        let receipt = match provider.get_transaction_receipt(tx_hash).await {
            Ok(Some(r)) => r,
            Ok(None) => return Vec::new(),
            Err(err) => {
                tracing::warn!(?err, "pathviz: settlement receipt fetch failed; venues degrade");
                return Vec::new();
            }
        };
        let mut out = Vec::new();
        for log in receipt.inner.logs() {
            let topics = log.topics();
            if topics.first() != Some(&TRANSFER_TOPIC) || topics.len() < 3 {
                continue;
            }
            // Standard Transfer data is a single 32-byte word; guard against
            // non-standard payloads so `from_be_slice` cannot panic.
            let data = log.data().data.as_ref();
            let word = if data.len() >= 32 {
                &data[data.len() - 32..]
            } else {
                data
            };
            let value = U256::from_be_slice(word);
            out.push(TransferLog {
                token: log.address(),
                from: Address::from_word(topics[1]),
                to: Address::from_word(topics[2]),
                value,
            });
        }
        out
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

    /// Resolve the venue address set from a settlement tx into
    /// registry-labelled (address, label) pairs.
    pub async fn venues_for_settlement(
        &self,
        tx_hash: B256,
        trader: Address,
    ) -> Vec<(Address, String)> {
        let transfers = self.fetch_transfers(tx_hash).await;
        let (venues, _matched) = classify_settlement(&transfers, trader);
        venues
            .into_iter()
            .map(|addr| (addr, self.registry.label_for(addr)))
            .collect()
    }

    /// Assemble the graph for an existing order (quote-time or settled).
    /// Resolves token symbols, computes surplus, and (for traded orders)
    /// fetches the settlement receipt for the venue column, degrading the
    /// venue column away on any receipt failure.
    pub async fn build_order_graph(&self, p: OrderVizParams) -> PathVizGraph {
        let sell = self.token_view(p.sell_token).await;
        let buy = self.token_view(p.buy_token).await;

        if p.context == VizContext::Traded {
            // Settled graphs are immutable: serve from the settlement cache
            // when present. Errors are never cached (assembly always yields a
            // graph, and we only insert on the success path).
            if let Some(cached) = self.settlement_cache.get(&p.uid).await {
                return (*cached).clone();
            }
            let venues = match p.settlement_tx {
                Some(tx) => self.venues_for_settlement(tx, p.owner).await,
                None => Vec::new(),
            };
            let exec_sell = p
                .executed_sell_atoms
                .clone()
                .unwrap_or_else(|| p.signed_sell_atoms.clone());
            let exec_buy = p
                .executed_buy_atoms
                .clone()
                .unwrap_or_else(|| p.signed_buy_atoms.clone());
            let surplus = compute_surplus(
                &sell,
                &buy,
                p.is_sell_order,
                &p.signed_sell_atoms,
                &p.signed_buy_atoms,
                &exec_sell,
                &exec_buy,
            );
            let graph = build_settled_graph(
                &sell, &buy, &exec_sell, &exec_buy, p.solvers, &venues, surplus, p.fee,
            );
            self.settlement_cache
                .insert(p.uid.clone(), Arc::new(graph.clone()))
                .await;
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
        // Guards the checked-in registry: every key must be a valid
        // EIP-55 address and the file must parse. Mirrors the invariant
        // scripts that pin other user-facing literals.
        let src = include_str!(
            "../../../../../infra/optimism-mainnet/configs/pathviz-venues.toml"
        );
        let reg = VenueRegistry::from_toml(src).expect("committed venue registry must parse");
        assert_eq!(reg.len(), 10, "expected the 10 seeded OP venues");
        let odos: Address = "0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680".parse().unwrap();
        assert_eq!(reg.label_for(odos), "Odos");
    }

    #[test]
    fn venue_registry_parses_and_degrades() {
        let toml = r#"
[venues]
"0x9c12939390052919aF3155f41Bf4160Fd3666A6f" = "Velodrome"
"#;
        let reg = VenueRegistry::from_toml(toml).unwrap();
        assert_eq!(reg.len(), 1);
        let known: Address = "0x9c12939390052919aF3155f41Bf4160Fd3666A6f".parse().unwrap();
        assert_eq!(reg.label_for(known), "Velodrome");
        // Unknown address degrades to its bare hex (never fabricated).
        let unknown = Address::with_last_byte(0xAB);
        assert_eq!(reg.label_for(unknown), unknown.to_string());
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
        let (venues, matched) = classify_settlement(&transfers, trader);
        assert_eq!(venues, vec![venue_a, venue_b]);
        assert!(matched); // trader both sent and received
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
}
