---
id: partners
title: Partner integration (SDK)
description: Build and submit Ophis swap orders from your app with the Ophis SDK and CoW SDK.
sidebar_label: Partner integration
sidebar_position: 4
---

# Partner integration (SDK)

Use `@ophis/sdk` with `@cowprotocol/cow-sdk` to build, sign, and submit swaps from your app.

<Cards>
<Card icon="wallet" title="Sign with your wallet">Use an EOA, a Safe, or an MPC signer behind EIP-1271.</Card>
<Card icon="code" title="Control each order">Set the receiver, signing domain, and appData in your integration.</Card>
<Card icon="app-window" title="Embed the swap UI" href="/widget">Add the Ophis swap interface with the widget.</Card>
</Cards>

## Install the SDKs

<Steps>

1. **Install both SDKs.** Add ethers v6 or viem for hashing and signing.

   ```bash
   npm i @cowprotocol/cow-sdk @ophis/sdk
   # plus an EVM util lib for keccak256 + EIP-712 (ethers v6 or viem)
   ```

</Steps>

## Submit an order

The helpers select the orderbook, signing domain, relayer, and Ophis fee from `chainId`.

<Steps>

1. **Enroll the order owner.** Call `enrollOphisTrader` before submission to track the owner's trades; `blocking: true` stops submission if enrollment fails.
2. **Approve the sell token.** Send the approval from the order owner to `getOphisVaultRelayer(chainId)`.
3. **Build and sign the order.** Hash deterministic appData, set the receiver to the owner, and sign with the chain's domain.
4. **Submit the order.** Pass the full appData and its hash to `buildOphisOrderCreation`, then call `sendOrder`.

</Steps>

```ts
import {
  OrderBookApi,
  MetadataApi,
  SigningScheme,
  SupportedChainId,
  stringifyDeterministic,
} from '@cowprotocol/cow-sdk';
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

const signingScheme = SigningScheme.EIP1271;

await enrollOphisTrader(owner, { blocking: true });

await sellTokenAsOwner.approve(getOphisVaultRelayer(chainId), amount);

const doc = await new MetadataApi().generateAppDataDoc(
  buildOphisOrderMetadata({ chainId, referralCode: 'yourcode', isStablePair, signer: owner }),
);
const fullAppData = await stringifyDeterministic(doc);
const appDataHash = keccak256(toUtf8Bytes(fullAppData));

const order = { ...quote, receiver: owner, appData: appDataHash };
const signature = await signOrder(order, getOphisOrderDomain(chainId), signingScheme);

const orderBookApi = new OrderBookApi({
  chainId: chainId as SupportedChainId,
  baseUrls: { [chainId]: getOphisOrderbookUrl(chainId) } as Record<SupportedChainId, string>,
});
await orderBookApi.sendOrder(
  buildOphisOrderCreation({
    chainId,
    order,
    owner,
    fullAppData,
    appDataHash,
    signature,
    signingScheme,
  }) as unknown as OrderCreation,
);
```

For an EOA, use `SigningScheme.EIP712` and send the token approval from that EOA. For a Safe, send the approval as a Safe transaction.

:::tip[Approve from the order owner]

Resolve the relayer with `getOphisVaultRelayer(chainId)`. An approval from the Safe's connected owner sets that EOA's allowance; the Safe must approve its own tokens. Renew the allowance after a fill if the remaining amount is too small.

:::

## Chain settings

| Chain | Orderbook host | Settlement (`verifyingContract`) |
| --- | --- | --- |
| Optimism | `optimism-mainnet.ophis.fi` | `0x310784c7FCE12d578dA6f53460777bAc9718B859` |
| Unichain | `unichain-mainnet.ophis.fi` | `0x108A678716e5E1776036eF044CAB7064226F714E` |
| Robinhood Chain | `robinhood-mainnet.ophis.fi` | `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD` |
| Arc | `arc-mainnet.ophis.fi` | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A` |
| CoW-hosted: Mainnet, Base, Arbitrum, Gnosis, Polygon, Avalanche, BNB, Linea, Plasma, Ink | `api.cow.fi/<chain>` | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` |

| Chain | Vault Relayer |
| --- | --- |
| Optimism | `0x83847EaB41ad9ea43809ce71569eB2e9daF51830` |
| Unichain | `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb` |
| CoW-hosted chains | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |

Use the Ophis host, settlement, and relayer on Ophis-operated chains. Use the CoW SDK defaults on CoW-hosted chains. Arc host and signing-domain support starts with SDK v0.4.3.

## Ophis fees

| Fee | Volatile pairs | Stable pairs |
| --- | --- | --- |
| Base | 1 bp | 1 bp |
| Share of reference-quote improvement | 80% | 50% |
| Improvement cap | 99 bps | 20 bps |
| Maximum Ophis charge | 100 bps | 21 bps |

Ophis-operated backends apply improvement capture separately from the appData base fee. On CoW-hosted chains, the SDK includes both entries in appData, and CoW Protocol adds its own fee. See [Fees](/fees).

## Optimism setup {/* #optimism-integration */}

Use these lower-level calls to configure an existing CoW integration.

<Steps>

1. **Select the Ophis orderbook.** Cast the Optimism chain ID for the CoW SDK types.

   ```ts
   import { OrderBookApi, SupportedChainId } from '@cowprotocol/cow-sdk';
   import { getOphisOrderbookUrl } from '@ophis/sdk';

   const opChainId = 10 as SupportedChainId;
   const orderBookApi = new OrderBookApi({
     chainId: opChainId,
     baseUrls: { [opChainId]: getOphisOrderbookUrl(10) } as Record<SupportedChainId, string>,
   });
   ```

2. **Build the fee metadata.** Use the Ophis base fee in appData; the backend applies improvement capture separately.

   ```ts
   import { MetadataApi, stringifyDeterministic } from '@cowprotocol/cow-sdk';
   import { keccak256, toUtf8Bytes } from 'ethers';
   import {
     buildOphisAppDataPartnerFee,
     ophisVolumeBpsForChainAndPair,
     OPHIS_PARTNER_FEE_RECIPIENT,
   } from '@ophis/sdk';

   const partnerFee = {
     recipient: OPHIS_PARTNER_FEE_RECIPIENT,
     volumeBps: ophisVolumeBpsForChainAndPair(chainId, isStablePair),
   };

   const doc = await new MetadataApi().generateAppDataDoc({
     appCode: 'ophis',
     metadata: { partnerFee, hooks: {} },
   });
   const fullAppData = await stringifyDeterministic(doc);
   const appDataHash = keccak256(toUtf8Bytes(fullAppData));
   ```

3. **Select the signing domain.** Resolve the domain for the deployed Ophis settlement contract.

   ```ts
   import { getOphisOrderDomain } from '@ophis/sdk';

   const domain = getOphisOrderDomain(10);
   ```

4. **Set the receiver.** Send proceeds back to the vault Safe.

   ```ts
   import { assertReceiverIsOwner, ophisOrderReceiver } from '@ophis/sdk';

   order.receiver = ophisOrderReceiver(vaultSafe);
   assertReceiverIsOwner(vaultSafe, order.receiver);
   ```

5. **Sign and submit.** Compute the EIP-712 digest from the domain and order fields below. Sign through the vault Safe using EIP-1271, then submit with `SigningScheme.EIP1271` and `from: vaultSafe`.

</Steps>

| Order fields | Parameters |
| --- | --- |
| Tokens and receiver | `sellToken`, `buyToken`, `receiver` |
| Amounts and expiry | `sellAmount`, `buyAmount`, `validTo`, `feeAmount` |
| Metadata and order type | `appData`, `kind`, `partiallyFillable` |
| Token balances | `sellTokenBalance`, `buyTokenBalance` |

| Stage | `appData` | `appDataHash` |
| --- | --- | --- |
| Sign | bytes32 hash | Passed separately at submission |
| Submit | Full JSON string | bytes32 hash |

Submit with `orderBookApi.sendOrder({ ...order, from: vaultSafe, signingScheme: SigningScheme.EIP1271, signature, appData: fullAppData, appDataHash })`. Import `SigningScheme` from `@cowprotocol/cow-sdk`.

## CoW-hosted orders {/* #other-cow-hosted-chains */}

Keep the CoW SDK host and settlement defaults, and put the complete helper result in `metadata.partnerFee`.

```ts
import { buildOphisAppDataPartnerFee } from '@ophis/sdk';

const partnerFee = buildOphisAppDataPartnerFee(chainId, isStablePair);
if (!partnerFee) throw new Error('Unsupported Ophis fee chain');
```

The helper returns an array with the base fee and capped improvement policy. Keep both entries when building appData.

## Charge your own fee

On CoW-hosted chains, add your recipient to the `partnerFee` array in appData v1.4.0 or later. Keep the complete Ophis fee policy alongside your entry.

```ts
const ophisPartnerFee = buildOphisAppDataPartnerFee(chainId, isStablePair);
const partnerFee = [
  ...(Array.isArray(ophisPartnerFee) ? ophisPartnerFee : [ophisPartnerFee]),
  { recipient: YOUR_FEE_ADDRESS, volumeBps: 80 },
];
```

| Setting | Value |
| --- | --- |
| Registered integrator fee limit | 90 bps |
| Aggregate hosted fee limit | 190 bps |
| Ophis share of your fee | 0% |
| CoW partner-fee service fee | 25% by default under CIP-75 |
| Your share after the default CoW service fee | 75% |
| Example | A 50 bps fee nets 37.5 bps |
| Distribution | Weekly in WETH to your `recipient` address |
| Minimum weekly amount | 0.001 WETH |
| Eligible orders | Market-order trades |

CoW's distribution terms allow weekly amounts below the minimum to be voided instead of carried forward. The service fee is negotiable with CoW DAO. See [CoW partner-fee docs](https://docs.cow.fi/governance/fees/partner-fee).

For supported native-ETH sells, pass the full appData array to `buildOphisEthFlowOrder`. Keep the helper's validation and the hosted volatile improvement policy.

## Track order owners

Enroll the order-owner wallet immediately before each submission, including delayed vault trades, so the Ophis indexer counts its trades for trade rewards and earnings reports. The owner is the vault Safe, rather than its curator. The public call is idempotent:

```bash
curl --fail --max-time 10 https://rebates.ophis.fi/tier/<ownerAddress>
```

Successful registration renews the inactivity clock and keeps the wallet's first-seen date.

| Owner state | Tracking |
| --- | --- |
| Empty wallet after seven inactive days | Pruned only after orderbooks confirm no order history and production RPCs confirm no contract code |
| Contract wallet, existing orders, or failed verification | Retained |

## Check your earnings {/* #verifying-your-earnings-get-earningsappcode */}

A public, read-only endpoint reports what your integration routed under your registered code. Create the code in the [Ophis dashboard](https://swap.ophis.fi/#/affiliate), then tag every order with it: `referralCode` in the SDK (stored as `metadata.ophisReferrer.code`) or the widget's top-level `appCode`. Figures are lifetime totals.

```bash
curl https://rebates.ophis.fi/earnings/your-code
```

| Field | Meaning |
| --- | --- |
| `routedVolumeUsd` | Volume routed under your appCode |
| `ophisFeeAccruedUsd` | The Ophis base fee charged on that volume |
| `ownFeeAccruedUsd.hostedAccrued` | Your own fee charged on CoW-hosted chains, before CoW's service fee; CoW pays it in its weekly distribution |

## Sell native ETH {/* #selling-native-eth-eth-flow */}

`buildOphisEthFlowOrder` builds a payable `CoWSwapEthFlow.createOrder` call that wraps ETH to WETH and places the order.

<Steps>

1. **Check the chain.** Use `isOphisEthFlowChain(chainId)` before building the order.
2. **Build and hash appData.** Include the Ophis fee and pass `hashAppData` to validate the committed hash.
3. **Upload and submit.** Upload `built.appDataToUpload`, then call `createOrder` with `built.orderTuple` and `built.value`.

</Steps>

```ts
import { MetadataApi, OrderBookApi, stringifyDeterministic } from '@cowprotocol/cow-sdk';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  buildOphisOrderMetadata,
  buildOphisEthFlowOrder,
  isOphisEthFlowChain,
  getOphisOrderbookUrl,
} from '@ophis/sdk';

if (!isOphisEthFlowChain(chainId)) throw new Error('wrap ETH to WETH first');

const doc = await new MetadataApi().generateAppDataDoc(
  buildOphisOrderMetadata({ chainId, referralCode: 'yourcode', isStablePair }),
);
const fullAppData = await stringifyDeterministic(doc);
const appDataHash = keccak256(toUtf8Bytes(fullAppData));

const built = buildOphisEthFlowOrder({
  chainId,
  owner,
  buyToken,
  sellAmount,
  buyAmount,
  fullAppData,
  appDataHash,
  validTo,
  quoteId,
  hashAppData: (s) => keccak256(toUtf8Bytes(s)),
});

const orderBookApi = new OrderBookApi({
  chainId,
  baseUrls: { [chainId]: getOphisOrderbookUrl(chainId) },
});
await orderBookApi.uploadAppData(appDataHash, built.appDataToUpload);
await ethFlow.createOrder(built.orderTuple, { value: built.value });
```

| Chain | Native-token path |
| --- | --- |
| Optimism, Unichain, Base, and other CoW-hosted chains | Resolve EthFlow support through the SDK |
| Robinhood Chain | `getOphisEthFlowAddress(4663)` resolves `0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29` |
| Arc | Use the ERC-20 USDC interface for native USDC |

Solvers pay for standard signed ERC-20 settlement. Wrapping, native-token placement, hard cancellation, and refunds require gas for their on-chain transactions.

## Next

<Cards>
<Card icon="vault" title="Vault rebalancing" href="/vault-managers">Build a vault rebalancing integration.</Card>
<Card icon="receipt" title="Fees" href="/fees">Check the swap fee schedule.</Card>
<Card icon="braces" title="Intent API" href="/intent-api">Parse natural-language swap requests.</Card>
</Cards>
