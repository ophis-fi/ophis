# SQLx SQLite compatibility patch — 9 November 2026

The adjacent `sqlx-sqlite/` directory contains the complete published 0.8.6 crate. Its Rust
source, feature definitions and MIT/Apache-2.0 licenses are unchanged. The only
upstream-file change is the normalized `Cargo.toml` dependency constraint:

```diff
 [dependencies.libsqlite3-sys]
-version = "0.30.1"
+version = "=0.39.1"
```

The backend enables PostgreSQL, not SQLite. Nevertheless, Cargo resolves SQLx's
optional SQLite driver into its lockfile. `libsqlite3-sys` 0.30.1 bundles an affected
SQLite version under [RUSTSEC-2026-0459](https://rustsec.org/advisories/RUSTSEC-2026-0459.html).
The fixed 0.39.1 bundles SQLite 3.54.1. Published SQLx 0.9.0 still requires
`libsqlite3-sys <0.38.0`; upgrading SQLx alone does not address this advisory.
This compatibility patch upgrades the actual dependency instead of suppressing
the advisory or removing an entry that Cargo still resolves.

Provenance:

- Published archive: <https://static.crates.io/crates/sqlx-sqlite/sqlx-sqlite-0.8.6.crate>
- Archive SHA-256: `c2d12fe70b2c1b4401038055f90f151b78208de1f9f89a7dbfd41587a10c3eea`
- Upstream commit recorded by the archive: `bab1b022bd56a64f9a08b46b36b97c5cff19d77e`
- All 56 shipped files are retained. Only the normalized manifest differs;
  `Cargo.toml.orig` is preserved as the original upstream record.
- Fixed `libsqlite3-sys` 0.39.1 archive checksum, also pinned in `Cargo.lock`:
  `14a5f01b87b92705d07b433c06f96cbc764637d81a0bffb5734ce17cf0f9a2b3`.

Validation used Rust/Cargo 1.95.0. A separate workspace compiled this exact driver
with bundled SQLite and ran its 10 library tests with `bundled,chrono,migrate,regexp`.
A real in-memory SQLx connection returned `sqlite_version() = 3.54.1` and passed
parameter binding, commit, rollback, unique-constraint error recovery and regexp
queries. `SQLX_OFFLINE=true cargo check --locked -p database` passed. The active
all-target PostgreSQL graph contains neither SQLite package; comparison of the
old and new lockfiles confirms all other package records remain unchanged.
`cargo audit` reported zero unignored vulnerabilities with the current advisory
database, using the repository's existing policy without adding an exception.

The patch does not enable SQLite in the backend. If enabled later, the fixed FFI
crate requires Rust 1.88 or newer. This bundled-library fix does not update a
separately installed system SQLite and makes no claim about SQLCipher.

Remove the local patch when a compatible published SQLx driver accepts a fixed
`libsqlite3-sys` release. Recheck the archive checksum, exact source difference,
bundled-library version, driver tests, PostgreSQL graph and security gates when
updating it. Do not broaden this vendor patch into unrelated driver changes.
