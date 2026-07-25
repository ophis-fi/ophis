//! Server-side batch/surplus visualization for Ophis (pathviz).
//!
//! Renders a Sankey-style SVG of how an order (or a whole settled batch)
//! flowed through the solver competition and on-chain venues, plus the
//! surplus callout ("surplus returned vs your signed minimum").
//!
//! Design constraints:
//! - Pure: no I/O, no async, no clock. Callers assemble a
//!   [`model::pathviz::PathVizGraph`] and pass it in; this crate only lays
//!   out and renders. This keeps a wasm build possible for CoW-hosted
//!   chains (owner decision 24).
//! - Hostile inputs: token symbols and venue labels come from on-chain
//!   ERC-20 metadata / a registry and are treated as attacker-controlled.
//!   Everything is XML-escaped (see [`escape`]); a `</svg><script>` symbol
//!   must render inert.
//! - Clean-room renderer: the layout is hand-rolled (4 columns, cubic
//!   Beziers). No d3 or d3-sankey code was ported or consulted; do not
//!   introduce ports of either when modifying this crate.

pub mod escape;
pub mod layout;
pub mod svg;
pub mod theme;

pub use {
    model::pathviz::{
        Fee, PathVizGraph, PathVizImageConfig, PathVizLink, PathVizLinkKind, PathVizNode,
        PathVizNodeKind, PathVizSolverBid, SCHEMA_VERSION, Surplus,
    },
    svg::{RenderError, render_svg, svg_to_base64},
    theme::Theme,
};
