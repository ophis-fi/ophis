//! Wire model for pathviz (`PathVizGraph`, `schemaVersion: 1`) plus the
//! `PathVizImageConfig` render options.
//!
//! These shapes are mirrored 1:1 by TypeScript consumers (the frontend
//! MEV-receipt embed and, later, agent-skills), so the serde attributes
//! here ARE the contract: camelCase keys, decimal-string atom amounts,
//! optional fields omitted (not null) when absent.
//!
//! Schema version 1 is labeled EXPERIMENTAL for 60 days from first ship
//! (owner decision 25); within that window the shape may change. After the
//! window it is stable and additive-only. Consumers gate on
//! [`SCHEMA_VERSION`].
//!
//! Odos wire-name parity: `pathViz`, `pathVizImage`, `pathVizImageConfig`
//! and the hex color regex are kept identical to the Odos surface so a
//! migrating integrator's request bodies are accepted unchanged. What Odos
//! could not draw and this shape adds: the solver-competition column
//! ([`PathVizGraph::solvers`]) and the surplus callout ([`Surplus`]).

use serde::{Deserialize, Serialize};

/// Version of the `PathVizGraph` wire schema, serialized as `schemaVersion`.
pub const SCHEMA_VERSION: u32 = 1;

/// Layout column indices for the hand-rolled 4-column Sankey.
pub const COLUMN_INPUT: u8 = 0;
pub const COLUMN_SOLVER: u8 = 1;
pub const COLUMN_VENUE: u8 = 2;
pub const COLUMN_OUTPUT: u8 = 3;

/// Hard caps on graph size (worst-case Optimism batch). Builders truncate
/// to these before rendering; oversized graphs are refused.
pub const MAX_ORDERS: usize = 24;
pub const MAX_VENUES: usize = 16;
pub const MAX_SOLVERS: usize = 10;

/// Odos-parity hex color regex source: `#` then 3 or 6 hex digits.
pub const HEX_COLOR_REGEX: &str = "^#(?:[A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$";

/// Bounds on the rendered image, matching the Odos surface.
pub const MIN_WIDTH: u32 = 320;
pub const MAX_WIDTH: u32 = 2400;
pub const MIN_HEIGHT: u32 = 200;
pub const MAX_HEIGHT: u32 = 1600;

/// The six-color default link spectrum (Ophis ramp). Deliberately not the
/// brand accent alone: distinct hues let overlapping ribbons stay legible.
pub const DEFAULT_LINK_COLORS: [&str; 6] = [
    "#f2a63e", // sunset (brand accent)
    "#e2725b", // coral
    "#c65f8e", // rose
    "#8f5fc6", // violet-adjacent
    "#4f9db8", // teal
    "#63b57e", // green
];

/// Ophis dark-cosmic defaults (owner decision 23).
pub const DEFAULT_BACKGROUND: &str = "#02000D"; // Cosmic
pub const DEFAULT_NODE_COLOR: &str = "#1b1830";
pub const DEFAULT_NODE_TEXT_COLOR: &str = "#F5EFE6"; // Cream
pub const DEFAULT_LEGEND_TEXT_COLOR: &str = "#9d97b5";
pub const DEFAULT_SURPLUS_COLOR: &str = "#63b57e";

/// A hex color string validated against [`HEX_COLOR_REGEX`] without pulling
/// in a regex dependency (the model crate stays lean). Accepts `#rgb` and
/// `#rrggbb`, case-insensitive.
pub fn is_valid_hex_color(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    (hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathVizNodeKind {
    /// An ERC-20 (or the native token) on the input or output side.
    Token,
    /// A solver that bid in the competition.
    Solver,
    /// An on-chain venue the settlement touched (AMM pool, PMM, router).
    Venue,
    /// Synthetic node standing in for truncated entries ("+3 more").
    Overflow,
}

/// A node in the flow diagram.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathVizNode {
    /// Graph-unique id referenced by links.
    pub id: String,
    /// Display label. HOSTILE input (on-chain symbols / registry labels):
    /// the renderer escapes and truncates it.
    pub label: String,
    pub kind: PathVizNodeKind,
    /// Layout column, 0..=3.
    pub column: u8,
    /// Optional backing on-chain address (`0x`-prefixed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathVizLinkKind {
    /// Actual value flow (quote route or settled transfer evidence).
    Route,
    /// A losing solver's bid (rendered thin and dashed).
    Bid,
    /// Peer-to-peer coverage inside the batch ("matched in batch"). Emitted
    /// only on transfer-log evidence, never inferred.
    Matched,
}

/// A directed flow between two nodes.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathVizLink {
    /// Source [`PathVizNode::id`].
    pub from: String,
    /// Target [`PathVizNode::id`].
    pub to: String,
    pub kind: PathVizLinkKind,
    /// Flow amount in atoms, decimal string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_atoms: Option<String>,
    /// Human-readable amount ("1.25 WETH"), precomputed by the builder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_display: Option<String>,
    /// Symbol of the token flowing over this link (HOSTILE input).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_symbol: Option<String>,
}

/// One solver's participation in the competition column.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathVizSolverBid {
    /// Solver name (registry label or shortened address). HOSTILE input.
    pub name: String,
    pub winner: bool,
    /// Executed sell amount proposed for the order, atoms as decimal string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executed_sell_atoms: Option<String>,
    /// Executed buy amount proposed for the order, atoms as decimal string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executed_buy_atoms: Option<String>,
}

/// The surplus callout. Wording is fixed by owner decision 26.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Surplus {
    /// Surplus amount in atoms of `token_symbol`, decimal string.
    pub amount_atoms: String,
    /// Symbol of the surplus token (HOSTILE input).
    pub token_symbol: String,
    /// Human-readable amount, precomputed by the builder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_display: Option<String>,
    /// Fraction of the signed minimum, mirroring the mevReceipt
    /// `calcSurplus` convention: (executed - signed minimum) / signed
    /// minimum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
}

impl Surplus {
    /// Neutral wording: measures execution above the signed floor without
    /// implying that gross improvement bypasses the published fee policy.
    pub const CALLOUT: &'static str = "execution above your signed minimum";
}

/// Fee annotation for the diagram footer.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fee {
    /// Fee amount in atoms, decimal string.
    pub amount_atoms: String,
    /// Symbol of the fee token (HOSTILE input).
    pub token_symbol: String,
    /// Human-readable amount, precomputed by the builder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_display: Option<String>,
    /// Fee in basis points, when known ("2" for 0.02%).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bps: Option<String>,
}

/// The full diagram model (`PathVizGraph` on the wire).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathVizGraph {
    /// Always [`SCHEMA_VERSION`].
    pub schema_version: u32,
    pub nodes: Vec<PathVizNode>,
    pub links: Vec<PathVizLink>,
    /// The competition column (winner flag, executed amounts).
    pub solvers: Vec<PathVizSolverBid>,
    /// Present once the order settled; absent at quote time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surplus: Option<Surplus>,
    /// Present when a protocol fee applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fee: Option<Fee>,
}

impl PathVizGraph {
    /// An empty graph at the current schema version.
    pub fn new() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            nodes: Vec::new(),
            links: Vec::new(),
            solvers: Vec::new(),
            surplus: None,
            fee: None,
        }
    }

    /// Structural validation shared by the renderer and by builders' tests:
    /// unique node ids, links reference existing nodes, size caps.
    pub fn validate(&self) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        for node in &self.nodes {
            if node.column > COLUMN_OUTPUT {
                return Err(format!("node {:?} has column {} > 3", node.id, node.column));
            }
            if !ids.insert(node.id.as_str()) {
                return Err(format!("duplicate node id {:?}", node.id));
            }
        }
        for link in &self.links {
            if !ids.contains(link.from.as_str()) {
                return Err(format!("link references unknown node {:?}", link.from));
            }
            if !ids.contains(link.to.as_str()) {
                return Err(format!("link references unknown node {:?}", link.to));
            }
        }
        let count = |kind: PathVizNodeKind| self.nodes.iter().filter(|n| n.kind == kind).count();
        let venues = count(PathVizNodeKind::Venue);
        if venues > MAX_VENUES {
            return Err(format!("{venues} venue nodes exceed the cap of {MAX_VENUES}"));
        }
        let solvers = count(PathVizNodeKind::Solver);
        if solvers > MAX_SOLVERS {
            return Err(format!(
                "{solvers} solver nodes exceed the cap of {MAX_SOLVERS}"
            ));
        }
        Ok(())
    }
}

impl Default for PathVizGraph {
    fn default() -> Self {
        Self::new()
    }
}

/// Render options for the base64 SVG image (`pathVizImageConfig` on the
/// wire). Every color field is an optional hex string; absent fields fall
/// back to the Ophis dark-cosmic defaults. Odos wire-name parity is
/// preserved for the field names.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathVizImageConfig {
    /// Named theme. `"dark"` (default, Ophis cosmic) or `"light"` (the
    /// one-constant flip kept for partner embeds, decision 23).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// Six-color link spectrum override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_colors: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legend_text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surplus_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    /// Image width in px, clamped to [320, 2400].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Image height in px, clamped to [200, 1600].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_legend: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_surplus: Option<bool>,
}

impl PathVizImageConfig {
    /// Rejects any provided hex color that fails the Odos-parity regex, so
    /// a malformed color never reaches the renderer (where it would land in
    /// an SVG attribute). Width/height are clamped, not rejected.
    pub fn validate(&self) -> Result<(), String> {
        let check = |field: &str, value: &Option<String>| -> Result<(), String> {
            if let Some(v) = value
                && !is_valid_hex_color(v)
            {
                return Err(format!("{field} {v:?} is not a valid hex color"));
            }
            Ok(())
        };
        check("nodeColor", &self.node_color)?;
        check("nodeTextColor", &self.node_text_color)?;
        check("legendTextColor", &self.legend_text_color)?;
        check("surplusColor", &self.surplus_color)?;
        check("backgroundColor", &self.background_color)?;
        if let Some(colors) = &self.link_colors {
            for (i, c) in colors.iter().enumerate() {
                if !is_valid_hex_color(c) {
                    return Err(format!("linkColors[{i}] {c:?} is not a valid hex color"));
                }
            }
        }
        Ok(())
    }

    /// Width clamped into [`MIN_WIDTH`, `MAX_WIDTH`], defaulting to 960.
    pub fn clamped_width(&self) -> u32 {
        self.width.unwrap_or(960).clamp(MIN_WIDTH, MAX_WIDTH)
    }

    /// Height clamped into [`MIN_HEIGHT`, `MAX_HEIGHT`], defaulting to 540.
    pub fn clamped_height(&self) -> u32 {
        self.height.unwrap_or(540).clamp(MIN_HEIGHT, MAX_HEIGHT)
    }
}

#[cfg(test)]
mod tests {
    use {super::*, serde_json::json};

    fn node(id: &str, column: u8, kind: PathVizNodeKind) -> PathVizNode {
        PathVizNode {
            id: id.to_string(),
            label: id.to_string(),
            kind,
            column,
            address: None,
        }
    }

    #[test]
    fn serializes_camel_case_with_schema_version() {
        let mut graph = PathVizGraph::new();
        graph.nodes.push(node("in:weth", 0, PathVizNodeKind::Token));
        graph.solvers.push(PathVizSolverBid {
            name: "external-solver".into(),
            winner: true,
            executed_sell_atoms: Some("1000".into()),
            executed_buy_atoms: None,
        });
        graph.surplus = Some(Surplus {
            amount_atoms: "42".into(),
            token_symbol: "USDC".into(),
            amount_display: None,
            percent: Some(0.0042),
        });
        let v = serde_json::to_value(&graph).unwrap();
        assert_eq!(v["schemaVersion"], 1);
        assert_eq!(v["nodes"][0]["kind"], "token");
        assert_eq!(v["solvers"][0]["executedSellAtoms"], "1000");
        assert_eq!(v["surplus"]["amountAtoms"], "42");
        // Absent optionals are omitted, not null.
        assert!(!serde_json::to_string(&graph).unwrap().contains("\"fee\""));
    }

    #[test]
    fn round_trips() {
        let mut graph = PathVizGraph::new();
        graph.nodes.push(node("a", 0, PathVizNodeKind::Token));
        graph.nodes.push(node("b", 3, PathVizNodeKind::Token));
        graph.links.push(PathVizLink {
            from: "a".into(),
            to: "b".into(),
            kind: PathVizLinkKind::Route,
            amount_atoms: Some("123".into()),
            amount_display: Some("1.23 WETH".into()),
            token_symbol: Some("WETH".into()),
        });
        let s = serde_json::to_string(&graph).unwrap();
        let back: PathVizGraph = serde_json::from_str(&s).unwrap();
        assert_eq!(back.nodes.len(), 2);
        assert_eq!(back.links[0].amount_atoms.as_deref(), Some("123"));
    }

    #[test]
    fn validate_rejects_duplicate_and_dangling() {
        let mut g = PathVizGraph::new();
        g.nodes.push(node("a", 0, PathVizNodeKind::Token));
        g.nodes.push(node("a", 3, PathVizNodeKind::Token));
        assert!(g.validate().unwrap_err().contains("duplicate"));

        let mut g = PathVizGraph::new();
        g.nodes.push(node("a", 0, PathVizNodeKind::Token));
        g.links.push(PathVizLink {
            from: "a".into(),
            to: "missing".into(),
            kind: PathVizLinkKind::Route,
            amount_atoms: None,
            amount_display: None,
            token_symbol: None,
        });
        assert!(g.validate().unwrap_err().contains("unknown node"));
    }

    #[test]
    fn hex_validation_matches_odos_regex() {
        assert!(is_valid_hex_color("#fff"));
        assert!(is_valid_hex_color("#F2A63E"));
        assert!(!is_valid_hex_color("f2a63e")); // missing #
        assert!(!is_valid_hex_color("#12"));
        assert!(!is_valid_hex_color("#1234")); // 4 digits
        assert!(!is_valid_hex_color("#gggggg"));
    }

    #[test]
    fn config_validates_colors_and_clamps_dimensions() {
        let cfg: PathVizImageConfig = serde_json::from_value(json!({
            "backgroundColor": "#02000D",
            "width": 100000,
            "height": 10,
        }))
        .unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.clamped_width(), MAX_WIDTH);
        assert_eq!(cfg.clamped_height(), MIN_HEIGHT);

        let bad: PathVizImageConfig = serde_json::from_value(json!({
            "nodeColor": "not-a-color",
        }))
        .unwrap();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn config_defaults_are_empty_object() {
        let cfg = PathVizImageConfig::default();
        assert_eq!(serde_json::to_string(&cfg).unwrap(), "{}");
        assert_eq!(cfg.clamped_width(), 960);
        assert_eq!(cfg.clamped_height(), 540);
    }
}
