# Ophis Quote Lab Milestone A validation

**Date:** 2026-08-16

**Scope:** Local, read-only Ethereum measurement foundation

**Publication/deployment:** None

## Source provenance

- Reviewed source: `https://github.com/z-fi/zRouter`
- Reviewed commit: `949d43bfafea78d71a8a22b85057724383caf525`
- Current source fixture:
  `0x0180Fe9Ae92Cd04dA670F974DE9d928EA69CfA66`
- Prior research fixture:
  `0x0000002d9a651b729e3aFBE57Fc84FFDa4a98a13`
- Fixed historical fixture:
  `0xc7a03f9ed2be5feea18ce93e12f4f05c98287c16`

The manifest preserves all three under Ophis fixture IDs. “Current” means named
by the reviewed source at that commit; it does not imply that a quote succeeds
or that the contract is safe to execute through.

## Runtime provenance check

The read-only verifier checked 11 quote, router, helper, pool, factory, and lens
contracts at Ethereum block `25770359`, hash
`0x007f6b48332e6f6001d39942b10d296364d5479c47b97976e12feb3cfb0c98b7`.
Every runtime code hash matched the checked-in manifest.

The verifier used EIP-1898 block-hash selectors with
`requireCanonical = true`. No transaction or state-changing RPC method was
available to the client.

## Same-block quote smoke test

Input:

- pair: WETH → USDC;
- exact input: `1_000_000_000_000_000_000` wei;
- block: `25770365`;
- block hash:
  `0xcf99abac4c7c3415877fdba67cbb31b6b61b54c7ab77935e4ade8d953fe76975`.

| Ophis fixture | Result | Latency | Best candidate |
|---|---:|---:|---|
| Fixed historical | Success, 14 candidates | 209.451 ms | Uniswap V3, 1 bp, `1,879,024,532` USDC base units |
| Prior Ethereum | Success, 14 candidates | 243.606 ms | Uniswap V3, 1 bp, `1,879,024,532` USDC base units |
| Current Ethereum | Revert | 195.499 ms | None |

The first two fixtures returned byte-equivalent decoded candidate values for
this input. The current fixture returned RPC error code `3`,
`execution reverted`.

This is a smoke-test observation, not a final availability conclusion. The
next milestone records the failure in a multi-pair, multi-notional matrix. It
must remain visible in failure-rate metrics rather than being retried away or
replaced silently.

## Local verification commands

From `apps/backend`:

```sh
cargo test -p ethrpc block_context --lib
cargo test -p ophis-quote-lab
cargo check -p solvers

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  verify

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  compare \
  --source ophis-fixture-fixed \
  --source ophis-fixture-prior \
  --source ophis-fixture-current \
  --token-in 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --token-out 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --amount 1000000000000000000
```

## Milestone boundary

Implemented:

- versioned Ethereum deployment/provenance manifest;
- fail-closed runtime code-hash verification;
- shared block context and canonical EIP-1898 reads;
- removal of the moving `latest` selector from the direct Uniswap V4 quote;
- exact-input, same-block Ophis Quote Lab observations; and
- Ophis Lite versioning ADR.

Not implemented or authorized:

- a solver execution lane for the observed external stack;
- opaque calldata acceptance or local router encoding;
- transaction simulation or submission;
- an Ophis Lite contract or frontend; or
- any push, pull request, deployment, or release.
