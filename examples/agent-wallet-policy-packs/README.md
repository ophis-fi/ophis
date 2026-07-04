# Ophis agent wallet policy packs

Ready-made spending policies that constrain an agent-controlled wallet so its
key can only sign Ophis trades. Two providers are covered:

- [`turnkey/`](./turnkey/) - Turnkey policy-engine policies.
- [`privy/`](./privy/) - a Privy wallet / session-signer policy.

Full write-up, per-chain copy-paste, and the end-to-end trade example:
**[docs.ophis.fi/agent-wallet-policies](https://docs.ophis.fi/agent-wallet-policies)**.

## What this pack does and does not do

A static wallet policy cannot read a per-order limit price, so it cannot promise
a good fill or that the wallet "cannot lose money". What it enforces is
**anti-exfiltration pinning**. The constrained key can only produce two kinds of
signature: a one-time ERC-20 `approve` whose spender is the Ophis vault relayer,
and an Ophis order that carries the correct EIP-712 domain (name
`Gnosis Protocol`, version `v2`, and the exact per-chain settlement as
`verifyingContract`), delivers proceeds to the agent's own account (`receiver`
pinned to self), and moves only tokens on your allowlist. The result is a
**bounded blast radius**: a compromised or prompt-injected agent still cannot
drain funds to a third party, approve an arbitrary spender, or sign against a
non-Ophis contract. It **can** still sign a weak price within your token set,
and CoW/Ophis guarantee only that a fill is no worse than the signed limit, not
that the limit itself is sane. This pack bounds where value can go, not the
price it trades at. To bound execution quality too, pair it with the in-code
policy gate (limit versus an independent oracle, per-trade and rolling caps)
described in the docs.

## The two actions an Ophis agent needs

1. **A one-time ERC-20 `approve`** to the per-chain vault relayer (the contract
   that pulls the sell token at settlement). A bounded amount is recommended
   over an unlimited approval. This is the only on-chain transaction.
2. **EIP-712 order signing** (off-chain, gasless). The agent signs a CoW order;
   the swap settles without the agent paying gas.

The packs allowlist exactly these two paths and deny everything else.

## Caveat: the canonical domain is shared with CoW Swap

On the 10 non-sovereign chains, Ophis uses CoW Protocol's canonical GPv2
contracts, so the EIP-712 order domain is byte-identical to CoW Swap's. A policy
that allowlists that domain therefore authorizes CoW-native order flow on that
chain as well, not Ophis exclusively. Only **Optimism (10)** and
**Unichain (130)** run an Ophis-deployed settlement, so only those two carry an
Ophis-exclusive domain. This is a property of the shared contracts, not a gap in
the pack. If you need Ophis-exclusive routing on a shared-domain chain, enforce
the orderbook host and appData in your in-code policy gate as well.

## Addresses (the 12 live chains)

These are the values the packs pin. They are mirrored from
[`addresses.json`](./addresses.json), which CI diffs against `@ophis/sdk`
(`OPHIS_SETTLEMENT_ADDRESSES` / `OPHIS_VAULT_RELAYER_ADDRESSES`) so the pack
cannot silently drift. Addresses are EIP-55 checksummed; see the Turnkey note on
lowercasing for its EIP-712 conditions.

| Chain | ID | Settlement (`verifyingContract`) | Vault relayer (`approve` spender) |
| --- | --- | --- | --- |
| Ethereum | 1 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Optimism *(sovereign)* | 10 | `0x310784c7FCE12d578dA6f53460777bAc9718B859` | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` |
| BNB Chain | 56 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Gnosis | 100 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Unichain *(sovereign)* | 130 | `0x108A678716e5E1776036eF044CAB7064226F714E` | `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb` |
| Polygon | 137 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Base | 8453 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Plasma | 9745 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Arbitrum | 42161 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Avalanche | 43114 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Ink | 57073 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| Linea | 59144 | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |

Two further chains have settlement deployed but their orderbooks are paused
(4326 and 999), and Sepolia (11155111) is a testnet, so all three are excluded
and the packs cover the 12 live chains.

## A working trade path for the constrained wallet

The pack only says what the key may sign. To produce a valid, bounded Ophis
order to sign, use the keyless Ophis MCP server at `https://mcp.ophis.fi/mcp` (or
the `@ophis/sdk`): `build_order` returns a ready-to-sign order with the receiver
already pinned to the owner and slippage bounded against a live quote, then your
constrained wallet signs it and `submit_order` relays it. See
[`example-constrained-trade.md`](./example-constrained-trade.md) for the full
loop.

## Anti-drift check

```bash
node scripts/check-policy-pack-addresses.mjs   # from the repo root
```

The check parses the SDK address maps, compares them to `addresses.json` for all
12 live chains (exact, case-sensitive), asserts the paused/testnet chains stay
out, and confirms the address literals are present in the docs and this README.
It runs in CI (`.github/workflows/security.yml`).
