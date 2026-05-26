# GPv2AllowListAuthentication artifacts — regenerated 2026-05-26

These `GPv2AllowListAuthentication*.json` artifacts were regenerated to describe
the live two-step-manager implementation on Optimism (they previously described
the pre-upgrade impl `0xFAB54856…`).

On-chain state (Optimism mainnet, verified 2026-05-26):

| | Address |
|---|---|
| Proxy | `0xAAA13bC6C1A505ccE6B4BF262fdDf4c703B9BD70` |
| Implementation | `0x59eE2de83b559e5cC2Afb930F29abeA3dBB4cc9D` |
| Manager | `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF` |

## How they were regenerated

The **implementation's** compiled fields (abi, bytecode, deployedBytecode,
metadata, storageLayout, devdoc, userdoc) were produced from
`src/contracts/GPv2AllowListAuthentication.sol` with the exact deploy settings —
**solc 0.7.6, evmVersion istanbul, optimizer 1,000,000 runs** — and **verified
against chain**: the regenerated
`deployedBytecode` hashes to
`0xeebc795ab56337e75100295fbf151056e7473cd40a35487e59ae63f08b86ff27`,
byte-for-byte equal to the live implementation's `EXTCODEHASH`.

- `_Implementation.json` → address `0x59eE2de83b…`; ABI now includes
  `proposeManager` / `acceptManagership` / `cancelManagerTransfer` /
  `pendingManager`; storageLayout includes the appended `pendingManager` slot.
- `GPv2AllowListAuthentication.json` (combined) → `implementation` repointed to
  `0x59eE2de83b…`; ABI merges the modified impl with the proxy's own entries
  (`upgradeTo`, `owner`, `ProxyImplementationUpdated`, …). The proxy's own
  bytecode/metadata/args are unchanged — the proxy itself was not redeployed.
- `_Proxy.json` → unchanged; its constructor args correctly record the proxy's
  original deployment (initial impl `0xFAB54856…`), which the later upgrade
  does not alter.

## Caveat

The implementation was upgraded **outside hardhat-deploy** (no local deploy
record, and the impl's creation tx is not retrievable from the public RPC), so
`_Implementation.json`'s `receipt` / `transactionHash` / `solcInputHash`
deploy-tracking fields are intentionally **omitted** rather than fabricated. No
deploy script targets this contract, so hardhat-deploy will not attempt a
redeploy from their absence. Every field present is authoritative and verified.
