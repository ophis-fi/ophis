# NEAR Intents → Solana destination support (epic)

**Status:** scoped only, not implemented
**Owner:** Clement
**Created:** 2026-05-22
**Linked task:** Clement's brand task #14 (Missing Solana in chain list per CoW's NEAR Intents integration)

## Goal

Allow Ophis users to trade **from any EVM source chain → Solana** as a
destination, using the NEAR Intents bridge layer already wired into
`@cowprotocol/cow-sdk` 4.0.2. Solana destination tokens appear in the
output-side token list; recipient address is a Solana base58 address
(separate from the EVM sender wallet); settlement is brokered by NEAR
Intents off-chain solver network with no Ophis-side liquidity exposure.

## Current state (post-2026-05-22 audit)

What's already done:
- `apps/cowswap-frontend/src/tradingSdk/bridgingSdk.ts:27` instantiates
  `NearIntentsBridgeProvider` and adds it to `BridgingSdk.providers`.
- `apps/cowswap-frontend/src/entities/bridgeProvider/BridgeProvidersUpdater.ts`
  has the enable logic gated on a LaunchDarkly flag
  (`isNearIntentsBridgeProviderEnabled`). Ophis doesn't run LD →
  early-return preserves the SDK provider — effectively enabled at boot.
- `recentTokensStorage.ts:2` imports `isSolanaAddress` from `cow-sdk`
  for token-key disambiguation. So FE already recognizes Solana as a
  type.

What's missing:
- `libs/common-const/src/chainInfo.ts:82` `CHAIN_INFO` map has no Solana
  entry — Solana chainId would need to be added as an
  `AdditionalTargetChainId`.
- `InvalidBridgeOutputUpdater.test.ts:118-141` explicitly tests
  **CLEARING** cross-chain state when target is non-EVM (e.g. Solana).
  This logic needs to invert: allow non-EVM target when bridge supports
  it.
- No Solana wallet adapter on the FE — wagmi/walletconnect is EVM-only.
  For recipient-address resolution + native-balance reads on Solana,
  need a Solana wallet adapter (Phantom / Solflare).
- Token list: SPL tokens absent from output-side token search.
- Address parsing: `useBridgeQuoteRecipient.ts` needs to accept base58.
- Order-progress UI: `OrderProgressBar` assumes EVM tx hashes for the
  bridge step.

## Subsystem touch points

Ten distinct areas need changes (estimate: ~3-5 dev-days for someone
familiar with the codebase, or ~2 weeks for someone new):

1. **Chain registry** — add Solana to `chainInfo.ts` as
   `AdditionalTargetChainId`. Branch out non-EVM `isEvmChainInfo`
   callers across the FE.

2. **`isEvmChainInfo` audit** — every caller needs an explicit
   non-EVM branch. This is the highest-risk piece because any missed
   caller produces the same incomplete-sweep class that caused the
   2026-05-22 P0 crash (PR #232).

3. **Wallet adapter** — wagmi/walletconnect handles EVM only. Solana
   support requires `@solana/wallet-adapter-react` + Phantom/Solflare
   connectors. This is a NEW peer dep; not currently in the bundle.

4. **Address parsing** — `useBridgeQuoteRecipient.ts` must accept
   base58 recipient input. `isSolanaAddress` import already exists;
   the gap is the input-validation UX.

5. **Token list ingestion** — Solana SPL tokens need to appear in
   the output-side token search (cross-chain-only context).

6. **`InvalidBridgeOutputUpdater`** — invert the current clear-on-Solana
   logic at lines 118-141; allow non-EVM target when the bridge
   provider's `bridgeSupportedNetworks` advertises it.

7. **Quote / gas estimation** — NEAR Intents handles cross-chain
   routing on its own (no Ophis-side gas estimation required). UI
   should render a "no EVM gas on Solana destination" notice.

8. **Order progress / explorer** — `targetChainName` rendering (see
   `OrderProgressBar/index.cosmos.tsx`); bridge step UI assumes EVM
   tx hashes — need a Solana-tx-signature branch (base58, not hex).

9. **RPC config** — none needed for routing (NEAR Intents API handles
   it). But output-side native-balance reads on Solana need an HTTP
   Solana RPC endpoint configured (use a public one initially:
   `solana-rpc.publicnode.com` or similar).

10. **Settlement broadcast** — out of FE scope, but worth confirming
    CoW driver/orderbook routes accept Solana-destination orders.
    Likely needs a CoW orderbook config check upstream.

## Acceptance criteria

- A user on chain 10 (OP) can select USDC on Solana as the output
  token and a base58 recipient address.
- The Trade form previews the quote correctly (input EVM amount,
  bridge fee in $, output Solana amount).
- After signing, the order is broadcast and the OrderProgressBar
  shows: source-chain settle tx (EVM) → NEAR Intents bridge fill →
  destination Solana signature.
- No regression on EVM-to-EVM trades.
- No regression on EVM-source-only (single-chain) trades.

## Out of scope

- Solana → EVM (reverse direction).
- Solana → Solana (within-chain).
- Solana wallet connect for users who hold ONLY Solana.
- Real-time price quotes from non-NEAR-Intents Solana DEXs.

## Risks

- **Wallet UX complexity**: users have an EVM wallet AND need to
  provide a Solana recipient address. Probably want a "use my EVM
  address derived via Phantom" shortcut after the Solana adapter is
  in.
- **Bridge fee transparency**: NEAR Intents quotes a fee in the
  destination token. The UI must surface this clearly so users don't
  feel mispriced.
- **Sweep risk**: chains list expansion is exactly what caused the
  2026-05-22 P0. Any new non-EVM chain must be added to
  `isSupportedChainId` + `isEvmChainInfo` callers + persisted-state
  scrub in lockstep.

## Implementation order (recommended)

1. Add Solana to `chainInfo.ts` as `AdditionalTargetChainId` + minimal
   `isEvmChainInfo` branches. Behind a feature flag.
2. Wire `InvalidBridgeOutputUpdater` to allow non-EVM target.
3. Token list ingestion: SPL tokens.
4. Recipient input: base58 address validation.
5. Order progress UI: Solana signature branch.
6. Wallet adapter (last — biggest blast radius).

## References

- `apps/frontend/apps/cowswap-frontend/src/tradingSdk/bridgingSdk.ts`
- `apps/frontend/apps/cowswap-frontend/src/entities/bridgeProvider/BridgeProvidersUpdater.ts`
- `apps/frontend/apps/cowswap-frontend/src/modules/swap/updaters/InvalidBridgeOutputUpdater.test.ts:118-141`
- `apps/frontend/libs/common-const/src/chainInfo.ts:82`
- CoW Protocol NEAR Intents docs: <https://docs.cow.fi/cow-protocol/concepts/cross-chain/near-intents>
- `cow-sdk` v4.0.2 `NearIntentsBridgeProvider` source
