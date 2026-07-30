//! Renders the three reference pathviz scenarios to SVG files for visual
//! inspection: a single order, a multi-order batch, and a settled batch
//! with the on-chain venue column.
//!
//!     cargo run -p pathviz --example render_fixtures -- <output-dir>

use {
    model::pathviz::{
        Fee, PathVizGraph, PathVizLink, PathVizLinkKind, PathVizNode, PathVizNodeKind,
        PathVizSolverBid, Surplus,
    },
    pathviz::render_svg,
    std::{fs, path::PathBuf},
};

fn token(id: &str, label: &str, col: u8, addr: &str) -> PathVizNode {
    PathVizNode {
        id: id.into(),
        label: label.into(),
        kind: PathVizNodeKind::Token,
        column: col,
        address: Some(addr.into()),
    }
}

fn other(id: &str, label: &str, col: u8, kind: PathVizNodeKind) -> PathVizNode {
    PathVizNode {
        id: id.into(),
        label: label.into(),
        kind,
        column: col,
        address: None,
    }
}

fn link(from: &str, to: &str, kind: PathVizLinkKind, disp: Option<&str>, sym: Option<&str>) -> PathVizLink {
    PathVizLink {
        from: from.into(),
        to: to.into(),
        kind,
        amount_atoms: None,
        amount_display: disp.map(Into::into),
        token_symbol: sym.map(Into::into),
    }
}

/// Scenario 1: one order, one winning solver, quote-time 3-column view.
fn single_order() -> PathVizGraph {
    let mut g = PathVizGraph::new();
    g.nodes.push(token("in:weth", "WETH", 0, "0x4200000000000000000000000000000000000006"));
    g.nodes.push(other("s:win", "odos-solver", 1, PathVizNodeKind::Solver));
    g.nodes.push(token("out:usdc", "USDC", 3, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"));
    g.links.push(link("in:weth", "s:win", PathVizLinkKind::Route, Some("1.0 WETH"), Some("WETH")));
    g.links.push(link("s:win", "out:usdc", PathVizLinkKind::Route, Some("3,214.7 USDC"), Some("USDC")));
    g.solvers.push(PathVizSolverBid {
        name: "odos-solver".into(),
        winner: true,
        executed_sell_atoms: Some("1000000000000000000".into()),
        executed_buy_atoms: Some("3214700000".into()),
    });
    g.surplus = Some(Surplus {
        amount_atoms: "14700000".into(),
        token_symbol: "USDC".into(),
        amount_display: Some("14.7 USDC".into()),
        percent: Some(0.0046),
    });
    g
}

/// Scenario 2: a batch of three orders and a losing solver bid (still no
/// venue column: quote-time discloses solver names only).
fn multi_order_batch() -> PathVizGraph {
    let mut g = PathVizGraph::new();
    // Inputs.
    g.nodes.push(token("in:weth", "WETH", 0, "0x4200000000000000000000000000000000000006"));
    g.nodes.push(token("in:usdc", "USDC", 0, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"));
    g.nodes.push(token("in:op", "OP", 0, "0x4200000000000000000000000000000000000042"));
    // Solvers.
    g.nodes.push(other("s:win", "odos-solver", 1, PathVizNodeKind::Solver));
    g.nodes.push(other("s:lose", "baseline", 1, PathVizNodeKind::Solver));
    // Outputs.
    g.nodes.push(token("out:usdc", "USDC", 3, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"));
    g.nodes.push(token("out:weth", "WETH", 3, "0x4200000000000000000000000000000000000006"));
    g.nodes.push(token("out:dai", "DAI", 3, "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"));
    // Winning routes.
    g.links.push(link("in:weth", "s:win", PathVizLinkKind::Route, Some("2.0 WETH"), Some("WETH")));
    g.links.push(link("in:usdc", "s:win", PathVizLinkKind::Route, Some("5,000 USDC"), Some("USDC")));
    g.links.push(link("in:op", "s:win", PathVizLinkKind::Route, Some("1,200 OP"), Some("OP")));
    g.links.push(link("s:win", "out:usdc", PathVizLinkKind::Route, Some("6,430 USDC"), Some("USDC")));
    g.links.push(link("s:win", "out:weth", PathVizLinkKind::Route, Some("1.55 WETH"), Some("WETH")));
    g.links.push(link("s:win", "out:dai", PathVizLinkKind::Route, Some("2,510 DAI"), Some("DAI")));
    // A losing bid for the WETH order.
    g.links.push(link("in:weth", "s:lose", PathVizLinkKind::Bid, None, Some("WETH")));
    g.solvers.push(PathVizSolverBid {
        name: "odos-solver".into(),
        winner: true,
        executed_sell_atoms: None,
        executed_buy_atoms: None,
    });
    g.solvers.push(PathVizSolverBid {
        name: "baseline".into(),
        winner: false,
        executed_sell_atoms: None,
        executed_buy_atoms: None,
    });
    g.surplus = Some(Surplus {
        amount_atoms: "31200000".into(),
        token_symbol: "USDC".into(),
        amount_display: Some("31.2 USDC".into()),
        percent: Some(0.0051),
    });
    g
}

/// Scenario 3: a SETTLED batch. Full 4-column story including the on-chain
/// venue column and a peer-to-peer "matched in batch" ribbon, plus a fee.
fn settled_with_venues() -> PathVizGraph {
    let mut g = PathVizGraph::new();
    // Inputs.
    g.nodes.push(token("in:weth", "WETH", 0, "0x4200000000000000000000000000000000000006"));
    g.nodes.push(token("in:usdc", "USDC", 0, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"));
    // Winning solver.
    g.nodes.push(other("s:win", "odos-solver", 1, PathVizNodeKind::Solver));
    // Venues (registry labels; one degraded to a bare address on purpose).
    g.nodes.push(other("v:uni", "Uniswap v3 0.05%", 2, PathVizNodeKind::Venue));
    g.nodes.push(other("v:velo", "Velodrome", 2, PathVizNodeKind::Venue));
    g.nodes.push(PathVizNode {
        id: "v:unknown".into(),
        label: "0x9c12939390052919aF3155f41Bf4160Fd3666A6f".into(),
        kind: PathVizNodeKind::Venue,
        column: 2,
        address: Some("0x9c12939390052919aF3155f41Bf4160Fd3666A6f".into()),
    });
    // Outputs.
    g.nodes.push(token("out:usdc", "USDC", 3, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"));
    g.nodes.push(token("out:weth", "WETH", 3, "0x4200000000000000000000000000000000000006"));
    // Settled flows.
    g.links.push(link("in:weth", "s:win", PathVizLinkKind::Route, Some("2.0 WETH"), Some("WETH")));
    g.links.push(link("in:usdc", "s:win", PathVizLinkKind::Route, Some("6,430 USDC"), Some("USDC")));
    g.links.push(link("s:win", "v:uni", PathVizLinkKind::Route, Some("1.2 WETH"), Some("WETH")));
    g.links.push(link("s:win", "v:velo", PathVizLinkKind::Route, Some("3,000 USDC"), Some("USDC")));
    g.links.push(link("s:win", "v:unknown", PathVizLinkKind::Route, Some("0.8 WETH"), Some("WETH")));
    g.links.push(link("v:uni", "out:usdc", PathVizLinkKind::Route, Some("3,900 USDC"), Some("USDC")));
    g.links.push(link("v:velo", "out:weth", PathVizLinkKind::Route, Some("0.94 WETH"), Some("WETH")));
    g.links.push(link("v:unknown", "out:usdc", PathVizLinkKind::Route, Some("2,530 USDC"), Some("USDC")));
    // Peer-to-peer coverage inside the batch (transfer-log evidence).
    g.links.push(link("in:weth", "out:weth", PathVizLinkKind::Matched, Some("0.06 WETH"), Some("WETH")));
    g.solvers.push(PathVizSolverBid {
        name: "odos-solver".into(),
        winner: true,
        executed_sell_atoms: Some("2000000000000000000".into()),
        executed_buy_atoms: Some("6430000000".into()),
    });
    g.surplus = Some(Surplus {
        amount_atoms: "42800000".into(),
        token_symbol: "USDC".into(),
        amount_display: Some("42.8 USDC".into()),
        percent: Some(0.0067),
    });
    g.fee = Some(Fee {
        amount_atoms: "1286000".into(),
        token_symbol: "USDC".into(),
        amount_display: Some("1.29 USDC".into()),
        bps: Some("2".into()),
    });
    g
}

fn main() {
    let out_dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&out_dir).expect("create output dir");

    for (name, graph) in [
        ("single-order", single_order()),
        ("multi-order-batch", multi_order_batch()),
        ("settled-with-venues", settled_with_venues()),
    ] {
        let svg = render_svg(&graph, None).expect("render");
        let path = out_dir.join(format!("{name}.svg"));
        fs::write(&path, &svg).expect("write svg");
        println!("wrote {} ({} bytes)", path.display(), svg.len());
    }
}
