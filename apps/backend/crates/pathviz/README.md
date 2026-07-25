# pathviz

Pure, I/O-free render crate for Ophis route/surplus visualization
(`PathVizGraph` -> themeable SVG). Server-rendered, Sankey-style, with the
solver-competition column and the surplus callout ("surplus returned vs
your signed minimum") that the Odos surface could not draw.

## Clean-room / no-port rule (LICENSE-critical)

The 4-column layout and the cubic-Bezier link routing in `layout.rs` are
hand-rolled. **No `d3`, `d3-sankey`, or `odos-path-viz` source was ported,
transliterated, or consulted while writing this crate.** Do not introduce
such a port when modifying it. The wire-name parity with Odos
(`pathViz`, `pathVizImage`, `pathVizImageConfig`, the hex-color regex) is an
interface-compatibility choice and carries no code from any other project.

## Purity constraints (keep the wasm build possible)

This crate MUST stay free of I/O, async, network, filesystem, and clock
access (owner decision 24: no separate viz Worker; a later wasm32 build
serves CoW-hosted chains). Callers assemble a `model::pathviz::PathVizGraph`
from their own data sources and pass it in. The only dependencies are
`serde`, `serde_json`, `base64`, and the pure-data `model` crate.

## Hostile inputs

Token symbols and venue/solver labels come from on-chain `symbol()` strings
and a human-maintained registry. They are treated as attacker-controlled:
everything routed through `escape.rs` before it lands in an SVG attribute or
text node. A `</svg><script>` symbol renders as inert text. The output is
self-contained (no external references), so the `.svg` endpoint can serve it
under `Content-Security-Policy: default-src 'none'` with `nosniff`.

## Rendering the reference fixtures

    cargo run -p pathviz --example render_fixtures -- <output-dir>

writes `single-order.svg`, `multi-order-batch.svg`, and
`settled-with-venues.svg` for visual inspection.
