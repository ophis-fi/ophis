//! Hand-rolled 4-column Sankey layout. Clean-room: no d3-sankey algorithm
//! was ported. Nodes are placed in their declared column (0 input tokens,
//! 1 solvers, 2 venues, 3 output tokens) and stacked vertically, evenly
//! distributed within the content box. Links are cubic Beziers between the
//! facing edges of their endpoints.
//!
//! Pure geometry: given a graph and a canvas size, produce positioned boxes
//! and SVG path strings. No color, no text escaping (that is svg.rs's job).

use model::pathviz::{PathVizGraph, PathVizLinkKind, PathVizNode, PathVizNodeKind};

/// Fixed node box width in px.
const NODE_W: f64 = 132.0;
/// Node box height in px.
const NODE_H: f64 = 34.0;
/// Minimum vertical gap between stacked nodes.
const MIN_GAP: f64 = 14.0;
/// Outer padding around the content area.
pub const PAD_X: f64 = 24.0;
/// Top padding leaves room for the title band.
pub const PAD_TOP: f64 = 56.0;
/// Bottom padding leaves room for the legend + surplus/fee footer.
pub const PAD_BOTTOM: f64 = 72.0;

/// A positioned node box.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeBox {
    pub id: String,
    pub label: String,
    pub kind: PathVizNodeKind,
    pub column: u8,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl NodeBox {
    fn right_center(&self) -> (f64, f64) {
        (self.x + self.w, self.y + self.h / 2.0)
    }
    fn left_center(&self) -> (f64, f64) {
        (self.x, self.y + self.h / 2.0)
    }
    /// Center, used for intra-column ("matched in batch") ribbons.
    fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// A laid-out link with its SVG path `d` string.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkPath {
    pub from: String,
    pub to: String,
    pub kind: PathVizLinkKind,
    /// SVG path data.
    pub d: String,
    /// Index into the theme link-color ramp.
    pub color_index: usize,
}

/// The complete geometry for a graph.
#[derive(Clone, Debug)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub nodes: Vec<NodeBox>,
    pub links: Vec<LinkPath>,
    /// X center of each of the 4 columns (for column headers).
    pub column_centers: [f64; 4],
}

/// Format a coordinate with 2 decimals and no trailing-zero noise, so
/// golden SVGs are stable across platforms.
pub fn fmt_num(v: f64) -> String {
    // Round to 2 dp; strip a trailing ".00" / trailing zeros.
    let r = (v * 100.0).round() / 100.0;
    let mut s = format!("{r:.2}");
    while s.contains('.') && (s.ends_with('0') || s.ends_with('.')) {
        s.pop();
    }
    if s == "-0" { "0".to_string() } else { s }
}

fn column_x(column: u8, width: f64) -> f64 {
    // Four evenly spaced column left-edges across the content width.
    let content_left = PAD_X;
    let content_right = width - PAD_X - NODE_W;
    let span = (content_right - content_left).max(0.0);
    content_left + span * (column as f64) / 3.0
}

/// Compute the layout for `graph` at the given canvas size.
pub fn compute(graph: &PathVizGraph, width: f64, height: f64) -> Layout {
    let content_top = PAD_TOP;
    let content_bottom = height - PAD_BOTTOM;
    let content_h = (content_bottom - content_top).max(NODE_H);

    let mut boxes: Vec<NodeBox> = Vec::with_capacity(graph.nodes.len());

    for col in 0u8..4 {
        let col_nodes: Vec<&PathVizNode> =
            graph.nodes.iter().filter(|n| n.column == col).collect();
        let n = col_nodes.len();
        if n == 0 {
            continue;
        }
        let x = column_x(col, width);
        // Total height the stack wants; if it overflows, compress both the
        // step AND the box height so boxes never vertically overlap.
        let ideal = n as f64 * NODE_H + (n.saturating_sub(1)) as f64 * MIN_GAP;
        let (step, start_y, box_h) = if ideal <= content_h {
            let step = NODE_H + MIN_GAP;
            let used = n as f64 * NODE_H + (n.saturating_sub(1)) as f64 * MIN_GAP;
            (step, content_top + (content_h - used) / 2.0, NODE_H)
        } else {
            // Compress: even step across the content box, and a shorter box
            // that always leaves a positive gap under it.
            let step = content_h / n as f64;
            let box_h = (step - MIN_GAP).clamp(10.0, NODE_H);
            (step, content_top, box_h)
        };
        for (i, node) in col_nodes.iter().enumerate() {
            // Center each box within its step slot.
            let y = start_y + i as f64 * step + (step - box_h).max(0.0) / 2.0;
            boxes.push(NodeBox {
                id: node.id.clone(),
                label: node.label.clone(),
                kind: node.kind,
                column: col,
                x,
                y,
                w: NODE_W,
                h: box_h,
            });
        }
    }

    let find = |id: &str| boxes.iter().find(|b| b.id == id);

    let mut links = Vec::with_capacity(graph.links.len());
    let mut color_index = 0usize;
    for link in &graph.links {
        let (Some(src), Some(dst)) = (find(&link.from), find(&link.to)) else {
            continue; // validated away in practice; skip defensively
        };
        let d = match link.kind {
            PathVizLinkKind::Matched => {
                // Intra-column peer ribbon: a gentle arc between centers.
                let (sx, sy) = src.center();
                let (tx, ty) = dst.center();
                let mx = (sx + tx) / 2.0 + 40.0;
                format!(
                    "M {} {} Q {} {} {} {}",
                    fmt_num(sx),
                    fmt_num(sy),
                    fmt_num(mx),
                    fmt_num((sy + ty) / 2.0),
                    fmt_num(tx),
                    fmt_num(ty),
                )
            }
            _ => {
                let (sx, sy) = src.right_center();
                let (tx, ty) = dst.left_center();
                let mx = (sx + tx) / 2.0;
                format!(
                    "M {} {} C {} {} {} {} {} {}",
                    fmt_num(sx),
                    fmt_num(sy),
                    fmt_num(mx),
                    fmt_num(sy),
                    fmt_num(mx),
                    fmt_num(ty),
                    fmt_num(tx),
                    fmt_num(ty),
                )
            }
        };
        let ci = if link.kind == PathVizLinkKind::Route {
            let c = color_index;
            color_index += 1;
            c
        } else {
            // Bids and matched ribbons ride the accent slot.
            0
        };
        links.push(LinkPath {
            from: link.from.clone(),
            to: link.to.clone(),
            kind: link.kind,
            d,
            color_index: ci,
        });
    }

    let column_centers = [
        column_x(0, width) + NODE_W / 2.0,
        column_x(1, width) + NODE_W / 2.0,
        column_x(2, width) + NODE_W / 2.0,
        column_x(3, width) + NODE_W / 2.0,
    ];

    Layout {
        width,
        height,
        nodes: boxes,
        links,
        column_centers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::pathviz::{PathVizLink, PathVizNode};

    fn node(id: &str, col: u8, kind: PathVizNodeKind) -> PathVizNode {
        PathVizNode {
            id: id.to_string(),
            label: id.to_string(),
            kind,
            column: col,
            address: None,
        }
    }

    #[test]
    fn fmt_num_is_stable() {
        assert_eq!(fmt_num(1.0), "1");
        assert_eq!(fmt_num(1.25), "1.25");
        assert_eq!(fmt_num(1.20), "1.2");
        assert_eq!(fmt_num(-0.0), "0");
        assert_eq!(fmt_num(12.3456), "12.35");
    }

    #[test]
    fn nodes_stay_inside_the_canvas() {
        let mut g = PathVizGraph::new();
        g.nodes.push(node("a", 0, PathVizNodeKind::Token));
        g.nodes.push(node("b", 3, PathVizNodeKind::Token));
        let l = compute(&g, 960.0, 540.0);
        for b in &l.nodes {
            assert!(b.x >= 0.0 && b.x + b.w <= 960.0, "node {b:?} overflows x");
            assert!(b.y >= 0.0 && b.y + b.h <= 540.0, "node {b:?} overflows y");
        }
    }

    #[test]
    fn columns_are_left_to_right() {
        let mut g = PathVizGraph::new();
        g.nodes.push(node("i", 0, PathVizNodeKind::Token));
        g.nodes.push(node("s", 1, PathVizNodeKind::Solver));
        g.nodes.push(node("v", 2, PathVizNodeKind::Venue));
        g.nodes.push(node("o", 3, PathVizNodeKind::Token));
        let l = compute(&g, 960.0, 540.0);
        let x = |id: &str| l.nodes.iter().find(|b| b.id == id).unwrap().x;
        assert!(x("i") < x("s"));
        assert!(x("s") < x("v"));
        assert!(x("v") < x("o"));
    }

    #[test]
    fn many_nodes_compress_without_overflow() {
        let mut g = PathVizGraph::new();
        for i in 0..16 {
            g.nodes
                .push(node(&format!("v{i}"), 2, PathVizNodeKind::Venue));
        }
        let l = compute(&g, 960.0, 540.0);
        for b in &l.nodes {
            assert!(b.y >= 0.0 && b.y + b.h <= 540.0, "compressed node overflows");
        }
        // Boxes must not vertically overlap: each box's bottom must sit at
        // or above the next box's top.
        let mut spans: Vec<(f64, f64)> = l.nodes.iter().map(|b| (b.y, b.y + b.h)).collect();
        spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        for w in spans.windows(2) {
            assert!(w[0].1 <= w[1].0 + 0.01, "overlap: {:?} into {:?}", w[0], w[1]);
        }
    }

    #[test]
    fn route_link_is_a_cubic_bezier() {
        let mut g = PathVizGraph::new();
        g.nodes.push(node("a", 0, PathVizNodeKind::Token));
        g.nodes.push(node("b", 3, PathVizNodeKind::Token));
        g.links.push(PathVizLink {
            from: "a".into(),
            to: "b".into(),
            kind: PathVizLinkKind::Route,
            amount_atoms: None,
            amount_display: None,
            token_symbol: None,
        });
        let l = compute(&g, 960.0, 540.0);
        assert_eq!(l.links.len(), 1);
        assert!(l.links[0].d.starts_with("M "));
        assert!(l.links[0].d.contains(" C "));
    }
}
