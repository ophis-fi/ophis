# Ophis maintenance patch: wasmtimer 0.4.3

Source: the crates.io `wasmtimer 0.4.3` archive, upstream commit
`fecc90e04b1884ac6298af2cdcd2ef3f8e0141de`. The registry checksum and original
per-file SHA-256 hashes are recorded in `UPSTREAM.json`. The upstream MIT license,
copyright notices and timer code are retained.

Alloy 1.x depends on this version for WASM targets. Its two structural pinning
modules used the archived `pin-utils` crate (RUSTSEC-2026-0441). This local patch
replaces those projections with maintained `pin-project-lite`, retaining both
fields' pinning, future-first timeout polling, public accessors and conditional
`Unpin` behavior. Cargo's advisory/source policies are unchanged.

Follow-up review also corrects two inherited WASM scheduling defects in
`src/timer/global.rs`: the callback-count limit must not postpone an earlier
heap deadline behind a later pending callback, and JavaScript delays above
`i32::MAX` milliseconds must clamp to that maximum rather than spin at zero.
An event-loop-local registry owns the JavaScript handles and droppable Rust
closures. It caps pending callbacks at 20 per timer on that event loop. A full
queue coalesces a later wake; an earlier wake cancels the latest obsolete timeout
with `clearTimeout` and drops its closure before replacement. Fired callbacks
hold their closure through processing and remove only their own ID. This avoids
both postponed deadlines and unbounded captures during repeated earlier resets.
JS objects remain outside the `Send + Sync` timer/waker; no unsafe wrapper or
new dependency is added. The paused-clock synchronous recursion bound remains.
Long timers recheck the heap after the clamped callback. The JS clock and public
timer APIs are unchanged. Native Ophis backend scheduling is unchanged: its
locked Alloy consumers select this dependency only for WASM/unknown targets.

Both interval constructors continue to accept zero periods. `Skip` preserves
that immediately-ready behavior after a late tick instead of dividing by zero.

`Cargo.toml`, `src/js.rs`, `src/timer/global.rs`, `src/tokio/interval.rs` and
`src/tokio/timeout.rs` differ from the upstream runtime package. Original archive
hashes remain in `UPSTREAM.json`; `patchedFiles` records the maintained source
and regression hashes. `tests/pinning.rs` compiles the exact changed
modules against a host clock and verifies ready-versus-expired precedence,
pending timeout, accessors, `!Unpin` address stability, interval tick/reset and
late zero-period `Skip`. Its imports and tests are gated on the `tokio` feature.
`tests/scheduling.rs` compiles the exact global driver, heap and intrusive list
against a deterministic host clock and JS callback adapter. It verifies saturated
late callbacks cannot postpone an earlier timer, later wakes remain bounded,
long delays clamp and recheck, ordinary delays are unchanged, and paused-clock
recursion remains bounded. One timer reset earlier 1,000 times retains at most
20 pending handles/owned closures, fires at its earliest deadline, and releases
the remaining callbacks. These are source-level host tests, not a real browser
event-loop or cross-worker cancellation test. Ophis targets the standard
non-atomics `wasm32-unknown-unknown` environment; JS cancellation stays local to
each worker's event loop.
The doctest rejects `Timeout<!Unpin>: Unpin`; unchanged upstream WASM tests
remain in `tests/web.rs` for platform testing.

Run the local projection checks with:

```sh
cargo +1.96.1 fetch --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml
cargo +1.96.1 test --offline --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml --test pinning --test scheduling
cargo +1.96.1 test --offline --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml --features tokio-test-util --test scheduling -- --test-threads=1
cargo +1.96.1 test --offline --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml --no-default-features --tests
cargo +1.96.1 test --offline --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml --doc
cargo +1.96.1 check --offline --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml --target wasm32-unknown-unknown --all-features
```

The standalone test lockfile is committed. The existing backend CI job fetches
it, runs these host/feature checks offline/locked (including the expected E0277 diagnostic),
and checks the crate on `wasm32-unknown-unknown` before the whole backend check.
The existing Security workflow also scans this lock with OSV/cargo-audit and
checks its manifest with the same strict cargo-deny advisory/source policy.

Revisit this patch when a maintained upstream release removes `pin-utils`, or
when Alloy can be upgraded without changing Ophis's supported API and behavior.
