# weiroll VM — deterministic redeploy artifact

`WeirollVM.initcode` is the **exact creation bytecode** of the weiroll VM,
used to reproduce it at its canonical address on Ophis's Across source chains
via byte-exact CREATE2 replay.

| | |
|---|---|
| Canonical address (all chains) | `0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963` |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` (Arachnid proxy) |
| salt | `0x00…00` |
| initcode bytes | 5870 |
| keccak(initcode) | `0xe75ac6f040cd215056d2bc738bcd01734bd61386858d685a8d95084e87bc66ed` |

`0x9585c3…5963` is the address `@cowprotocol/sdk-weiroll` hardcodes as
`WEIROLL_ADDRESS` — a single chain-independent constant. The Across deposit
post-hook is a `DELEGATECALL` to it, so bridging FROM a chain requires this VM
deployed at exactly this address. It has no constructor args (chain-agnostic;
it stores its own address as an immutable via the `ADDRESS` opcode at
construction), which is why the runtime is byte-identical on every chain.

## Why this exists

The 2026-08-13 incident: Ink/Linea were enabled as Across sources with the
SpokePool + CoW Shed factory + math helper deployed, but this VM — the actual
`delegatecall` target of the deposit plan — was **not** deployed there. A
delegatecall to a codeless address returns success, so the deposit silently
no-op'd and the swap proceeds stranded in the user's CoW Shed. This VM is the
missing fourth chain-local Across dependency.

## Provenance

Extracted from the Ethereum mainnet contract-creation transaction
`0x6e22d6584ebfad16a5d222ae5e52c901b8a2a90f4948e41fc573b4c3f37adbe7`
(`to` = the Arachnid proxy; input = 32-byte zero salt ++ initcode), and
cross-checked byte-identical against Arbitrum's on-chain creation bytecode for
the same address. solc 0.8.27.

## Verification

`test/DeployWeirollVM.t.sol` asserts `CREATE2(proxy, 0, keccak(initcode))`
equals the canonical address; `script/DeployWeirollVM.s.sol` re-asserts it
before broadcasting, and only broadcasts on the intended source chains.
