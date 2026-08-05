//! SVG emission. Turns a [`PathVizGraph`] + optional
//! [`PathVizImageConfig`] into a self-contained, themeable SVG string, and
//! (via [`svg_to_base64`]) a `data:`-ready base64 payload.
//!
//! Security posture:
//! - The output is self-contained: NO external references (`<script>`, `href`,
//!   `<image>`, `<foreignObject>`, `url(...)`), enforced by a test. This lets
//!   the `.svg` endpoint serve it under `Content-Security-Policy: default-src
//!   'none'` with `X-Content-Type-Options: nosniff`.
//! - Every hostile label (token symbols, venue/solver names) is passed through
//!   [`crate::escape`] before it reaches an attribute or text node.

use {
    crate::{
        escape::{escape_label, xml_escape},
        layout::{self, fmt_num},
        theme::Theme,
    },
    model::pathviz::{PathVizGraph, PathVizImageConfig, PathVizLinkKind, PathVizNodeKind, Surplus},
    std::fmt::Write as _,
};

/// Longest label rendered inside a node box before ellipsis.
const MAX_LABEL_CHARS: usize = 16;

/// Failure to render a graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// The graph failed structural validation (see
    /// [`PathVizGraph::validate`]).
    InvalidGraph(String),
    /// The image config carried a malformed color.
    InvalidConfig(String),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::InvalidGraph(m) => write!(f, "invalid pathviz graph: {m}"),
            RenderError::InvalidConfig(m) => write!(f, "invalid pathviz image config: {m}"),
        }
    }
}

impl std::error::Error for RenderError {}

/// Render `graph` to a standalone SVG document string.
pub fn render_svg(
    graph: &PathVizGraph,
    config: Option<&PathVizImageConfig>,
) -> Result<String, RenderError> {
    graph.validate().map_err(RenderError::InvalidGraph)?;
    if let Some(cfg) = config {
        cfg.validate().map_err(RenderError::InvalidConfig)?;
    }

    let theme = Theme::resolve(config);
    let width = config.map(|c| c.clamped_width()).unwrap_or(960) as f64;
    let height = config.map(|c| c.clamped_height()).unwrap_or(540) as f64;
    let show_legend = config.and_then(|c| c.show_legend).unwrap_or(true);
    let show_surplus = config.and_then(|c| c.show_surplus).unwrap_or(true);

    let l = layout::compute(graph, width, height);

    let mut s = String::with_capacity(2048);
    // Root. `xmlns` is a namespace declaration, not a fetchable reference.
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="Ophis route visualization" font-family="Geist, Inter, system-ui, sans-serif">"#,
        w = fmt_num(width),
        h = fmt_num(height),
    );
    let _ = write!(
        s,
        r#"<rect x="0" y="0" width="{w}" height="{h}" fill="{bg}"/>"#,
        w = fmt_num(width),
        h = fmt_num(height),
        bg = theme.background,
    );

    // Title band, centered so it clears the per-column headers below it
    // (which sit over their columns near the top-left).
    let _ = write!(
        s,
        r#"<text x="{x}" y="28" fill="{c}" font-size="18" font-weight="600" text-anchor="middle">Ophis route</text>"#,
        x = fmt_num(width / 2.0),
        c = theme.node_text_color,
    );

    // Column headers, only for columns that actually carry nodes (so the
    // quote-time 3-column view omits the empty venue header).
    let headers = ["You send", "Solvers", "Venues", "You receive"];
    for col in 0u8..4 {
        if !l.nodes.iter().any(|n| n.column == col) {
            continue;
        }
        let _ = write!(
            s,
            r#"<text x="{x}" y="{y}" fill="{c}" font-size="11" text-anchor="middle" letter-spacing="0.08em">{label}</text>"#,
            x = fmt_num(l.column_centers[col as usize]),
            y = fmt_num(layout::PAD_TOP - 18.0),
            c = theme.legend_text_color,
            label = xml_escape(headers[col as usize]),
        );
    }

    // Links first, so node boxes render on top of the ribbons.
    for link in &l.links {
        let color = theme.link_color(link.color_index);
        let (stroke_width, dash, opacity) = match link.kind {
            PathVizLinkKind::Route => ("6", "", "0.85"),
            PathVizLinkKind::Bid => ("2", r#" stroke-dasharray="4 4""#, "0.5"),
            PathVizLinkKind::Matched => ("3", r#" stroke-dasharray="1 5""#, "0.7"),
        };
        let _ = write!(
            s,
            r#"<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-opacity="{op}" stroke-linecap="round"{dash}/>"#,
            d = link.d,
            sw = stroke_width,
            op = opacity,
        );
    }

    // Nodes. Solver winners get an accent outline. Match on the node id's raw
    // solver key ("solver:<name>"), NOT the label: the label is the brand-neutral
    // public string ("External solver" for every competitor lane), so several
    // solver nodes share one label and matching by label would mis-highlight
    // them all. The id keeps the raw name as a stable, non-rendered key.
    let winners: std::collections::HashSet<&str> = graph
        .solvers
        .iter()
        .filter(|b| b.winner)
        .map(|b| b.name.as_str())
        .collect();

    for b in &l.nodes {
        let node_solver_key = b.id.strip_prefix("solver:").unwrap_or(b.id.as_str());
        let is_winner = b.kind == PathVizNodeKind::Solver && winners.contains(node_solver_key);
        let stroke = if is_winner {
            theme.link_color(0)
        } else {
            &theme.node_color
        };
        let fill = if b.kind == PathVizNodeKind::Overflow {
            &theme.background
        } else {
            &theme.node_color
        };
        let _ = write!(
            s,
            r#"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>"#,
            x = fmt_num(b.x),
            y = fmt_num(b.y),
            w = fmt_num(b.w),
            h = fmt_num(b.h),
            sw = if is_winner { "2" } else { "1" },
        );
        let _ = write!(
            s,
            r#"<text x="{tx}" y="{ty}" fill="{c}" font-size="12" text-anchor="middle" dominant-baseline="central">{label}</text>"#,
            tx = fmt_num(b.x + b.w / 2.0),
            ty = fmt_num(b.y + b.h / 2.0),
            c = theme.node_text_color,
            label = escape_label(&b.label, MAX_LABEL_CHARS),
        );
    }

    // Footer: legend, then the surplus callout, then the fee note.
    let mut footer_y = height - layout::PAD_BOTTOM + 30.0;

    if show_legend {
        let mut lx = layout::PAD_X;
        let entries: &[(&str, &str)] = &[
            ("route", "settled flow"),
            ("bid", "competing solver bid"),
            ("matched", "matched in batch"),
        ];
        for (kind, label) in entries {
            let (color, dash) = match *kind {
                "bid" => (theme.link_color(0), r#" stroke-dasharray="4 4""#),
                "matched" => (theme.link_color(4), r#" stroke-dasharray="1 5""#),
                _ => (theme.link_color(0), ""),
            };
            let _ = write!(
                s,
                r#"<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{color}" stroke-width="3"{dash}/>"#,
                x1 = fmt_num(lx),
                x2 = fmt_num(lx + 22.0),
                y = fmt_num(footer_y),
            );
            let _ = write!(
                s,
                r#"<text x="{tx}" y="{ty}" fill="{c}" font-size="11">{label}</text>"#,
                tx = fmt_num(lx + 28.0),
                ty = fmt_num(footer_y + 4.0),
                c = theme.legend_text_color,
                label = xml_escape(label),
            );
            lx += 28.0 + (label.len() as f64) * 6.4 + 24.0;
        }
        footer_y += 22.0;
    }

    if show_surplus && let Some(surplus) = &graph.surplus {
        let amount = surplus
            .amount_display
            .clone()
            .unwrap_or_else(|| format!("{} {}", surplus.amount_atoms, surplus.token_symbol));
        let pct = surplus
            .percent
            .map(|p| format!(" (+{:.2}%)", p * 100.0))
            .unwrap_or_default();
        let _ = write!(
            s,
            r#"<text x="{x}" y="{y}" fill="{c}" font-size="13" font-weight="600">+{amount}{pct}</text>"#,
            x = fmt_num(layout::PAD_X),
            y = fmt_num(footer_y),
            c = theme.surplus_color,
            amount = xml_escape(&amount),
        );
        let _ = write!(
            s,
            r#"<text x="{x}" y="{y}" fill="{c}" font-size="11">{callout}</text>"#,
            // Offset after the amount; a monospace-free estimate is fine here.
            x = fmt_num(layout::PAD_X + 10.0 + (amount.len() + pct.len()) as f64 * 7.4),
            y = fmt_num(footer_y),
            c = theme.legend_text_color,
            callout = xml_escape(Surplus::CALLOUT),
        );
        footer_y += 20.0;
    }

    if let Some(fee) = &graph.fee {
        let amount = fee
            .amount_display
            .clone()
            .unwrap_or_else(|| format!("{} {}", fee.amount_atoms, fee.token_symbol));
        let bps = fee
            .bps
            .as_ref()
            .map(|b| format!(" ({b} bps)"))
            .unwrap_or_default();
        let _ = write!(
            s,
            r#"<text x="{x}" y="{y}" fill="{c}" font-size="11">fee: {amount}{bps}</text>"#,
            x = fmt_num(layout::PAD_X),
            y = fmt_num(footer_y),
            c = theme.legend_text_color,
            amount = xml_escape(&amount),
            bps = xml_escape(&bps),
        );
    }

    s.push_str("</svg>");
    Ok(s)
}

/// Standard base64 (no line breaks) of a rendered SVG, ready to drop into a
/// `data:image/svg+xml;base64,` URL. Uses the standard alphabet.
pub fn svg_to_base64(svg: &str) -> String {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    STANDARD.encode(svg.as_bytes())
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        model::pathviz::{Fee, PathVizLink, PathVizNode, PathVizSolverBid},
    };

    fn token(id: &str, label: &str, col: u8) -> PathVizNode {
        PathVizNode {
            id: id.to_string(),
            label: label.to_string(),
            kind: PathVizNodeKind::Token,
            column: col,
            address: None,
        }
    }

    fn route(from: &str, to: &str) -> PathVizLink {
        PathVizLink {
            from: from.to_string(),
            to: to.to_string(),
            kind: PathVizLinkKind::Route,
            amount_atoms: None,
            amount_display: None,
            token_symbol: None,
        }
    }

    /// A minimal single-order graph (input token -> solver -> output token).
    fn single_order_graph() -> PathVizGraph {
        let mut g = PathVizGraph::new();
        g.nodes.push(token("in:weth", "WETH", 0));
        // id follows the real "solver:<name>" convention so the id-based winner
        // match resolves against g.solvers by name.
        g.nodes.push(PathVizNode {
            id: "solver:external-solver".into(),
            label: "external-solver".into(),
            kind: PathVizNodeKind::Solver,
            column: 1,
            address: None,
        });
        g.nodes.push(token("out:usdc", "USDC", 3));
        g.links.push(route("in:weth", "solver:external-solver"));
        g.links.push(route("solver:external-solver", "out:usdc"));
        g.solvers.push(PathVizSolverBid {
            name: "external-solver".into(),
            winner: true,
            executed_sell_atoms: Some("1000000000000000000".into()),
            executed_buy_atoms: Some("3200000000".into()),
        });
        g.surplus = Some(Surplus {
            amount_atoms: "12500000".into(),
            token_symbol: "USDC".into(),
            amount_display: Some("12.5 USDC".into()),
            percent: Some(0.0039),
        });
        g
    }

    #[test]
    fn renders_well_formed_svg() {
        let svg = render_svg(&single_order_graph(), None).unwrap();
        assert!(svg.starts_with("<svg "));
        assert!(svg.ends_with("</svg>"));
        assert!(svg.contains("Ophis route"));
        assert!(svg.contains(Surplus::CALLOUT));
    }

    #[test]
    fn contains_no_external_references() {
        let svg = render_svg(&single_order_graph(), None).unwrap();
        let lower = svg.to_lowercase();
        // The only permitted "http" is the SVG namespace declaration.
        assert!(!lower.contains("<script"), "must not embed script");
        assert!(!lower.contains("href"), "must not carry any href");
        assert!(!lower.contains("<image"), "must not embed raster images");
        assert!(
            !lower.contains("<foreignobject"),
            "must not embed foreignObject"
        );
        assert!(!lower.contains("url("), "must not use url() references");
        // Exactly one http occurrence: the xmlns.
        assert_eq!(lower.matches("http").count(), 1);
    }

    #[test]
    fn escapes_hostile_token_symbol() {
        let mut g = single_order_graph();
        g.nodes[0].label = "</svg><script>alert(1)</script>".into();
        let svg = render_svg(&g, None).unwrap();
        assert!(!svg.to_lowercase().contains("<script"));
        assert!(svg.contains("&lt;")); // escaped somewhere
    }

    #[test]
    fn dark_cosmic_is_the_default_background() {
        let svg = render_svg(&single_order_graph(), None).unwrap();
        assert!(svg.contains(r##"fill="#02000D""##));
    }

    #[test]
    fn never_renders_a_competitor_solver_brand_and_still_highlights_the_winner() {
        // Two competitor lanes competed; velora won. As the graph builder now
        // produces: node ids keep the raw name (machine key), labels are the
        // brand-neutral public string. The SVG must draw NO competitor brand,
        // yet still outline the winner — matched by id, since both labels read
        // "External solver" and a label match would highlight neither.
        let mut g = PathVizGraph::new();
        g.nodes.push(token("in", "USDC", 0));
        g.nodes.push(PathVizNode {
            id: "solver:velora".into(),
            label: "External solver".into(),
            kind: PathVizNodeKind::Solver,
            column: 1,
            address: None,
        });
        g.nodes.push(PathVizNode {
            id: "solver:kyberswap".into(),
            label: "External solver".into(),
            kind: PathVizNodeKind::Solver,
            column: 1,
            address: None,
        });
        g.nodes.push(token("out", "WETH", 3));
        g.links.push(route("in", "solver:velora"));
        g.links.push(route("solver:velora", "out"));
        g.solvers.push(PathVizSolverBid {
            name: "velora".into(),
            winner: true,
            executed_sell_atoms: Some("1".into()),
            executed_buy_atoms: Some("1".into()),
        });
        g.solvers.push(PathVizSolverBid {
            name: "kyberswap".into(),
            winner: false,
            executed_sell_atoms: None,
            executed_buy_atoms: None,
        });
        let svg = render_svg(&g, None).unwrap();
        let lower = svg.to_lowercase();
        assert!(
            !lower.contains("velora"),
            "competitor brand leaked in the rendered SVG"
        );
        assert!(
            !lower.contains("kyberswap"),
            "competitor brand leaked in the rendered SVG"
        );
        assert!(
            svg.contains("External solver"),
            "neutral label should render"
        );
        // Only Route links here (stroke-width 6), so the winner node rect is the
        // sole stroke-width=2. Exactly one proves the id-based winner match fired.
        assert_eq!(
            svg.matches(r#"stroke-width="2""#).count(),
            1,
            "winner outline must survive label neutralization (matched by id)"
        );
    }

    #[test]
    fn config_overrides_dimensions_and_theme() {
        let cfg = PathVizImageConfig {
            theme: Some("light".into()),
            width: Some(1200),
            height: Some(600),
            ..Default::default()
        };
        let svg = render_svg(&single_order_graph(), Some(&cfg)).unwrap();
        assert!(svg.contains(r#"width="1200""#));
        assert!(svg.contains(r##"fill="#F5EFE6""##)); // light canvas
    }

    #[test]
    fn rejects_bad_config_color() {
        let cfg = PathVizImageConfig {
            node_color: Some("orange".into()),
            ..Default::default()
        };
        let err = render_svg(&single_order_graph(), Some(&cfg)).unwrap_err();
        assert!(matches!(err, RenderError::InvalidConfig(_)));
    }

    #[test]
    fn base64_round_trips() {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let svg = render_svg(&single_order_graph(), None).unwrap();
        let b64 = svg_to_base64(&svg);
        let decoded = STANDARD.decode(b64).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), svg);
    }

    #[test]
    fn winner_gets_accent_and_fee_renders() {
        let mut g = single_order_graph();
        g.fee = Some(Fee {
            amount_atoms: "200000".into(),
            token_symbol: "USDC".into(),
            amount_display: Some("0.2 USDC".into()),
            bps: Some("2".into()),
        });
        let svg = render_svg(&g, None).unwrap();
        assert!(svg.contains("fee: 0.2 USDC (2 bps)"));
        // Winner outline uses the accent color with stroke-width 2.
        assert!(svg.contains(r##"stroke="#f2a63e" stroke-width="2""##));
    }
}
