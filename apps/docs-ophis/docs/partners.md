---
id: partners
title: Partner integration (SDK)
description: Add Ophis as a swap route inside your own tool with @ophis/sdk plus cow-sdk. Works on Optimism and Unichain (self-hosted) and every CoW-hosted chain, signs with a vault Safe via EIP-1271, and earns a cross-chain WETH rebate.
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
import { OrderBookApi, MetadataApi, SigningScheme, SupportedChainId, stringifyDeterministic } from '@cowprotocol/cow-sdk';
import type { OrderCreation } from '@cowprotocol/cow-sdk';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  enrollOphisTrader,
  buildOphisOrderMetadata,
  buildOphisOrderCreation,
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  getOphisVaultRelayer,
} from '@ophis/sdk';

// `owner` is the order owner. This guide signs with a smart-contract wallet (a
// Safe via EIP-1271). For a connected EOA signer, see the note after the snippet.
const signingScheme = SigningScheme.EIP1271; // SigningScheme.EIP712 for an EOA (see note)

// 0. Register the wallet with the rebate indexer once, on wallet-connect. Without
//    this the indexer never fetches its trades and the rebate never accrues.
await enrollOphisTrader(owner);

// 1. One-time per sell token: approve it to the correct Vault Relayer. On Optimism
//    getOphisVaultRelayer returns the Ophis relayer, NOT cow-sdk's canonical one.
//    The approval must be sent BY the order owner: for a Safe owner submit it as a
//    Safe transaction. Approving from a connected EOA sets the EOA's allowance, not
//    the Safe's, so the relayer cannot pull the Safe's token and the first sell fails.
await sellTokenAsOwner.approve(getOphisVaultRelayer(chainId), amount); // owner-executed, one-time per token

// 2. appData: appCode 'ophis' + the partner fee + your referral code in one call.
const doc = await new MetadataApi().generateAppDataDoc(
  buildOphisOrderMetadata({ chainId, referralCode: 'yourcode', isStablePair, signer: owner }),
);
const fullAppData = await stringifyDeterministic(doc); // never JSON.stringify
const appDataHash = keccak256(toUtf8Bytes(fullAppData)); // bytes32

// 3. Build your quoted order, pin the receiver to the owner, sign appData = the hash
//    with the scheme that matches the signer.
const order = { ...quote, receiver: owner, appData: appDataHash };
const signature = await signOrder(order, getOphisOrderDomain(chainId), signingScheme);

// 4. Submit against the right host. Optimism (10) is Ophis self-hosted and not in
//    cow-sdk's SupportedChainId, so cast the chainId; the orderbook accepts it.
const orderBookApi = new OrderBookApi({
  chainId: chainId as SupportedChainId,
  baseUrls: { [chainId]: getOphisOrderbookUrl(chainId) } as Record<SupportedChainId, string>,
});
// buildOphisOrderCreation is dependency-free, so it returns a plain object; cast it to
// cow-sdk's OrderCreation for sendOrder (the wire shape already matches at runtime).
await orderBookApi.sendOrder(
  buildOphisOrderCreation({ order, owner, fullAppData, appDataHash, signature, signingScheme }) as unknown as OrderCreation,
);
```

For a **connected EOA** signer instead of a Safe: set `signingScheme =
SigningScheme.EIP712`, produce a normal EIP-712 signature, and send the token
approval from the EOA itself (not a Safe transaction).

That is the whole integration. The sections below explain what each helper does
per chain (Optimism and Unichain are self-hosted, the others are CoW-hosted) and the lower-level
primitives, if you would rather wire the steps yourself.

## Two cases: self-hosted (Optimism, Unichain) vs CoW-hosted chains

Ophis serves two kinds of chain, and they differ only in **where the order is
posted** and **which settlement contract signs**:

| | Self-hosted (Optimism, Unichain) | CoW-hosted chains (Mainnet, Base, Arbitrum, Gnosis, Polygon, Avalanche, BNB, Linea, Plasma, Ink) |
| --- | --- | --- |
| Orderbook host | `optimism-mainnet.ophis.fi` / `unichain-mainnet.ophis.fi` (Ophis, per chain via `@ophis/sdk`) | `api.cow.fi/<chain>` (cow-sdk default) |
| Settlement (EIP-712 `verifyingContract`) | Ophis, per chain via `@ophis/sdk`: Optimism `0x310784c7FCE12d578dA6f53460777bAc9718B859`, Unichain `0x108A678716e5E1776036eF044CAB7064226F714E` | CoW canonical `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` (cow-sdk default) |
| Partner fee | `buildOphisAppDataPartnerFee(chainId)` | `buildOphisAppDataPartnerFee(chainId)` |
| Fee enforcement | Enforced floor at settlement | Carried in `appData`, validated by CoW |

On CoW-hosted chains you change **nothing** about host or settlement (cow-sdk
defaults are correct); you only add the Ophis `partnerFee` fragment. On
Optimism you also override the host and the settlement contract.

## Optimism integration

### 1. Point the orderbook at the Ophis host

```ts
import { OrderBookApi, SupportedChainId } from '@cowprotocol/cow-sdk';
import { getOphisOrderbookUrl } from '@ophis/sdk';

// Optimism (10) is Ophis self-hosted and not in cow-sdk's SupportedChainId, so
// cast it; the orderbook accepts it at runtime. Use the cast chainId as the
// computed baseUrls key so the record type lines up.
const opChainId = 10 as SupportedChainId;
const orderBookApi = new OrderBookApi({
  chainId: opChainId,
  // optimism-mainnet.ophis.fi, NOT api.cow.fi. The CoW host does not serve
  // Ophis on Optimism: it would bypass our solver and charge no Ophis fee.
  baseUrls: { [opChainId]: getOphisOrderbookUrl(10) } as Record<SupportedChainId, string>,
});
```

### 2. Build the appData with the Ophis partner fee

```ts
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/cow-sdk';
import { keccak256, toUtf8Bytes } from 'ethers';
import { buildOphisAppDataPartnerFee, ophisVolumeBpsForPair, OPHIS_PARTNER_FEE_RECIPIENT } from '@ophis/sdk';

// The standard fragment is { volumeBps: 5, recipient }, the CIP-75 Volume shape
// at the SDK partner rate (the Ophis front-end charges its own 10 bps retail rate;
// SDK integrations charge 5 bps):
//   const partnerFee = buildOphisAppDataPartnerFee(10);
// On a SAME-CHAIN STABLECOIN pair, charge the reduced 1 bp rate instead. The SDK
// is chain-only and cannot detect the pair, so you decide isStablePair and pass it
// to ophisVolumeBpsForPair (1 bp stable-stable, else the 5 bps partner rate):
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

On the Ophis-operated chains (Optimism, Unichain) the partner rate you charge is
**5 bps** (1 bp on a same-chain stablecoin pair), the same as everywhere else.
The backend additionally enforces an anti-abuse **minimum**: it rejects
(HTTP 400) any order to the Ophis recipient whose fee falls below **4 bps** on a
non-stable pair (or 1 bp on a stablecoin pair), or that uses a Surplus or
PriceImprovement policy. That 4 bps is a floor the backend accepts, not a rate
to target: charge the 5 bps partner rate, which clears it with headroom, and do
not drop the fee.

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
on CoW-hosted chains and the Ophis-operated relayers (Optimism `0x83847EaB41ad9ea43809ce71569eB2e9daF51830`,
Unichain `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb`) on the self-hosted chains.
**Do not use cow-sdk's relayer address on Optimism or Unichain** (the
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
fragment is identical everywhere; only the host and settlement differ, and only
on the Ophis-operated chains (Optimism and Unichain). CoW-hosted chains do not
enforce the floor, so the 1 bp stable rate there is your choice, kept consistent
with the Ophis-operated chains.

## Partner economics: the three layers

An SDK integration earns on three layers, and all three numbers are published:

1. **Your users pay the reduced 5 bps partner rate** (1 bp on same-chain
   stablecoin pairs) instead of the 10 bps retail rate the Ophis front-end
   charges. On Optimism and Unichain that 5 bps is all-in; on CoW-hosted
   chains, CoW Protocol's own fees apply on top (see
   [Fees & rebates](./fees.md#the-all-in-cost-per-chain)).
2. **You earn a share of the fee Ophis keeps** on every trade you route: 8%
   on the self-serve tier, **12% on the partner tier** (uncapped referred
   volume; ask us to upgrade your code). Paid monthly in WETH, on-chain.
3. **You can charge your own fee on top** of an ERC-20 order, up to 95 bps
   under the default 100 bps aggregate cap, and keep 100% of it. Ophis takes no
   cut of your fee. See [Charge your own fee](#charge-your-own-fee) below.

What layer 2 pays per **$1,000,000 of referred monthly volume** (non-stable,
labeled estimates; exact value depends on chain mix):

| Tier | Share of net fee | Roughly, per $1M/month |
| --- | --- | --- |
| Self-serve (8%) | 8% of the fee Ophis keeps | $30 to $40 in WETH |
| Partner (12%) | 12% of the fee Ophis keeps | $45 to $60 in WETH |

Layer 2 alone is not a business; it is a kicker. The business case for an
operator is **layer 3**: your own fee entry, charged on top of the 5 bps base.
You keep 100% of your entry; the base is the only cost, and it is charged to
the trade alongside your fee, not deducted from it. A bot that sets its own
fee to 80 bps keeps the full 80 bps and its users pay 85 bps all-in (your 80
plus the 5 bps base) on Optimism and Unichain, still under the roughly 85 to
90 bps wallet swap products charge
([MetaMask Swaps charges 0.875%](https://support.metamask.io/trade/swap/user-guide-swaps/)).
On CoW-hosted chains, add the upstream CoW Protocol fees from
[Fees & rebates](./fees.md#the-all-in-cost-per-chain) to the user's all-in.

## Charge your own fee

The order's `appData` **`partnerFee` field accepts an array** (appData v1.4.0
and later), so your integration can stack its own fee entry, paid to your own
address, next to the Ophis base entry:

```ts
const partnerFee = [
  // Ophis base: the 5 bps partner rate (1 bp stable pairs)
  { recipient: OPHIS_PARTNER_FEE_RECIPIENT, volumeBps: ophisVolumeBpsForPair(isStablePair) },
  // Your fee, your address, your rate (charged on top of the base)
  { recipient: YOUR_FEE_ADDRESS, volumeBps: 80 },
];
```

Ophis takes **0% of your fee**: the 5 bps base is the entire cost of the rail.
Each entry is capped at 100 bps by the appData schema, and the aggregate across
entries is capped at settlement (100 bps default), so with the 5 bps base your
own entry can go up to **95 bps** (higher only if a larger aggregate cap is
arranged).

The array applies to **ERC-20 orders**. A **native-ETH** sell built with the
`buildOphisEthFlowOrder` helper carries the single Ophis base `partnerFee`
entry; to add your own fee on a native-ETH order, build the appData manually
with the array shape above rather than using the helper.

How your fee reaches you depends on the chain:

- **CoW-hosted chains:** stacked fee entries are accepted and charged by CoW's
  production orderbooks (we verified this against live quotes in July 2026).
  Payouts flow through CoW Protocol's weekly partner-fee distribution under
  CoW's terms, which include a service fee on partner fees (25% by default) and
  a 0.001 WETH payout minimum
  ([CoW partner-fee docs](https://docs.cow.fi/governance/fees/partner-fee)).
  Whether CoW's service fee applies to a stacked non-Ophis recipient, and the
  end-to-end payout of that recipient, are what we are still verifying, so on
  hosted chains do not assume the full own-fee reaches you until we confirm it
  with your recipient address. This is where a third-party own-fee is chargeable
  today.
- **Optimism and Unichain (Ophis-operated):** a stacked own-fee to a
  third-party recipient needs two things to be true, and only the first exists
  today, so **sovereign own-fee to your own address is not yet available
  end to end**:
  1. *Ingress.* Your recipient must be on the backend fee-recipient allowlist or
     the order is rejected. This is a manual, reviewed backend change plus a
     redeploy.
  2. *Payout.* The settlement contract collects all partner fees into a single
     buffer that is swept to one Safe; there is no per-recipient split today, so
     an allowlisted third-party recipient's fee is collected but accrues to the
     Ophis Safe, not routed to that recipient. Per-recipient sovereign payout is
     on the roadmap, not yet shipped.

  The flat all-in Ophis fee and the 100%-of-price-improvement-returned
  guarantees still hold on the sovereign chains: those are properties of the
  base rail, not of a third-party own-fee. Until per-recipient payout ships, use
  the CoW-hosted chains for your own fee (with the payout caveat above), and
  [contact us](https://business.ophis.fi) to register interest in sovereign
  per-recipient payout.

## Earning a rebate (the referral layer)

Layer 2 is separate from the fee your users pay. The fee itself is set in
`appData` at settlement (the 5 bps base, plus your own entry if you add one).
The **referral share** of 8% or 12% is a distinct earning: it is a portion of
the net fee Ophis keeps, paid back to you monthly in WETH. Tag each order with
your referral code and Ophis pays it out each cycle.

```ts
import { ophisVolumeBpsForPair, OPHIS_PARTNER_FEE_RECIPIENT, buildOphisReferrerMetadata } from '@ophis/sdk';

const doc = await new MetadataApi().generateAppDataDoc({
  appCode: 'ophis', // REQUIRED: 'ophis', NOT your app's name (see below)
  metadata: {
    // Same partner-fee fragment as above: reduced 1 bp for a same-chain
    // stablecoin pair, else the 5 bps partner rate. The rebate is on top of the fee.
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

## Verifying your earnings: `GET /earnings/:appCode`

A keyless, read-only endpoint on the rebate indexer lets you verify what your own
routing earned and where it paid out. Look yourself up by the `appCode` you tag into
appData: your **widget** top-level appCode, or your **SDK** `metadata.ophisReferrer.code`
(the indexer stores either as the integrator identity).

```bash
curl https://rebates.ophis.fi/earnings/your-code
```

It reports **cumulative (lifetime)** figures only. To keep it safe as a public surface
it never exposes a current-cycle 30-day volume, an estimated current-cycle earning, or a
next-payout time (those stay on the signature-gated partner dashboard).

### What Ophis guarantees, and what accrues under CoW terms

Only **Optimism (10)** and **Unichain (130)** are Ophis-operated, where Ophis controls
settlement end to end. On the CoW-hosted chains, partner fees are disbursed by CoW under
CoW terms; Ophis neither pays nor guarantees them. The response splits each figure
**sovereign** vs **hosted**. The sovereign label means Ophis-controlled settlement, and
Ophis pays the **referral rebate** from its Safe regardless of chain; it does **not** mean
a third-party **own-fee** is routed to you on the sovereign chains (per-recipient sovereign
payout is not yet built, so that own-fee accrues to the Ophis Safe today). The response
carries a top-level `disclaimer` with the scope.

Three earnings streams appear:

- **Own-fee** (`ownFeeAccruedUsd`): the partner-fee entry you stack to **your own**
  recipient in the appData `partnerFee` array, next to the Ophis base entry. These figures
  are the own-fee **charged** at settlement, not amounts guaranteed to reach you.
  `sovereignGuaranteed` (the historical field name) is the own-fee charged on Optimism and
  Unichain, but per-recipient sovereign payout is not yet built: that own-fee accrues to
  the Ophis Safe, not routed to your address (see [Charge your own fee](#charge-your-own-fee)),
  so it is not payable to a third party today. `hostedAccrued` is the own-fee charged on
  CoW-hosted chains, where payout runs through CoW's weekly partner distribution under
  CoW's terms (Ophis does not guarantee it, and the end-to-end payout of a stacked
  recipient there is still being verified). Treat both as charged/accrued, not paid.
- **Referral rebate** (`referral`): the monthly WETH rebate Ophis pays your wallet from
  the Gnosis Safe when your `appCode` is a registered referral code. `paidToDateWeth` /
  `paidToDateUsd` are **exact**, summed from already-executed Safe batches, and `payouts`
  lists each executed payout with its on-chain tx and a block-explorer link (your proof of
  where it paid out).
- **Ophis base fee** (`ophisFeeAccruedUsd`): informational, the Ophis fee charged on your
  routed flow (not your earning).

### Response shape

```jsonc
{
  "ok": true,
  "appCode": "your-code",
  "generatedAt": "2026-07-04T09:00:00.000Z",
  "sovereignChains": [10, 130],
  "disclaimer": "Earnings on Optimism (10) and Unichain (130) are settled and paid by Ophis end to end. Figures on CoW-hosted chains are accrued at settlement, paid out by CoW under CoW terms; not guaranteed by Ophis. ...",
  "routedVolumeUsd":   { "total": 350000, "sovereign": 150000, "hosted": 200000 },
  "ophisFeeAccruedUsd": { "total": 350, "sovereign": 150, "hosted": 200 },
  "ownFeeAccruedUsd": {
    "total": 975,
    "sovereignGuaranteed": 375,   // OP + Unichain: Ophis-controlled
    "hostedAccrued": 600,         // CoW-hosted: disbursed by CoW under CoW terms
    "recipient": "0xYourOwnFeeRecipient",
    "note": "Own-fee is the partner-fee entry you stack to your own recipient ..."
  },
  "referral": {
    "registered": true,
    "paidToDateWeth": 1.5,
    "paidToDateUsd": 4600,
    "payouts": [
      {
        "cycleMonth": "2026-06",
        "chainId": 100,
        "chainName": "Gnosis",
        "txHash": "0x...",
        "explorerUrl": "https://gnosisscan.io/tx/0x...",
        "amountWeth": 1.0
      }
    ],
    "note": "Referral rebate Ophis pays your wallet monthly ... per referrer wallet."
  },
  "byChain": [
    { "chainId": 10, "chainName": "Optimism", "sovereign": true, "routedVolumeUsd": 100000, "trades": 5, "ophisFeeAccruedUsd": 100, "ownFeeAccruedUsd": 250 },
    { "chainId": 8453, "chainName": "Base", "sovereign": false, "routedVolumeUsd": 200000, "trades": 10, "ophisFeeAccruedUsd": 200, "ownFeeAccruedUsd": 600 }
  ]
}
```

Agents can poll the same data through the Ophis MCP server's `get_integrator_earnings`
tool (it calls this endpoint). The own-fee amount is decoded from settled appData on
every chain, so the charged amount is attributed everywhere, but a charged amount is not
a payout. On Optimism and Unichain a third-party own-fee is not routed to you today: it
accrues to the Ophis Safe because per-recipient sovereign payout is not yet built. The
hosted figure is the gross amount charged at settlement, paid out under CoW's terms;
whether CoW's service fee applies to a stacked non-Ophis recipient, and the end-to-end
payout of that recipient, are still being verified. Treat every own-fee figure as gross
and not guaranteed.

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

Native ETH is supported on Optimism, Unichain, Base, and the other CoW-hosted chains.
The order carries the Ophis partner fee exactly as an ERC-20 order does.

## Caveats

- **Use the SDK path, not the widget.** The embed cannot carry a `partnerFee` or
  a referral code.
- **Optimism and Unichain are the self-hosted chains.** Other chains are CoW-hosted, where
  Ophis charges the fee but cannot enforce a floor or an on-chain discount.
- **Do not use the `api.cow.fi` host on Optimism.** It silently bypasses the
  Ophis solver and charges no Ophis fee.

## Quick reference

| Step | Optimism | CoW-hosted chains |
| --- | --- | --- |
| Orderbook host | `getOphisOrderbookUrl(10)` | cow-sdk default `api.cow.fi/<chain>` |
| EIP-712 domain | `getOphisOrderDomain(10)` | cow-sdk default (canonical settlement) |
| Partner fee | `volumeBps: ophisVolumeBpsForPair(isStablePair)` to the Ophis recipient (>= floor on OP) | same; `buildOphisAppDataPartnerFee(chainId)` for the 5 bps partner rate |
| Rebate tag | `buildOphisReferrerMetadata(code)` | `buildOphisReferrerMetadata(code)` |
| Receiver | `assertReceiverIsOwner(vault, receiver)` | `assertReceiverIsOwner(vault, receiver)` |
| Signing | EIP-1271 (Safe / MPC) | EIP-1271 (Safe / MPC) |
