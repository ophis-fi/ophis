---
id: partners
title: Partner integration (SDK)
description: Add Ophis as a swap route inside your own tool with @ophis/sdk plus cow-sdk. Works on Optimism (self-hosted) and every CoW-hosted chain, signs with a vault Safe via EIP-1271, and earns a cross-chain WETH rebate.
sidebar_label: Partner integration
sidebar_position: 4
---

# Partner integration (SDK)

This guide is for teams that run their **own** swap or treasury tool (for
example a vault rebalancing console) and want to route orders through Ophis,
charge the Ophis fee, and earn a rebate, signing with a smart-contract wallet
(a Safe via EIP-1271, or an MPC signer behind EIP-1271).

If you want to **embed** the Ophis swap UI instead, use the
[widget](./widget.md). The widget cannot carry a partner fee or a rebate code,
so to earn attribution you must use the SDK path described here.

The whole integration is a **standard CoW Protocol order** built with
`@cowprotocol/cow-sdk`, with a few values overridden from `@ophis/sdk`. If your
tool already places CoW orders, the changes are small.

## Install

```bash
npm i @cowprotocol/cow-sdk @ophis/sdk
# plus an EVM util lib for keccak256 + EIP-712 (ethers v6 or viem)
```

`@ophis/sdk` is dependency-free and provides only the Ophis-specific values. It
does not bundle cow-sdk, so install both. No Ophis-side deployment is required:
the Optimism orderbook and settlement already exist and are live.

## Quick start: the high-level helpers (recommended)

Since `@ophis/sdk` v0.1.0 the whole integration is a handful of helper calls that
get the silent-failure details right for you: the correct `appCode`, the partner
fee, your referral tag, wallet enrollment, the per-chain relayer / host / signing
domain, the receiver pin, and the `sendOrder` wire shape. **The same code works on
every served chain** because the helpers branch on `chainId` internally.

```ts
import { OrderBookApi, MetadataApi, SigningScheme, stringifyDeterministic } from '@cowprotocol/cow-sdk';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  enrollOphisTrader,
  buildOphisOrderMetadata,
  buildOphisOrderCreation,
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  getOphisVaultRelayer,
} from '@ophis/sdk';

// `owner` is the order owner + signer (your vault Safe, or a connected user EOA).

// 0. Register the wallet with the rebate indexer once, on wallet-connect. Without
//    this the indexer never fetches its trades and the rebate never accrues.
await enrollOphisTrader(owner);

// 1. First sell of a token: approve it to the correct Vault Relayer. On Optimism
//    getOphisVaultRelayer returns the Ophis relayer, NOT cow-sdk's canonical one.
await sellToken.approve(getOphisVaultRelayer(chainId), amount); // one-time per token

// 2. appData: appCode 'ophis' + the partner fee + your referral code in one call.
const doc = await new MetadataApi().generateAppDataDoc(
  buildOphisOrderMetadata({ chainId, referralCode: 'yourcode', isStablePair, signer: owner }),
);
const fullAppData = await stringifyDeterministic(doc); // never JSON.stringify
const appDataHash = keccak256(toUtf8Bytes(fullAppData)); // bytes32

// 3. Build your quoted order, pin the receiver to the owner, sign appData = the hash.
const order = { ...quote, receiver: owner, appData: appDataHash };
const signature = await signOrder(order, getOphisOrderDomain(chainId)); // EIP-1271 (Safe) or EIP-712 (EOA)

// 4. Submit against the right host; the wire shape (full appData string + appDataHash)
//    and the receiver drain-guard are handled for you.
const orderBookApi = new OrderBookApi({ chainId, baseUrls: { [chainId]: getOphisOrderbookUrl(chainId) } });
await orderBookApi.sendOrder(buildOphisOrderCreation({
  order,
  owner,
  fullAppData,
  appDataHash,
  signature,
  signingScheme: SigningScheme.EIP1271, // SigningScheme.EIP712 for an EOA signer
}));
```

That is the whole integration. The sections below explain what each helper does
per chain (Optimism is self-hosted, the others are CoW-hosted) and the lower-level
primitives, if you would rather wire the steps yourself.

## Two cases: Optimism vs CoW-hosted chains

Ophis serves two kinds of chain, and they differ only in **where the order is
posted** and **which settlement contract signs**:

| | Optimism (self-hosted) | CoW-hosted chains (Mainnet, Base, Arbitrum, Gnosis, Polygon, Avalanche, BNB, Linea, Plasma, Ink) |
| --- | --- | --- |
| Orderbook host | `optimism-mainnet.ophis.fi` (Ophis) | `api.cow.fi/<chain>` (cow-sdk default) |
| Settlement (EIP-712 `verifyingContract`) | Ophis `0x310784c7FCE12d578dA6f53460777bAc9718B859` | CoW canonical `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` (cow-sdk default) |
| Partner fee | `buildOphisAppDataPartnerFee(chainId)` | `buildOphisAppDataPartnerFee(chainId)` |
| Fee enforcement | Enforced floor at settlement | Carried in `appData`, validated by CoW |

On CoW-hosted chains you change **nothing** about host or settlement (cow-sdk
defaults are correct); you only add the Ophis `partnerFee` fragment. On
Optimism you also override the host and the settlement contract.

## Optimism integration

### 1. Point the orderbook at the Ophis host

```ts
import { OrderBookApi } from '@cowprotocol/cow-sdk';
import { getOphisOrderbookUrl } from '@ophis/sdk';

const orderBookApi = new OrderBookApi({
  chainId: 10,
  // optimism-mainnet.ophis.fi, NOT api.cow.fi. The CoW host does not serve
  // Ophis on Optimism: it would bypass our solver and charge no Ophis fee.
  baseUrls: { 10: getOphisOrderbookUrl(10) },
});
```

### 2. Build the appData with the Ophis partner fee

```ts
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/cow-sdk';
import { keccak256, toUtf8Bytes } from 'ethers';
import { buildOphisAppDataPartnerFee, ophisVolumeBpsForPair, OPHIS_PARTNER_FEE_RECIPIENT } from '@ophis/sdk';

// The standard fragment is { volumeBps: 10, recipient }, the CIP-75 Volume shape:
//   const partnerFee = buildOphisAppDataPartnerFee(10);
// On a SAME-CHAIN STABLECOIN pair, charge the reduced 1 bp rate instead. The SDK
// is chain-only and cannot detect the pair, so you decide isStablePair and pass it
// to ophisVolumeBpsForPair (1 bp stable-stable, else 10 bps):
const partnerFee = {
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  volumeBps: ophisVolumeBpsForPair(isStablePair),
};

const doc = await new MetadataApi().generateAppDataDoc({
  appCode: 'ophis', // REQUIRED: 'ophis', NOT your app's name (see "attribution" below)
  metadata: { partnerFee, hooks: {} },
});
const fullAppData = await stringifyDeterministic(doc); // deterministic, never JSON.stringify
const appDataHash = keccak256(toUtf8Bytes(fullAppData)); // bytes32, signed as order.appData
```

On Optimism the fee is an **enforced floor**. The backend rejects (HTTP 400) any
order to the Ophis recipient whose partner fee is below the floor, or that uses a
Surplus or PriceImprovement policy. Always charge **at least** the applicable
floor: 10 bps, or 1 bp for a same-chain stablecoin pair. Do not set the bps below
that, and do not drop the fee.

### 3. Sign with the Ophis EIP-712 domain

```ts
import { getOphisOrderDomain } from '@ophis/sdk';

// { name: 'Gnosis Protocol', version: 'v2', chainId: 10,
//   verifyingContract: '0x310784c7FCE12d578dA6f53460777bAc9718B859' }
const domain = getOphisOrderDomain(10);
```

The `verifyingContract` is the Ophis self-deployed GPv2Settlement on Optimism,
**not** CoW's canonical address. Signing against the canonical address produces a
domain separator the deployed contract rejects, so every order would fail.

### 4. Pin the receiver to your vault

```ts
import { assertReceiverIsOwner, ophisOrderReceiver } from '@ophis/sdk';

// For a vault, owner = the vault Safe. assertReceiverIsOwner throws unless
// order.receiver === owner (undefined / zero are treated as owner and pass), so
// proceeds land back in the vault. ophisOrderReceiver(owner) resolves it for you.
order.receiver = ophisOrderReceiver(vaultSafe);
assertReceiverIsOwner(vaultSafe, order.receiver);
```

### 5. Sign via the vault Safe (EIP-1271) and submit

The Ophis Optimism orderbook supports the `eip1271` signing scheme, so a Safe
(or an MPC signer behind EIP-1271) can sign:

1. Compute the EIP-712 order digest over the `domain` from step 3 and the `Order`
   struct (the 12 GPv2 fields: `sellToken`, `buyToken`, `receiver`, `sellAmount`,
   `buyAmount`, `validTo`, `appData`, `feeAmount`, `kind`, `partiallyFillable`,
   `sellTokenBalance`, `buyTokenBalance`).
2. Have the vault Safe produce the EIP-1271 signature (`isValidSignature`).
3. Submit with `orderBookApi.sendOrder({ ...order, from: vaultSafe, signingScheme:
   SigningScheme.EIP1271, signature, appData: fullAppData, appDataHash })` (import
   `SigningScheme` from `@cowprotocol/cow-sdk`).

The order is **signed** with `appData` set to the bytes32 hash, but the **submit
body** carries `appData` = the full JSON string and `appDataHash` = the hash.
`OrderCreation` has no `fullAppData` field; sending the hash as `appData` with no
`appDataHash` uses a deprecated form the orderbook is phasing out.

Your tool already does steps like this against CoW Swap. The only deltas are the
three overrides above (host, `verifyingContract`, `partnerFee`).

:::note One-time token approval (the first on-chain step)

Before its first CoW **sell** of a given token, the order owner approves that
token to the CoW **Vault Relayer** (the contract that pulls the sell token at
settlement). Resolve the relayer per chain with `getOphisVaultRelayer(chainId)`
from `@ophis/sdk`: it returns the canonical `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`
on CoW-hosted chains and the Ophis-operated relayer `0x83847EaB41ad9ea43809ce71569eB2e9daF51830`
on Optimism. **Do not use cow-sdk's relayer address on Optimism** (and the other
Ophis-operated chains): cow-sdk only knows the canonical relayer, but the Ophis OP
settlement pulls from the Ophis relayer, so an approval to the canonical address
leaves first sells unfillable. The `approve` moves no funds: it only lets the
relayer pull the sell token when one of your signed orders settles. It is per token
and one-time (approve a large or unlimited amount once to skip it on later trades),
and it is the only on-chain transaction; the swaps themselves are gasless. This is
standard CoW behaviour, not Ophis-specific.

:::

## Other (CoW-hosted) chains

Use cow-sdk exactly as you do today (its default `api.cow.fi` host and canonical
settlement are correct), and add **only** the Ophis partner-fee fragment:

```ts
import { buildOphisAppDataPartnerFee, ophisVolumeBpsForPair, OPHIS_PARTNER_FEE_RECIPIENT, OPHIS_FEE_CHAIN_IDS } from '@ophis/sdk';

if (OPHIS_FEE_CHAIN_IDS.includes(chainId)) {
  // Standard rate: buildOphisAppDataPartnerFee(chainId). For a same-chain
  // stablecoin pair use the reduced 1 bp rate, same as on Optimism:
  const partnerFee = {
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
    volumeBps: ophisVolumeBpsForPair(isStablePair),
  };
  // ...put it in metadata.partnerFee, sign with the CoW canonical domain
}
```

The fee recipient is one CREATE2-deterministic Safe on every chain, so the
fragment is identical everywhere; only the host and settlement differ (and only
on Optimism). CoW-hosted chains do not enforce the floor, so the 1 bp stable rate
there is your choice, kept consistent with Optimism.

## Earning a rebate (the partner discount)

The fee is the same flat 10 bps everywhere, but partners earn a **rebate** on top.
On CoW-hosted chains the fee cannot be lowered at settlement, so the partner
benefit is delivered as a **post-hoc WETH rebate**: tag each order with your
referral code and Ophis pays you monthly.

```ts
import { ophisVolumeBpsForPair, OPHIS_PARTNER_FEE_RECIPIENT, buildOphisReferrerMetadata } from '@ophis/sdk';

const doc = await new MetadataApi().generateAppDataDoc({
  appCode: 'ophis', // REQUIRED: 'ophis', NOT your app's name (see below)
  metadata: {
    // Same partner-fee fragment as above: reduced 1 bp for a same-chain
    // stablecoin pair, else 10 bps. The rebate is on top of the fee.
    partnerFee: { recipient: OPHIS_PARTNER_FEE_RECIPIENT, volumeBps: ophisVolumeBpsForPair(isStablePair) },
    ...buildOphisReferrerMetadata('your-code'), // -> metadata.ophisReferrer.code
    hooks: {},
  },
});
```

The rebate indexer reads `metadata.ophisReferrer.code` from every settled order,
credits your referred USD volume **across all served chains**, and pays out
monthly in WETH from a single Gnosis Safe. Your code must exist before you tag
orders with it. Higher tiers earn a larger share. See the
[Affiliate program](./affiliate.md) for rates and tiers.

:::warning Two requirements, or the rebate silently never accrues

**1. `appCode` must be `'ophis'`**, not your app's name. The indexer only
attributes orders carrying the Ophis appCode; an order with a custom appCode still
settles and pays the fee, but earns no rebate, and there is no error anywhere. Your
own identity is the referral code in `metadata.ophisReferrer.code`, a separate field
from `appCode` (which records *which app* placed the order, always `'ophis'` here).

**2. Each order-owner wallet must be registered with the indexer.** The indexer
fetches trades per tracked owner (CoW's trades API cannot be enumerated globally),
so a programmatic integrator that never loads the Ophis frontend must enroll every
owner (vault Safe) once, with a public idempotent call:

```bash
curl https://rebates.ophis.fi/tier/<ownerAddress>
```

or ask us to register them. Until an owner is registered, its orders are never
fetched and nothing accrues, even with the correct `appCode` and referral code.
:::

A future option for Optimism is an **enforced lower fee** at settlement (rather
than a post-hoc rebate), via a signed fee credential. That is a separate,
not-yet-shipped capability; talk to us if you want it.

## Selling native ETH (eth-flow)

A CoW order sells an ERC-20 token, so selling **native ETH** needs the on-chain
eth-flow path: the user calls the `CoWSwapEthFlow` contract's payable
`createOrder`, which wraps the ETH to WETH and places the order on their behalf.
`@ophis/sdk` builds that call for you with the Ophis partner fee embedded, so
native-ETH sells route through Ophis instead of forcing the user to wrap first.

`buildOphisEthFlowOrder` returns the eth-flow contract address, the `msg.value`,
the order struct (as a ready-to-send tuple), the ABI, and the full appData you
must upload. It pins the receiver to the taker, sets the eth-flow `feeAmount` and
`value` correctly, and (when you pass a `hashAppData` function) refuses to build
an order whose committed hash does not match the JSON you upload.

```ts
import { MetadataApi, OrderBookApi, stringifyDeterministic } from '@cowprotocol/cow-sdk';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  buildOphisOrderMetadata,
  buildOphisEthFlowOrder,
  isOphisEthFlowChain,
  getOphisOrderbookUrl,
} from '@ophis/sdk';

// 0. Native ETH not supported on this chain? Wrap to WETH and use the order path above.
if (!isOphisEthFlowChain(chainId)) throw new Error('wrap ETH to WETH first');

// 1. Build the Ophis appData (partner fee + referral code), same as an ERC-20 order, and hash it.
const doc = await new MetadataApi().generateAppDataDoc(
  buildOphisOrderMetadata({ chainId, referralCode: 'yourcode', isStablePair }),
);
const fullAppData = await stringifyDeterministic(doc);
const appDataHash = keccak256(toUtf8Bytes(fullAppData));

// 2. Build the eth-flow order. `owner` is the taker; `buyToken` is what they receive.
const built = buildOphisEthFlowOrder({
  chainId, owner, buyToken, sellAmount, buyAmount,
  fullAppData, appDataHash, validTo, quoteId,
  hashAppData: (s) => keccak256(toUtf8Bytes(s)), // optional: fail closed on a hash mismatch
});

// 3. Upload the full appData so solvers honor the partner fee (the on-chain order
//    only commits the hash), then call createOrder with the exact value.
const orderBookApi = new OrderBookApi({ chainId, baseUrls: { [chainId]: getOphisOrderbookUrl(chainId) } });
await orderBookApi.uploadAppData(appDataHash, built.appDataToUpload);
// built.ethFlowContract + built.abi give you the contract; call with value === built.value:
await ethFlow.createOrder(built.orderTuple, { value: built.value });
```

Native ETH is supported on Optimism, Base, and the other CoW-hosted chains.
The order carries the Ophis partner fee exactly as an ERC-20 order does.

## Caveats

- **Use the SDK path, not the widget.** The embed cannot carry a `partnerFee` or
  a referral code.
- **Optimism is the only self-hosted chain.** Other chains are CoW-hosted, where
  Ophis charges the fee but cannot enforce a floor or an on-chain discount.
- **Do not use the `api.cow.fi` host on Optimism.** It silently bypasses the
  Ophis solver and charges no Ophis fee.

## Quick reference

| Step | Optimism | CoW-hosted chains |
| --- | --- | --- |
| Orderbook host | `getOphisOrderbookUrl(10)` | cow-sdk default `api.cow.fi/<chain>` |
| EIP-712 domain | `getOphisOrderDomain(10)` | cow-sdk default (canonical settlement) |
| Partner fee | `volumeBps: ophisVolumeBpsForPair(isStablePair)` to the Ophis recipient (>= floor on OP) | same; `buildOphisAppDataPartnerFee(chainId)` for the flat 10 bps |
| Rebate tag | `buildOphisReferrerMetadata(code)` | `buildOphisReferrerMetadata(code)` |
| Receiver | `assertReceiverIsOwner(vault, receiver)` | `assertReceiverIsOwner(vault, receiver)` |
| Signing | EIP-1271 (Safe / MPC) | EIP-1271 (Safe / MPC) |
