# @ophis/sdk

Integration helpers for [Ophis](https://ophis.fi) — a [CoW Protocol](https://docs.cow.fi) fork with a natural-language intent layer.

> **Non-custodial.** These helpers build and guard order parameters. They never hold keys or sign on your behalf. See [Security](#security) before wiring up an automated signer.

## Install

```bash
npm install @ophis/sdk
```

## What's in it

- **`getOphisOrderbookUrl(chainId)`** — the correct orderbook host per chain. Optimism is self-hosted at `optimism-mainnet.ophis.fi`, **not** `api.cow.fi`; getting this wrong silently bypasses the Ophis solver and partner fee.
- **`getOphisOrderDomain(chainId)`** / **`getOphisSettlementAddress(chainId)`** — the EIP-712 signing domain with the correct per-chain `verifyingContract` (the OP settlement is non-canonical, so the cow-sdk default is wrong there).
- **`buildOphisAppDataPartnerFee(chainId)`** — the exact CIP-75 price-improvement fragment for `appData.metadata.partnerFee`.
- **`ophisOrderReceiver`** / **`assertReceiverIsOwner`** — pin a CoW order's `receiver` to the owner. An unpinned receiver is the #1 drain vector for an automated signer.
- **`assignTier`**, **`ophisDefaults`**, and the partner-fee constants.

## Example

```ts
import {
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  buildOphisAppDataPartnerFee,
  assertReceiverIsOwner,
} from '@ophis/sdk';

const orderbook = getOphisOrderbookUrl(10);          // https://optimism-mainnet.ophis.fi
const domain = getOphisOrderDomain(10);               // { name, version, chainId, verifyingContract }
const partnerFee = buildOphisAppDataPartnerFee(10);   // { priceImprovementBps, maxVolumeBps, recipient }

assertReceiverIsOwner(owner, order.receiver);         // throws if proceeds would leave the account
```

## Security

These are **off-chain misuse guards, not an authorization boundary** — they make the safe path the easy path, but a caller can ignore them. For an agent that signs **without** a human in the loop, enforce policy on-chain (a Safe + an EIP-1271 policy validator: pinned receiver, pinned appData/hooks, an oracle-bounded limit price, spend caps, and a guardian). See the [AI agent integration guide](https://docs.ophis.fi/ai-agents).

## License

[GPL-3.0-or-later](./LICENSE)
