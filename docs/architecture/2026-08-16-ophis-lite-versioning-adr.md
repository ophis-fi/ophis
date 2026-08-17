# ADR: Versioned Ophis Lite fallback interface

**Date:** 2026-08-16

**Status:** Proposed for local prototype; no deployment authorized

**Scope:** Milestone A architecture only

## Context

Ophis needs a dependency-light fallback interface that remains independently
retrievable even if the primary web deployment is unavailable. The interface
must not overstate what is decentralized: CoW Protocol order construction can
run in the browser, but order submission, solver competition, and status reads
still depend on offchain services and a wallet-provided Ethereum RPC.

The architecture evaluates two useful ideas:

1. fixed-version UI bytes stored in contract bytecode; and
2. an optional resolver that follows a delayed version lineage.

Those ideas are independent from any external router or approval model. Ophis
Lite remains an intent-signing frontend for the existing Ophis/CoW Settlement
architecture.

## Standards status

ERC-5219 is the published Contract Resource Requests standard and defines a
general read-only `request(...)` interface with HTTP-like responses. The
`html()` convenience getter is not part of ERC-5219.

As of this ADR, `ERC-8244` and an associated canonical `html()` specification
could not be found in the canonical Ethereum ERC repository. Ophis must not
claim ERC-8244 compliance unless a canonical proposal is later identified,
pinned, and reviewed. A simple `html()` getter may still be implemented as an
Ophis-specific convenience interface. ERC-5219 support, if added, is a separate
adapter decision.

## Decision

### 1. Fixed versions are the trust anchor

Each Ophis Lite release gets a new, non-upgradeable root address. A version
root's content-addressed chunk list is fixed at construction and cannot be
edited, reordered, or replaced. Calling the version directly always returns
the same HTML bytes.

The root exposes at minimum:

- `html()` returning the assembled document;
- `contentHash()` returning `keccak256(html)`;
- `chunkCount()` and `chunk(index)` for independent verification; and
- `version()` as display metadata, not as a security identity.

The contract address, runtime bytecode hash, and `contentHash()` together are
the version identity. A human-readable version string is never sufficient.

### 2. The resolver is optional convenience

A separate resolver may point users to a canonical version. It is not the
trust anchor and must never make a fixed version mutable.

Resolver state transitions:

| Function | Caller | Effect | If nobody calls |
|---|---|---|---|
| `proposeNext(version, contentHash)` | Ophis governance | Starts one pending transition | Current version remains active |
| `cancelPending()` | Ophis governance | Cancels before activation | Pending transition can later be activated |
| `activatePending()` | Anyone | Activates after the delay and exact hash check | Resolver remains on the prior version |
| `resolve()` | Anyone, read-only | Returns active version and content hash | No state changes |

Requirements:

- minimum delay: 72 hours in the prototype;
- one pending transition at a time;
- proposal binds both version address and content hash;
- activation verifies the version root reports the proposed hash;
- no hidden emergency bypass or proxy upgrade;
- cancellation is allowed only before activation;
- activation is permissionless after the delay;
- the UI displays whether it was loaded from a fixed root or resolver and shows
  the resolved address/hash.

Governance compromise can select a malicious future version after the delay,
but cannot alter or disable an already deployed fixed version. Users and
integrators that require immutability should pin the fixed address.

### 3. Build output is deterministic and self-contained

The source of truth is a single HTML document built in a pinned toolchain. The
build pipeline must:

1. produce byte-identical HTML from the same source tree;
2. reject timestamps, random IDs, absolute local paths, and network-fetched
   build inputs;
3. inline JavaScript, CSS, icons, and fonts;
4. reject external scripts, analytics, mutable imports, and remote code;
5. split the final bytes deterministically below EIP-170 runtime-size limits;
6. emit a manifest containing source commit, toolchain/container digest, HTML
   SHA-256 and Keccak-256, ordered chunk hashes, init/runtime hashes, chain ID,
   and deployed addresses; and
7. reconstruct and hash-check the document before any deployment artifact is
   accepted.

No deployment key, RPC credential, analytics secret, or private orderbook key
may enter the HTML or build manifest.

### 4. Ophis Lite is not a second Ophis application stack

The fallback should reuse audited order-domain types, wallet capability logic,
Settlement/VaultRelayer addresses, and token warnings where feasible. It stays
in a separate package so the primary frontend's dependency graph is not simply
bundled into a nominally "lite" page.

Initial scope:

- Ethereum mainnet only;
- standard ERC-20 sell orders only;
- wallet discovery and EIP-712 order signing;
- existing VaultRelayer allowance status;
- explicit orderbook endpoint selection and health;
- direct links to independently verify Settlement, VaultRelayer, domain, and
  fixed UI hashes.

Excluded from the first prototype:

- direct AMM/router execution;
- ERC-6909 assets;
- arbitrary token registry activation;
- cross-chain or bridge flows;
- remote feature flags or remotely loaded token lists;
- automatic resolver following without showing the resolved identity.

### 5. Service dependencies are disclosed, not hidden

The fixed UI remains available as long as Ethereum state can be read, but an
Ophis/CoW order still needs offchain order submission and solver services.
Therefore the interface must display these states separately:

- UI bytes verified/unverified;
- wallet RPC connected/disconnected;
- expected chain selected/not selected;
- orderbook endpoint healthy/unavailable;
- order accepted/rejected/pending;
- solver/settlement status available/unavailable.

Endpoint fallback must be user-visible. A fallback may not silently change the
EIP-712 domain, Settlement address, chain ID, order payload, or fee policy.

## Security invariants

1. A fixed root's `contentHash()` and returned bytes never change.
2. Chunk ordering is immutable and duplicate/missing chunks fail construction.
3. Resolver activation cannot occur before the delay.
4. Resolver activation cannot substitute a different content hash.
5. A resolver outage or governance failure cannot disable fixed-version reads.
6. UI provenance never implies token, route, or contract endorsement.
7. The page never signs an order whose chain ID, Settlement, domain separator,
   or visible economic fields differ from the reviewed payload.
8. Offchain service availability is never described as an Ethereum guarantee.

## Verification plan for Milestone B

- deterministic build repeated in clean environments;
- byte-for-byte reconstruction from shuffled, missing, duplicate, oversized,
  and malformed chunk fixtures;
- Foundry tests for unauthorized proposal/cancellation, double proposal,
  premature activation, wrong content hash, cancellation boundary, and
  permissionless delayed activation;
- browser tests for no wallet, multiple providers, wrong chain, rejected
  signature, missing allowance, unavailable orderbook, and direct fixed-root
  loading;
- CSP and offline checks proving that no executable resource is fetched from a
  remote origin;
- comparison of displayed order fields with the final EIP-712 typed data.

## Consequences

This design gives users a permanent, verifiable version address while allowing
an explicitly weaker convenience resolver for upgrades. It does not make the
orderbook or solver network onchain, and it does not authorize any deployment.
Milestone B may implement the local deterministic build and contract prototype
only after this ADR is reviewed.
