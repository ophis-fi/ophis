# CoW Shed factory + implementation — deterministic redeploy artifacts

`COWShed.initcode` and `COWShedFactory.initcode` are the **exact creation
bytecode** CoW deployed on Ethereum mainnet, used to reproduce the CoW Shed
implementation and factory at their canonical addresses on Ophis sovereign
chains (Unichain 130, Robinhood Chain 4663) via byte-exact CREATE2 replay.

| Contract | Canonical address (all chains) | initcode bytes |
|---|---|---|
| COWShed (implementation) | `0xa2704cF562AD418Bf0453F4B662ebf6A2489eD88` | 5293 |
| COWShedFactory | `0x312f92fe5f1710408B20D52A374fa29e099cFA86` | 6501 |

`0x312f92fe…CfA86` is the address the frontend `@cowprotocol/sdk-bridging`
hardcodes as `COW_SHED_FACTORY`, so bridging FROM a chain requires exactly this
address — we cannot pick our own.

## Provenance

Extracted from the `cowdao-grants/cow-shed` repository's committed mainnet
broadcast (`broadcast/DeployAndRecord.s.sol/1/run-1752759313.json`): both were
deployed with `new X{salt: bytes32(0)}(...)`, which routes through the standard
deterministic CREATE2 proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C`. The
factory's constructor argument is the implementation address, and COWShed has no
constructor args, so both addresses are **settlement-independent** and identical
on every chain.

## Why replay instead of recompiling

The canonical addresses depend on the exact creation bytecode. cow-shed pins an
unusual profile to get reproducible addresses (solc 0.8.30, evm_version
`prague`, `via_ir`, `bytecode_hash = "none"`, `cbor_metadata = false`,
1e6 optimizer runs). Recompiling from source in a different environment risks a
byte difference that would change the address (see cowprotocol/composable-cow#93
for a real case of this). Replaying the exact mainnet initcode is
compiler-independent and byte-identical by construction.

## Verification

`test/DeployCowShed.t.sol` asserts `CREATE2(proxy, 0, keccak(initcode))` equals
each canonical address (and that the factory initcode embeds the impl address).
`script/DeployCowShed.s.sol` re-asserts the same before broadcasting anything, so
a corrupted artifact fails loudly rather than deploying a wrong address.
