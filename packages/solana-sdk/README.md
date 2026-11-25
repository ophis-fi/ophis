# Ophis native Solana SDK

Development package for Ophis-owned settlement deployments. It reuses the pinned program's low-level wire bindings with Solana Kit. It does not use the CoW Trading SDK, CoW endpoints, partner codes or their fee collection.

Supports Node 22.23.4+ for Node consumers; the native development workbench uses Node 24.13.0. Browser consumers connect through Wallet Standard. In the local preview, wallets with separate signing approve the order and Ophis submits it to the genesis-checked local validator. Wallets that only support signing and sending use their provider, which must point to the same validator. Build with `pnpm --filter @ophis/solana-sdk build`; run the wire/permission checks with `pnpm --filter @ophis/solana-sdk test`.

```ts
import { address } from '@solana/kit';
import { prepareOphisSolanaOrder, TOKEN_PROGRAM_ADDRESS } from '@ophis/solana-sdk';

const order = await prepareOphisSolanaOrder({
  programAddress: address(ophisDeployment),
  owner: walletSigner,
  sellMint: address(sellMint), sellProgram: TOKEN_PROGRAM_ADDRESS,
  buyMint: address(buyMint), buyProgram: TOKEN_PROGRAM_ADDRESS,
  sellAmount: 1_000_000n, buyAmount: minimumBuyAtoms,
  kind: 'sell', validTo: Math.floor(Date.now() / 1000) + 1800,
});
```

The result includes `instructions`, `intent`, `uid`, `orderPda`, `statePda` and the selected `payer`. Assemble a legacy/v0 transaction with that payer and a fresh blockhash, review it, then ask the wallet to sign and submit it. Construction performs no network requests and never signs or broadcasts. There is no default deployment or API host.

The user pays the token-account and order-account creation costs. Pass an explicit `payer` signer if the user's wallet/provider supports paying them instead; select it before collecting signatures. Ophis does not run a creation sponsor. Native SOL sells use `SOLANA_NATIVE_ASSET`; wrapping, delegation and creation are built into one wallet transaction. Native SOL buys use `SOLANA_NATIVE_ASSET`, omit `buyProgram` and pay the `receiver` wallet, defaulting to the owner.

Both SPL programs derive their own correct associated accounts. Listing/import and execution eligibility remain separate: the native backend routes through Raydium CPMM and configured classic-SPL Manifest books with qualified token behavior; transfer-fee and hook execution still need net accounting and venue qualification.

`prepareOphisSolanaCancellation` takes the original intent and its owner's signer. It can also mark a missing order cancelled. `prepareOphisSolanaReclaim` requires the account's recorded `createdBy`; rent returns to that address, including an external wallet payer, and the onchain program checks the entitlement. A cancelled, unexpired order also requires its owner's signature.

The checked-in Rust fixture proves encoding, SHA-256 UID and PDA parity with an actual indexed order. `tests/localnet.mjs` is guarded against mainnet, reads only disposable local wallet keys after checking cluster identity, and exercises creation, cancellation and rent recovery through the real program. The complete five-role runner invokes it; see `apps/solana/README.md`.

To refresh the reused bindings, prepare/generate the pinned native client first, then run `pnpm --filter @ophis/solana-sdk sync-bindings`. The script checks Ophis deployment identity and only adds ESM import extensions. See `SOURCE.md` for provenance. This package is private while mainnet release qualification continues. The Ophis app integration lives in `apps/frontend/apps/cowswap-frontend/src/modules/nativeSolana`.

`fetchOphisSolanaQuote`, `fetchOphisSolanaOrder`, `fetchOphisSolanaMint` and `fetchOphisSolanaChainContext` use an explicitly configured public Ophis orderbook URL. The backend caches context for five seconds and mint metadata for five minutes, sharing concurrent refreshes. Provider credentials stay on the server. Quotes are requested manually with no automatic retry.

`prepareOphisSolanaOrderFromQuote` applies integer slippage to a fresh verified quote and includes its fee amount. `compileOphisSolanaWalletTransaction` binds unsigned v0 bytes to both the configured program and full genesis hash. `sendOphisSolanaWalletTransaction` checks the connected account, chain and v0 capability before invoking the wallet. Neither API selects CoW infrastructure.

The raw builder's exact delegate allowance replaces the prior allowance on that token account. Callers managing concurrent open orders against the same sell account must manage that shared allowance; do not assume the token program adds allowances. Token-2022 fee/hook route execution, installed-wallet vendor QA and advertised Ophis rebate integration remain release work.

Use `fetchOphisSolanaTrades(apiBase, owner, offset, limit)` for a wallet’s settled history. `protocolFee` is an atomic-unit decimal string and `feeMint` names the asset. Older or unmatched fills return null for both. A recorded zero fee is the string `"0"`. Quoted fees are available as `quote.costs.protocolFee` in `quote.costs.token`.


Verified v2 quotes carry `quote.feeTerms` and an opaque `quote.appData` reference. Pass the response to `prepareOphisSolanaOrderFromQuote` so the wallet signs that reference alongside its slippage limit. `quote.costs.protocolFee` estimates the base fee. A finalized trade’s `protocolFee` includes both the base and any realized improvement share, in `feeMint` atoms.
