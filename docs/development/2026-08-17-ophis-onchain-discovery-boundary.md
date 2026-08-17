# Ophis onchain discovery boundary

Status: local prototype, disabled by default, not released.

## Outcome

Milestone A now has an isolated Ethereum discovery reader and display panel. The panel is informational only. It cannot select a token, create a route, change solver eligibility, add a token to a list, request an approval, or submit a transaction.

The feature has no enabled default. It mounts only when `isOphisOnchainDiscoveryEnabled === true`, and it renders data only on Ethereum mainnet after every source check succeeds.

## Why Ethereum only

The verified registry and ranking lens are Ethereum mainnet deployments. Their source manifest explicitly treats other-chain deployments as separate instances with different initial state. Reusing an address, ABI, or list from Ethereum on another chain would therefore be an unsupported assumption.

No other chain is enabled in this milestone. Adding one requires a separate decision record with:

1. a live registry and lens on that chain;
2. independently verified runtime hashes for the registry, lens, and ranking state;
3. verified lens wiring;
4. chain-specific provenance and curation semantics;
5. an exact-block RPC test against at least two independent providers;
6. the same adversarial fixtures and UI disclaimer;
7. explicit product approval.

Discovery on another chain still would not imply Ophis routing or settlement support there.

## Pinned Ethereum source

The primary-source deployment manifest and contract source were reviewed from the [upstream repository](https://github.com/z-fi/zFi). The repository contains a stale standalone lens address file, so Ophis does not consume that file. The current deployment manifest was checked against live contract getters and runtime bytecode on 2026-08-17.

| Contract role | Address                                      | Runtime code hash                                                    |
| ------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Registry      | `0x0000006013dF75A31678B786061C2B54bf531524` | `0x10477f53cc82e19a81783dd087272c53ac293855c9fe094366ef740852897e7f` |
| Ranking lens  | `0x000000B73c767CA6F490a666E88D43579579351b` | `0xfb5d7d8a386ab97dd99f74a6519788175bad419cd298630fc13680474828735a` |
| Ranking state | `0x0000006D936bA3653b8854490E16E782cd32a9a8` | `0xf1c9cbbc1e87295c9d16814aa9fce98729d71f2c8793c8299b4c167a9a2cd70f` |

The hashes matched independently through three public Ethereum RPC providers. The lens getters also returned the pinned registry and ranking-state addresses. A code-hash or wiring mismatch makes the reader unavailable and produces no rows.

## Read protocol

Every load uses one Ethereum block context:

1. Read the latest block number and hash.
2. Read all three runtimes at that block and compare their hashes.
3. Read and verify the lens's registry and ranking-state getters at that block.
4. Call only `summariesPaged(0, 12)` at that block.
5. Bound the call to 2,000,000 gas and 32 KiB of returndata.
6. Parse at most 12 rows.
7. Check that every retained address still has bytecode at that block.
8. Re-read the block by number and require the same hash.

The hook has an eight-second UI timeout, does not poll, does not retry automatically, and drops results on route-chain changes. A late completion cannot repopulate a stale chain.

## Accepted row shape

A row is displayed only when all of these are true:

- EVM account namespace;
- Ethereum chain ID;
- ERC-20 metadata standard;
- deployed and metadata-synced flags;
- right-aligned 20-byte address in the 32-byte account field;
- non-zero address with code at the pinned block;
- integer decimals from 0 through 36;
- bounded rank, name, and symbol;
- not present in the Ophis display-policy exclusion set;
- not a duplicate `(chainId, address)` row.

Control characters, bidi controls, zero-width direction marks, and angle brackets are removed from labels. Names are capped at 40 Unicode characters and symbols at 12. No source logo or URI is fetched; the panel uses a local monogram.

These checks are a display policy, not proof that a contract behaves like a safe ERC-20. In particular, they do not establish transfer semantics, balance correctness, rebasing behavior, fees, liquidity, price quality, or settlement compatibility.

## Separation from execution

The discovery module exposes a small read-only client interface with no wallet or transaction methods. A structural test rejects imports from:

- token activation/list modules;
- swap and trade modules;
- boosted-token policy;
- allowance and permit paths;
- solver configuration.

The rendered rows are plain elements. There are no links, buttons, images, navigation callbacks, or hover-to-swap actions. The visible disclaimer says discovery data is not an Ophis endorsement, route, token-list activation, or compatibility decision.

## Adversarial coverage

The local test suite covers:

- malformed values and malformed ABI returndata;
- oversized returndata;
- code-hash and source-wiring mismatches;
- wrong chains and non-EVM namespaces;
- native assets and NFT collections;
- reservations and owner-authored metadata;
- zero addresses, EOAs, hostile decimals, and invalid ranks;
- duplicate addresses and result caps;
- markup, control, bidi, and overlong text;
- block-hash changes during a read;
- absence of interactive UI and execution-layer imports.

## Promotion gate

This prototype must remain disabled until product and security review the live rows and approve the copy. Enabling display does not authorize importing a discovered token or using it in a quote. Any future import flow requires a separate explicit-consent design and token-integration review.
