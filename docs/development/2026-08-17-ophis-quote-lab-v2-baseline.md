# Ophis Quote Lab V2 direct-pair baseline

**Date:** 2026-08-17

**Scope:** Local, read-only Ethereum measurement control

**Execution/publication:** None

## Control boundary

Ophis Quote Lab now has a second independent price control. It calls the
canonical Ethereum V2 router's `getAmountsOut(uint256,address[])` function with
an exact-input, two-token path.

- Router: `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`
- Runtime code hash:
  `0xa324bc7db3d091b6f1a2d526e48a9c7039e03b3cc35f7d44b15ac7a1544c11d2`
- Function selector: `0xd06ca61f`
- Factory dependency: `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`
- Path length: exactly two tokens
- Fee recorded by the control: 30 bps

The adapter rejects fee-tier configuration, validates the returned path
length, input amount, and nonzero output, and still performs a runtime hash
check at the same canonical EIP-1898 block as every other source. It cannot
build router calldata for execution, search intermediate tokens, simulate a
settlement, sign, or submit a transaction.

The address and interface were taken from the verified-address catalog and
the official V2 periphery interface. The router runtime hash matched on three
independent Ethereum RPC providers before it was pinned.

## Historical provenance replay

The expanded matrix previously observed two aggregate wins labelled as V2 at
Ethereum block `25774279`, hash
`0x6003f6948e82ad8ea6d0d90fc25ff8662aa3b0628b61fc9328cd8f172d5164e0`.
Direct historical calls to the canonical router produced exact matches:

| Case | Aggregate output | Direct V2 output | Match |
| --- | ---: | ---: | ---: |
| USDC→WETH, 100 USDC | `52,535,377,619,298,763` wei | `52,535,377,619,298,763` wei | Exact |
| DAI→WETH, 1,000 DAI | `525,267,249,022,389,516` wei | `525,267,249,022,389,516` wei | Exact |

The replay returned the same values through two independent RPC providers.
This validates the aggregate source's venue label for those observations. It
does not establish positive net surplus because execution gas and settlement
overhead remain unmodelled.

## Latest-block five-source run

The 30-case expanded matrix was repeated after adding the direct control:

- Block: `25774307`
- Hash: `0x4017335de8ce9b35f17f6eb91a77aed9ff3f146e269f67ad8fe97a46b7365a22`

| Ophis source | Success | Winning cases | Outright wins | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed fixture | 30/30 | 30 | 0 | 42.254 ms | 222.781 ms |
| Prior fixture | 30/30 | 30 | 0 | 41.700 ms | 218.620 ms |
| Current fixture | 20/30 | 20 | 0 | 37.697 ms | 175.554 ms |
| V3 baseline | 30/30 | 29 | 0 | 135.422 ms | 257.474 ms |
| V2 direct baseline | 30/30 | 0 | 0 | 31.901 ms | 39.185 ms |

Market state had moved by this later block: V3 was better than direct V2 for
the two historical V2-winning cases. This is why provenance was replayed at
the original block rather than inferred from a different state.

The direct V2 calls all returned successfully, including very low-liquidity
pairs with economically poor output. Availability alone is not a quality
signal. The current aggregate fixture again reverted in all ten USDC-related
cases.

## Validation

- `cargo test -p ophis-quote-lab`: 10 passed
- `cargo clippy -p ophis-quote-lab --all-targets -- -D warnings`: passed;
  only two pre-existing invalid-path warnings from the workspace Clippy config
- all 13 pinned Ethereum runtimes matched at block `25774306`, hash
  `0xda203cd8febb1e360cf515ef3c6d0255bf0e7104dce66395d686bd0a72507fb3`

## Decision

Decision Gate 1 remains closed. The V2 control resolves venue provenance for
two historical observations, but the evidence still lacks repeated
time-window sampling, a direct V4 control, and an end-to-end gas model. No
execution adapter, push, pull request, deployment, or release is authorized.
