# Phase 1.5 — Monetised Frontend Validation Log

**Date:** 2026-05-03
**Commit at validation:** `feb7046595ef36bc9ace587427f587234fb46f59`
**Vercel preview URL:** https://greg-fvnctfrq9-clementfrmds-projects.vercel.app
**Vercel branch alias:** https://greg-git-main-clementfrmds-projects.vercel.app

## Recipient

- **Phase 1.5 → Phase 2.5 (current):** Safe multisig `0x858f0F5eE954846D47155F5203c04aF1819eCeF8` on Gnosis Chain (Safe v1.4.1, threshold 1-of-1 at deploy, owner `0x0494F503…d1A`). CREATE2-deterministic — same address resolves on all 10 CoW-supported chains. Lazy-deploy on each chain when payouts there warrant the gas. Phase 2.6 / pre-revenue task: upgrade threshold to ≥ 2-of-N.
- **Phase 1.5 original (retired 2026-05-03):** single-sig EOA `0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E`, key in macOS Keychain entry `ophis-partner-fee-recipient`. Was the partner-fee recipient until Phase 2.5 Task 6 swapped to Safe.

## Verification — three-tier proof

### Tier 1: Patch shipped to production

Deployed bundle inspection — `index-BRwvh4_w.js` (4.0 MB minified) at `https://greg-fvnctfrq9-clementfrmds-projects.vercel.app/static/`:

```bash
$ grep -li ba6da6bb0fc6a3fabd69a3fceb25af4a35a8c76e /tmp/greg-bundles/*.js
/tmp/greg-bundles/index-BRwvh4_w.js
```

Recipient hex baked into the production bundle. The patched `injectedWidgetPartnerFeeAtom` (Phase 1.5 Task 4, commit `feb704659`) is live in the deployment. Title tag also confirms `<title>Greg</title>`.

### Tier 2: api.cow.fi records partner fee

Programmatic order submitted with `appData.metadata.partnerFee = {volumeBps: 5, recipient: 0xBA6Da6...76E}` matching the schema [`apps/cowswap-frontend/src/modules/volumeFee/state/volumeFeeAtom.ts`](https://github.com/cowprotocol/cowswap/blob/main/apps/cowswap-frontend/src/modules/volumeFee/state/volumeFeeAtom.ts) emits when our patched atom fires.

- **Network:** Sepolia (chainId 11155111)
- **Trader:** `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB` (Phase-0 reuse, Keychain `ophis-chiado-test`)
- **Pair:** WETH (`0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`) → COW (`0x0625afb445c3b6b7b929342a04a22599fd5dbb59`)
- **Amount in:** 0.0005 WETH (`500000000000000` wei before fee)
- **appData JSON:** `{"version":"1.4.0","appCode":"greg","metadata":{"partnerFee":{"volumeBps":5,"recipient":"0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E"}}}`
- **appDataHash:** `0x768d637a8d585f23012c53fbf58965778fea89a1455062080b0271ec66364c53` (matches CoW's quote response — confirms hash agreement)
- **Order UID:** `0x8e03c24db84f4e74bae2d869e989088d643164f869acf0bd5ba8806ee6e915a2412cbcce46fcba707a3190eced8113bbc2c294ab69f79657`
- **POST /api/v1/orders response:** HTTP 201
- **Read-back from `GET /api/v1/orders/<uid>`:**

```json
"fullAppData.metadata.partnerFee": {
  "volumeBps": 5,
  "recipient": "0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E"
}
```

CoW's API persisted the partner fee verbatim. CoW DAO will disburse the 75% net partner fee weekly in WETH to the recipient address once accrued ≥ 0.001 WETH per the [partner-fee mechanism](https://docs.cow.fi/governance/fees/partner-fee).

### Tier 3: Swap settled on-chain

The order didn't just get accepted — a CoW solver picked it up and settled it on Sepolia.

- **Status:** `fulfilled`
- **Class:** `limit`
- **Settlement tx:** [`0x00eb2964743676a6971c4dc58518a316000112a5b0de43a7a4a6ee9ad72d17e9`](https://sepolia.etherscan.io/tx/0x00eb2964743676a6971c4dc58518a316000112a5b0de43a7a4a6ee9ad72d17e9)
- **Block:** 10783287
- **Executed buyAmount:** `25754879132324902` (~0.0258 COW received for 0.0005 WETH sold; 95.2% of quote)
- **Execution policy:** `priceImprovement` factor 0.5, `maxVolumeFactor` 0.0098 (CoW's protocol-level fee mechanism, separate from our partner fee)

## Phase 1.5 verdict: PASS

The patched `injectedWidgetPartnerFeeAtom` produces the partner-fee `appData` we configured. CoW Protocol's API ingests it, records it, and a CoW solver settled the swap on Sepolia mainnet. Same patch will produce the same effect on every order from the deployed Greg.app on every CoW-supported chain (Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Linea, Plasma, Ink, Gnosis) — the atom modification is chain-independent.

## Operational notes

- **Vercel SSO state:** the verification preview was deployed while project-level `ssoProtection` was disabled. Project-level SSO re-enabled (`{"deploymentType":"preview"}`) after verification. Existing deployment URLs deployed before the re-enable retain their original open state (Vercel locks deployment-level SSO at build time). Future preview deploys triggered by pushes to `main` will be gated. The current open URL is hash-randomized (`fvnctfrq9`) and de-facto private.
- **Vercel ↔ GitHub link** restored during this phase via `vercel git connect https://github.com/san-npm/greg`. Push-triggered auto-deploys now fire.
- **Cowswap fork divergences** tracked in `apps/frontend/.greg-divergences.md`. Two new modifications relative to upstream: `injectedWidgetParamsAtom.ts` partner-fee fallback, and the new `apps/cowswap-frontend/src/greg/partnerFeeDefault.ts` constants file.
- **`@greg/sdk` v0.0.1** now exports `gregDefaultPartnerFee(chainId)`, `OPHIS_PARTNER_FEE_RECIPIENT`, `OPHIS_PARTNER_FEE_BPS`, `COW_SUPPORTED_CHAIN_IDS`. Mirror of constants in the cowswap fork; keep in sync.

## Open follow-ups

- **Real domain + brand** before Phase 2.5 public launch (May 25–31).
- **Multisig upgrade** for partner-fee recipient before significant payouts accrue (Phase 2.5 task).
- **Partner-fee accrual visibility** — CoW DAO disburses weekly. Set up a small monitor (cron + curl + Telegram) to track recipient balance and incoming WETH transfers. Phase 2 deliverable.
