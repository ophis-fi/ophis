# ⚠️ GPv2AllowListAuthentication artifacts are stale (pre-upgrade)

The committed `GPv2AllowListAuthentication*.json` artifacts in this directory
**predate the two-step-manager upgrade** and do not describe the live contract.

Verified on-chain (Optimism mainnet, 2026-05-25):

| | Address |
|---|---|
| Proxy | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` |
| Implementation (live) | `0x59eE2de83b559e5cC2Afb930F29abeA3dBB4cc9D` |
| Manager | `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` |

The live implementation includes the **two-step manager transfer**
(`proposeManager` / `acceptManagership` / `cancelManagerTransfer` /
`pendingManager`) — confirmed because `pendingManager()` resolves on-chain
against the proxy. The matching source is `contracts/src/contracts/GPv2AllowListAuthentication.sol`.

What is stale:

- `GPv2AllowListAuthentication_Implementation.json` lists the **previous** impl
  `0xFAB54856B6731BC0C32904BE5297A627d9FDFA31` with the stock ABI (no
  `pendingManager`).
- `GPv2AllowListAuthentication.json` has the correct proxy address but the stock
  ABI.

**Action:** regenerate these via the deploy/verify tooling so `address`, `abi`,
`bytecode`, `storageLayout`, and `receipt` all reflect impl
`0x59eE2de83b…`. They were intentionally **not** hand-edited: a partial edit
(address/abi only) would leave the bytecode/receipt/transactionHash fields
describing the old impl — an internally inconsistent record that breaks
bytecode-verification tooling.
