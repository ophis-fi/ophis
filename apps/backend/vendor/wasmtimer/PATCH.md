# Ophis maintenance patch: wasmtimer 0.4.3

Source: the crates.io `wasmtimer 0.4.3` archive, upstream commit
`fecc90e04b1884ac6298af2cdcd2ef3f8e0141de`. The registry checksum and original
per-file SHA-256 hashes are recorded in `UPSTREAM.json`. The upstream MIT license,
copyright notices and timer code are retained.

Alloy 1.x depends on this version for WASM targets. Its two structural pinning
modules used the archived `pin-utils` crate (RUSTSEC-2026-0441). This local patch
replaces those projections with maintained `pin-project-lite`, retaining both
fields' pinning, future-first timeout polling, public accessors and conditional
`Unpin` behavior. No timer scheduling, JavaScript clock or production native
backend behavior is changed. Cargo's advisory/source policies are unchanged.

Only `Cargo.toml`, `src/tokio/interval.rs` and `src/tokio/timeout.rs` differ from
the upstream runtime package. `tests/pinning.rs` compiles the exact changed
modules against a host clock and verifies ready-versus-expired precedence,
pending timeout, accessors, `!Unpin` address stability, and interval tick/reset.
The doctest rejects `Timeout<!Unpin>: Unpin`; unchanged upstream WASM tests
remain in `tests/web.rs` for platform testing.

Run the local projection checks with:

```sh
cargo +1.96.1 fetch --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml
cargo +1.96.1 test --offline --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml --test pinning
cargo +1.96.1 test --offline --locked --manifest-path apps/backend/vendor/wasmtimer/Cargo.toml --doc
```

The standalone test lockfile is committed. The existing backend CI job fetches
it, runs both checks offline/locked (including the expected E0277 diagnostic),
and checks the crate on `wasm32-unknown-unknown` before the whole backend check.
The existing Security workflow also scans this lock with OSV/cargo-audit and
checks its manifest with the same strict cargo-deny advisory/source policy.

Revisit this patch when a maintained upstream release removes `pin-utils`, or
when Alloy can be upgraded without changing Ophis's supported API and behavior.
