# Ophis Phase 1.5 — Monetised Frontend Implementation Plan


**Goal:** Inject a Ophis-controlled partner fee into every order the deployed cowswap fork produces, so each swap routed through `https://greg-29v5viw8p-clementfrmds-projects.vercel.app` (and successor URLs) accrues a 5 bps `appData.metadata.partnerFee` payable to a Ophis recipient. Settlement keeps happening through CoW's official orderbook + solver network on whichever of the [10 supported chains](https://docs.cow.fi/cow-protocol/reference/contracts/core) (Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Linea, Plasma, Ink, Gnosis) the user has connected.

**Architecture:** The cowswap fork already has full partner-fee plumbing — `injectedWidgetPartnerFeeAtom` → `widgetPartnerFeeAtom` → `volumeFeeAtom` → `AppDataInfoUpdater` → signed order's `appData`. The plumbing only activates when the app runs in widget mode and the integrator passes `partnerFee` config. We ship a small patch that **defaults the atom to Ophis's partner-fee config when widget params do not supply one**, so the same plumbing fires on every order our deployment produces. No new infrastructure: the frontend continues to talk directly to `api.cow.fi` for order submission. CoW DAO disburses our share of accrued partner fees weekly in WETH per the [partner-fee mechanism](https://docs.cow.fi/governance/fees/partner-fee) (CoW DAO keeps 25% as service fee, we keep 75% on the Net Partner Fee, paid weekly when accrued ≥ 0.001 WETH).

**Tech Stack:** TypeScript, Jotai (cowswap's existing state library), the vendored `apps/frontend/` (cowswap fork pinned at `0174f35e7…`), Vercel for deploy, `@cowprotocol/cow-sdk` already in cowswap's dependency tree, Foundry `cast` for wallet operations, macOS Keychain for key storage.

**Spec:** [`docs/development/specs/2026-05-02-ophis-design.md`](../specs/2026-05-02-ophis-design.md) + [`docs/development/specs/2026-05-03-ophis-design-amendment.md`](../specs/2026-05-03-ophis-design-amendment.md)

**Predecessor plan:** [`docs/development/plans/2026-05-02-ophis-phase-1-local-self-hosted-stack.md`](2026-05-02-ophis-phase-1-local-self-hosted-stack.md)

**Phase gate:** A real swap submitted via the deployed Ophis.app on Sepolia (or any CoW-supported chain) is recorded in `https://api.cow.fi/<chain>/api/v1/orders/<uid>` with `fullAppData` containing `metadata.partnerFee` set to `{ bps: 5, recipient: <Ophis recipient address>, volumeBps: 5 }`. Validation log committed to `docs/development/phase-1-5-validation.md`.

---

## File Structure (created or modified by this plan)

| Path | Action | Purpose |
|---|---|---|
| `packages/sdk/src/partner-fee.ts` | create | Ophis partner-fee constants + `gregDefaultPartnerFee(chainId)` helper |
| `packages/sdk/src/index.ts` | modify | export the new module |
| `packages/sdk/tests/partner-fee.test.ts` | create | TDD coverage for the new module |
| `apps/frontend/apps/cowswap-frontend/src/modules/injectedWidget/state/injectedWidgetParamsAtom.ts` | modify | atom defaults to Ophis's partner-fee config when widget params do not supply one |
| `apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts` | create | inline Ophis constants for cowswap (mirrors `@ophis/sdk` values; small file with explanatory comment about why we inline) |
| `apps/frontend/.ophis-divergences.md` | create | tracking document for upstream-conflict-on-pull files |
| `docs/development/phase-1-5-validation.md` | create | phase-gate evidence |

**Not modified:** `apps/backend/`, `infra/local/`, `infra/rpc/`, `packages/sdk/src/config.ts` (the Phase 0 file, kept stable).

---

## Dispatch hints

- **Tasks 1, 6, 8:** main session (CTO) — wallet generation, deployment, validation, tagging.
- **Tasks 2:** `frontend` agent — TDD for `@ophis/sdk` extension.
- **Tasks 3–5:** `frontend` agent — cowswap fork patch + local smoke test.
- **Task 7:** main session — actual on-chain swap and `api.cow.fi` verification.

---

## Task 1: Generate Ophis partner-fee recipient EOA

**Files:** none committed (key persists to Keychain only).

This wallet will receive weekly WETH payouts of Ophis's 75% share of accrued partner fees. For Phase 1.5 we use a single-sig EOA controlled by Clement; Phase 2.5 (public launch prep) upgrades to a Safe multisig before any meaningful balance accumulates.

- [ ] **Step 1: Generate the keypair**

```bash
cast wallet new
```

Capture the `Address:` and `Private key:` values from stdout.

- [ ] **Step 2: Save private key to macOS Keychain**

```bash
RECIPIENT_PK=<paste private key from Step 1>
RECIPIENT_ADDR=<paste address from Step 1>

security add-generic-password \
  -a "ophis-partner-fee-recipient" \
  -s "ophis-partner-fee-recipient" \
  -w "$RECIPIENT_PK" \
  -U

security find-generic-password \
  -a "ophis-partner-fee-recipient" \
  -s "ophis-partner-fee-recipient" -w | head -c 6
```
Expected: prints `0x` + 4 hex characters (sanity check the keychain entry was written).

- [ ] **Step 3: Verify the public address matches the keychain entry**

```bash
RETRIEVED_PK=$(security find-generic-password -a "ophis-partner-fee-recipient" -s "ophis-partner-fee-recipient" -w)
DERIVED_ADDR=$(cast wallet address "$RETRIEVED_PK")
echo "Derived: $DERIVED_ADDR"
echo "Expected: $RECIPIENT_ADDR"
```
Expected: derived and expected match (case-insensitive). If mismatch, redo Step 2.

- [ ] **Step 4: Record the address in `infra/local/.env`**

Edit `/Users/scep/greg/infra/local/.env` (gitignored — do NOT commit) and add:

```ini
OPHIS_PARTNER_FEE_RECIPIENT=<RECIPIENT_ADDR from Step 1>
```

This `.env` is for local reference only. The address will also be hardcoded in the cowswap patch (Task 4). The file does not need committing.

- [ ] **Step 5: Document the address publicly**

The recipient address is **not a secret** — only the private key is. Append to `docs/development/phase-1-5-validation.md` (which Task 7 will create):

```markdown
## Recipient
- Address: <RECIPIENT_ADDR>
- Private key: macOS Keychain entry `ophis-partner-fee-recipient`
- Multisig upgrade: deferred to Phase 2.5
```

(Defer the actual file write to Task 7; record the address here for handoff.)

## Task 2: Extend `@ophis/sdk` with partner-fee defaults (TDD)

**Files:**
- Create: `packages/sdk/src/partner-fee.ts`, `packages/sdk/tests/partner-fee.test.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/sdk/tests/partner-fee.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  gregDefaultPartnerFee,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_PARTNER_FEE_BPS,
} from '@ophis/sdk';

describe('@ophis/sdk partner fee defaults', () => {
  it('returns the same recipient on every CoW-supported chainId', () => {
    const chains = [1, 100, 8453, 42161, 137, 43114, 56, 59144, 9745, 57073];
    for (const chainId of chains) {
      const fee = gregDefaultPartnerFee(chainId);
      expect(fee.bps).toBe(5);
      expect(fee.recipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    }
  });

  it('exposes the bps constant matching the spec default', () => {
    expect(OPHIS_PARTNER_FEE_BPS).toBe(5);
  });

  it('returns a recipient that is a 0x-prefixed 40-hex-char address', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('returns undefined for an unsupported chainId', () => {
    expect(gregDefaultPartnerFee(999_999)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/scep/greg
pnpm --filter @ophis/sdk test
```
Expected: fails — `gregDefaultPartnerFee` is not exported.

- [ ] **Step 3: Implement `packages/sdk/src/partner-fee.ts`**

```typescript
/**
 * Ophis's partner-fee configuration injected into every order routed through
 * Ophis.app. Surfaced via cow-sdk's appData metadata.partnerFee, paid out by
 * CoW DAO weekly in WETH. See:
 *   - https://docs.cow.fi/governance/fees/partner-fee
 *   - docs/development/specs/2026-05-03-ophis-design-amendment.md
 */

/** Recipient EOA — generated 2026-05-03, key in macOS Keychain entry `ophis-partner-fee-recipient`.
 *  REPLACE WITH THE TASK-1 ADDRESS BEFORE COMMITTING. */
export const OPHIS_PARTNER_FEE_RECIPIENT =
  '0xREPLACE_WITH_TASK_1_ADDRESS' as `0x${string}`;

/** Default fee in basis points. 1 bps = 0.01%. CoW caps partner fees at 100 bps. */
export const OPHIS_PARTNER_FEE_BPS = 5;

/** Chains where CoW Protocol is deployed (May 2026). Source: https://docs.cow.fi/cow-protocol/reference/contracts/core */
export const COW_SUPPORTED_CHAIN_IDS = new Set<number>([
  1,        // Ethereum
  100,      // Gnosis Chain
  8453,     // Base
  42161,    // Arbitrum One
  137,      // Polygon
  43114,    // Avalanche
  56,       // BNB Chain
  59144,    // Linea
  9745,     // Plasma
  57073,    // Ink
  // Sepolia (11155111) is a testnet; CoW supports it for staging.
  11155111,
]);

export interface GregPartnerFee {
  readonly bps: number;
  readonly recipient: `0x${string}`;
}

/** Returns Ophis's default partner-fee config for a given chain, or undefined for unsupported chains. */
export const gregDefaultPartnerFee = (chainId: number): GregPartnerFee | undefined => {
  if (!COW_SUPPORTED_CHAIN_IDS.has(chainId)) return undefined;
  return { bps: OPHIS_PARTNER_FEE_BPS, recipient: OPHIS_PARTNER_FEE_RECIPIENT };
};
```

**Substitute** `0xREPLACE_WITH_TASK_1_ADDRESS` with the actual address generated in Task 1 before saving the file. The placeholder must not survive into the commit.

- [ ] **Step 4: Wire the new module into the package index**

`packages/sdk/src/index.ts` — append exports:

```typescript
export {
  gregDefaultPartnerFee,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_PARTNER_FEE_BPS,
  COW_SUPPORTED_CHAIN_IDS,
  type GregPartnerFee,
} from './partner-fee.js';
```

- [ ] **Step 5: Run tests to verify green**

```bash
cd /Users/scep/greg
pnpm --filter @ophis/sdk test
pnpm --filter @ophis/sdk typecheck
```
Expected: 4 partner-fee tests pass + the 3 pre-existing tests from Phase 0 still pass = 7 total. Typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/scep/greg
git add packages/sdk/
git status
git commit -m "feat(sdk): export gregDefaultPartnerFee + chain support set"
git push
```

## Task 3: Inline Ophis's partner-fee constants inside the cowswap fork

**Files:**
- Create: `apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts`
- Create: `apps/frontend/.ophis-divergences.md`

The cowswap fork lives in its own pnpm workspace (`apps/frontend/`) which is **deliberately excluded from the root pnpm workspace** (per `pnpm-workspace.yaml`). It cannot import from `@ophis/sdk` without significant cross-workspace plumbing. Instead we duplicate the constants with a clear comment pointing back to `@ophis/sdk` as the source of truth, and track the divergence so future `git subtree pull cowswap-upstream main --squash` operations know what to reconcile.

- [ ] **Step 1: Create the inline constants file**

`apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts`:
```typescript
/**
 * Ophis partner-fee defaults — duplicated from `@ophis/sdk` because the cowswap
 * fork lives in its own pnpm workspace and cannot import from the outer
 * monorepo.
 *
 * Source of truth: `packages/sdk/src/partner-fee.ts`. Keep these values in
 * sync. Whenever `@ophis/sdk` changes, mirror the change here in the same PR.
 *
 * See docs/development/specs/2026-05-03-ophis-design-amendment.md for the
 * partner-fee strategy. See https://docs.cow.fi/governance/fees/partner-fee
 * for the protocol-level mechanism.
 */

import type { PartnerFee } from '@cowprotocol/widget-lib';

/** Recipient EOA — generated 2026-05-03, key in macOS Keychain entry `ophis-partner-fee-recipient`. */
const OPHIS_PARTNER_FEE_RECIPIENT = '0xREPLACE_WITH_TASK_1_ADDRESS' as const;

/** Default fee in basis points. 1 bps = 0.01%. CoW caps partner fees at 100 bps. */
const OPHIS_PARTNER_FEE_BPS = 5;

/** Default partner-fee config applied to every order on this deployment when no widget partnerFee is provided. */
export const OPHIS_DEFAULT_PARTNER_FEE: PartnerFee = {
  bps: OPHIS_PARTNER_FEE_BPS,
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
};
```

Substitute `0xREPLACE_WITH_TASK_1_ADDRESS` with the Task-1 address before saving.

- [ ] **Step 2: Create `apps/frontend/.ophis-divergences.md`**

```markdown
# apps/frontend — divergences from upstream cowprotocol/cowswap

Files modified or added beyond the original subtree merge. When running
`git subtree pull --prefix=apps/frontend cowswap-upstream main --squash`,
expect conflicts on these paths and re-apply the changes manually.

## Modified

- `apps/cowswap-frontend/src/modules/injectedWidget/state/injectedWidgetParamsAtom.ts`
  Default `partnerFee` to `OPHIS_DEFAULT_PARTNER_FEE` when widget params do not
  supply one. Phase 1.5, 2026-05-03.
- `apps/cowswap-frontend/index.html` (browser title), `apps/cowswap-frontend/public/manifest.json`
  (PWA name), `libs/ui/src/pure/ProductLogo/index.tsx` (logo alt text) — minimal
  Ophis rebrand. Phase 0 Task 7, 2026-05-02.
- `package.json` (root of `apps/frontend/`)
  Added `pnpm.onlyBuiltDependencies` for pnpm v10 compatibility. Phase 0 Task 6,
  2026-05-02.

## Added (Ophis-only)

- `apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts` — Ophis partner-fee
  inline constants (mirror of `@ophis/sdk`).
- `.greg-upstream` — pinned upstream commit SHA.
- `.ophis-build-notes.md` — local build documentation.
- `scripts/vercel-build.sh` — Vercel deployment helper script.

## Conflict-recovery procedure

When `git subtree pull` produces conflicts on the **Modified** files above:
1. Inspect the upstream change with `git log` on the conflicting file.
2. Reapply Ophis's intent on top of the upstream change, preserving both.
3. Update this file's `Phase X, YYYY-MM-DD` annotations.
4. Re-run the local Phase 1 forked-Gnosis stack (`docker compose -f infra/local/docker-compose.fork.yml --env-file infra/local/.env up`) and the Phase 1.5 Sepolia smoke test (Task 4 of Phase 1.5 plan) to confirm the fork still settles and partner-fee still injects.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/.ophis-divergences.md \
        apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts
git status
git commit -m "feat(frontend): add Ophis partner-fee constants inside cowswap fork"
git push
```

## Task 4: Patch `injectedWidgetParamsAtom` to default to Ophis's partner fee

**Files:**
- Modify: `apps/frontend/apps/cowswap-frontend/src/modules/injectedWidget/state/injectedWidgetParamsAtom.ts`

This is the smallest viable patch: the atom that exposes widget partner-fee config is changed to fall back to Ophis's default when widget params do not supply one. Every downstream consumer (`widgetPartnerFeeAtom`, `volumeFeeAtom`, `AppDataInfoUpdater`) sees a Ophis-configured partner fee on every order.

- [ ] **Step 1: Read the current atom file**

```bash
cat /Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/modules/injectedWidget/state/injectedWidgetParamsAtom.ts
```

Confirm the current code reads roughly:
```typescript
export const injectedWidgetPartnerFeeAtom = atom((get) => get(injectedWidgetParamsAtom).params.partnerFee)
```

(File line numbers may differ — operate on the actual content.)

- [ ] **Step 2: Modify the file**

Replace the `injectedWidgetPartnerFeeAtom` export so it falls back to Ophis's default. Keep all other exports unchanged.

```typescript
import { OPHIS_DEFAULT_PARTNER_FEE } from 'ophis/partnerFeeDefault'

export const injectedWidgetPartnerFeeAtom = atom((get) => {
  const widgetFee = get(injectedWidgetParamsAtom).params.partnerFee
  return widgetFee ?? OPHIS_DEFAULT_PARTNER_FEE
})
```

The import path `'ophis/partnerFeeDefault'` assumes cowswap-frontend's TS config resolves `src/` as a root (which it does — see `apps/frontend/apps/cowswap-frontend/tsconfig.json`'s `baseUrl`). If the resolution does not work, fall back to the relative path `'../../../greg/partnerFeeDefault'` from the atom file's location.

- [ ] **Step 3: Build cowswap to confirm the patch compiles**

```bash
cd /Users/scep/greg/apps/frontend
pnpm run build:cowswap 2>&1 | tail -10
```
Expected: build succeeds. If TypeScript errors on the import, fix the path. If type-mismatch on `OPHIS_DEFAULT_PARTNER_FEE` vs `PartnerFee` type, the fix is in `partnerFeeDefault.ts` — narrow the type or cast appropriately.

- [ ] **Step 4: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/apps/cowswap-frontend/src/modules/injectedWidget/state/injectedWidgetParamsAtom.ts
git status
git commit -m "feat(frontend): default partnerFee to Ophis's recipient when widget params absent"
git push
```

## Task 5: Local smoke test — confirm partner fee bakes into appData

**Files:** none modified. Validation only.

This task runs the cowswap dev server locally and uses the browser console to construct an order and inspect its `appData` before signing. We are not actually submitting; we just confirm the partner-fee plumbing fires.

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/scep/greg/apps/frontend
pnpm run start 2>&1 | tee /tmp/greg-dev.log &
```

Wait until `/tmp/greg-dev.log` shows `Local:` URL (typically `http://localhost:3000`). Open it in a browser.

- [ ] **Step 2: Connect a Sepolia test wallet and prepare an order**

In the UI:
1. Connect wallet (MetaMask or Rabby), pointed at Sepolia.
2. Select a small swap (e.g., 0.001 WETH → COW on Sepolia, same pair as Phase 0 validation).
3. Click "Swap" / "Review".
4. **Stop before signing.**

- [ ] **Step 3: Inspect appData in the browser DevTools**

Open the network tab in DevTools and watch for the POST to `https://api.cow.fi/sepolia/api/v1/quote` (or the order build call). The request body's `appData` field should be a JSON string containing:

```json
{
  "version": "...",
  "metadata": {
    "partnerFee": {
      "bps": 5,
      "recipient": "<Ophis recipient address from Task 1>"
    }
  }
}
```

If the `partnerFee` block is **missing**, the patch is not active. Re-check Tasks 3 and 4. Most likely cause: the import path in Task 4 Step 2 is wrong, so the atom still defaults to `undefined`.

If the `partnerFee` block is **present with the correct values**, the patch works.

- [ ] **Step 4: Stop the dev server**

```bash
kill %1 2>/dev/null || true
```

- [ ] **Step 5: No commit (validation-only)**

## Task 6: Deploy to Vercel preview

**Files:** none modified.

- [ ] **Step 1: Trigger a Vercel preview deploy**

```bash
cd /Users/scep/greg
git push  # the prior commits already on origin should trigger a Vercel deploy
```

If Vercel auto-deploy on push is wired, it will build automatically. If not:

```bash
cd /Users/scep/greg
vercel  # creates a preview deployment using the project linked in Phase 0
```

- [ ] **Step 2: Capture the preview URL**

Check the GitHub PR / commit status checks or the Vercel CLI output for the preview URL. Format: `https://greg-<hash>-clementfrmds-projects.vercel.app`.

- [ ] **Step 3: Confirm the deployment loads**

```bash
PREVIEW_URL=<paste preview URL>
curl -fsSI "$PREVIEW_URL" | head -5
```
Expected: `HTTP/2 401` if SSO is still on (gated to team members), or `HTTP/2 200` if SSO is off. Either is fine — the deployment is reachable.

- [ ] **Step 4: No commit (operational)**

## Task 7: End-to-end verification — partner fee in `api.cow.fi`

**Files:**
- Create: `docs/development/phase-1-5-validation.md`

This task confirms the on-chain settlement records our partner fee. We submit a real Sepolia order via the deployed frontend, then read the order from CoW's API and verify the `fullAppData` contains our partner fee.

- [ ] **Step 1: Open the deployed preview URL with a Sepolia-funded wallet**

The Phase-0 test wallet `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB` already has 0.005 Sepolia ETH and 0.001 WETH wrapped + relayer-approved. Use it.

If SSO is gating the preview, log in via the Vercel team account first.

- [ ] **Step 2: Place a small swap**

Pair: WETH → COW (Sepolia). Amount: 0.0005 WETH. Slippage tolerance: 5%. Sign and submit.

- [ ] **Step 3: Capture the order UID**

After signing, the cowswap UI displays the order UID and a CoW Explorer link. Copy the UID.

- [ ] **Step 4: Read the order from CoW's API**

```bash
ORDER_UID=<paste UID>
curl -sS "https://api.cow.fi/sepolia/api/v1/orders/$ORDER_UID" \
  | python3 -m json.tool
```

Find the `fullAppData` field. It should be a JSON string. Parse it:

```bash
curl -sS "https://api.cow.fi/sepolia/api/v1/orders/$ORDER_UID" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
fa = d.get('fullAppData')
if not fa:
    print('NO fullAppData ON ORDER — partner fee likely not injected')
    sys.exit(1)
parsed = json.loads(fa)
pf = parsed.get('metadata', {}).get('partnerFee')
if not pf:
    print('NO metadata.partnerFee — patch not active')
    sys.exit(1)
print('partnerFee:', json.dumps(pf, indent=2))
"
```
Expected: prints

```json
{
  "bps": 5,
  "recipient": "<Ophis recipient from Task 1>",
  "volumeBps": 5
}
```

(`volumeBps` may or may not appear depending on cow-sdk version; the critical fields are `bps` and `recipient`.)

If `partnerFee` is **missing**, the deployed build is not running our patch. Possible causes:
1. Vercel deployed a stale build — trigger a fresh deploy.
2. Patch did not survive the `scripts/vercel-build.sh` git-init stub. Inspect the build logs.
3. Import path issue — surfaced earlier in local smoke test, but worth re-checking.

If `partnerFee` is **present and correct**, the phase gate is satisfied.

- [ ] **Step 5: Wait for settlement and capture tx hash**

```bash
START=$(date +%s)
for i in $(seq 1 60); do
  state=$(curl -sS "https://api.cow.fi/sepolia/api/v1/orders/$ORDER_UID" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d.get('executedBuyAmount','0'))")
  echo "[+$(($(date +%s) - START))s] $state"
  echo "$state" | grep -qE 'fulfilled|expired|cancelled' && break
  sleep 6
done

curl -sS "https://api.cow.fi/sepolia/api/v1/trades?orderUid=$ORDER_UID" \
  | python3 -m json.tool
```

If the order settles (likely within 1-2 minutes), capture the `txHash`. Sepolia solver coverage is sparse — if it expires, that is fine for this phase gate (the phase gate is partner-fee injection, not settlement timing).

- [ ] **Step 6: Write `docs/development/phase-1-5-validation.md`**

```markdown
# Phase 1.5 — Monetised Frontend Validation Log

**Date:** <YYYY-MM-DD>
**Commit at validation:** <git rev-parse HEAD>
**Vercel preview URL:** <preview URL from Task 6>

## Recipient

- Address: `<Ophis recipient address from Task 1>`
- Private key: macOS Keychain entry `ophis-partner-fee-recipient`
- Multisig upgrade: deferred to Phase 2.5 (public-launch prep)

## Test transaction

- **Network:** Sepolia
- **Trader:** `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB`
- **Pair:** WETH → COW
- **Amount in:** 0.0005 WETH
- **Order UID:** `<paste>`
- **Settlement tx:** `<paste, or "expired" / "still open"`>
- **Time-to-settle:** `<seconds, or "n/a">`

## Partner-fee verification

```json
<paste output of `metadata.partnerFee` block from Task 7 Step 4>
```

## Phase-1.5 verdict: PASS

Partner fee successfully injected into every order produced by the deployed
Ophis.app on Sepolia. Same patch works unchanged on every other CoW-supported
chain (Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Linea, Plasma, Ink,
Gnosis) — chain-independent atom modification. CoW DAO weekly disbursements
will accumulate at the recipient address; first payout expected once accrued
fees ≥ 0.001 WETH per
[CoW partner-fee documentation](https://docs.cow.fi/governance/fees/partner-fee).
```

- [ ] **Step 7: Commit**

```bash
cd /Users/scep/greg
git add docs/development/phase-1-5-validation.md
git status
git commit -m "docs(phase-1-5): partner-fee injection validated on Sepolia"
git push
```

## Task 8: Tag `v0.1.5-phase1-5` and open Phase 2 issue

**Files:** none modified.

- [ ] **Step 1: Tag**

```bash
cd /Users/scep/greg
git tag -a v0.1.5-phase1-5 -m "Phase 1.5 — partner-fee injection live on cowswap fork; revenue accrues per swap on every CoW-supported chain"
git push --tags
```

- [ ] **Step 2: Open Phase 2 tracking issue**

```bash
gh issue create --repo ophis-fi/ophis \
  --title "Phase 2: Retail UX wedge (DCA + Safe app + MEV-proof receipts + embed widget)" \
  --body "$(cat <<'EOF'
## Goal
Build the differentiation that justifies users choosing Ophis over CowSwap (we are price-equivalent on the same chains; differentiation must be UX).

## Scope
- [ ] Composable-order builder UI (DCA + TWAP) over `composable-cow`
- [ ] Safe App manifest + signing flow + Safe app store submission
- [ ] MEV-proof receipt export (PDF + JSON) for accounting/audit
- [ ] Power-user analytics dashboard (solver win-rate per pair, surplus saved vs Uniswap reference, slippage histograms)
- [ ] Embed widget — drop-in DCA component for yield protocols / DeFi blogs
- [ ] PWA polish (manifest, service worker, offline non-trade screens)

## Phase gate
- DCA / TWAP UI is usable end-to-end on Sepolia
- Safe App submission accepted
- MEV-proof receipt downloadable from a real settled order
- Embed widget loads in a third-party page

## Calendar target
May 11–24 (~2 weeks)

## Predecessor
Phase 1.5 — `docs/development/plans/2026-05-03-ophis-phase-1-5-monetized-frontend.md`
Tag: `v0.1.5-phase1-5`
EOF
)"
```

- [ ] **Step 3: Open Phase 3 tracking issue (forward-looking, no work yet)**

```bash
gh issue create --repo ophis-fi/ophis \
  --title "Phase 3: MegaETH fork-deploy — own settlement, autopilot+driver+baseline solver" \
  --body "$(cat <<'EOF'
## Goal
Deploy CoW's audited \`GPv2Settlement\` and \`GPv2VaultRelayer\` bytecode unchanged on MegaETH (chainId 4326) under our own \`AllowListAuthentication\`. Wire the vendored \`apps/backend/\` Rust services as the production runtime. Become the chain-native intent broker on a chain CoW has not deployed to.

## Scope
- [ ] MegaETH RPC + chain config validation
- [ ] Deploy GPv2Settlement + GPv2VaultRelayer + own AllowListAuthentication on MegaETH
- [ ] Adapt \`infra/local/configs/\` for MegaETH (chainId 4326, native DEX presets)
- [ ] Wire orderbook + autopilot + driver + baseline solver against MegaETH
- [ ] First swap settles end-to-end on MegaETH
- [ ] Apply for MegaETH Foundation ecosystem grant

## Phase gate
Real swap on MegaETH (chainId 4326) settled by Ophis's own settlement contract via Ophis's own driver.

## Calendar target
Jun 1–21 (~3 weeks)

## Predecessor
Phase 2.5 (public launch on CoW chains)

## References
- MegaETH: https://www.megaeth.com/
- ChainList: https://chainlist.org/chain/4326
- CoW contracts: https://github.com/cowprotocol/contracts
EOF
)"
```

## Task 9: Update memory

**Files:** `<local notes>/project_greg.md`

- [ ] **Step 1: Reflect Phase 1.5 outcome and partner-fee recipient address**

Edit `project_greg.md` to add:
- Recipient address (Task 1 output) under a new "Partner-fee recipient" section
- Update "Phase gates so far" to include Phase 1.5 PASS with the verification details
- Update "Next step" to reference Phase 2 plan (to be written after Phase 1.5 ships)

(The exact diff is straightforward — read the current file, append the new info, save.)

---

## Self-Review Notes

**Spec coverage**
- Partner-fee injection: Tasks 1–4 cover key generation, SDK extension, and the cowswap atom patch.
- Verification: Task 5 (local smoke) + Task 7 (api.cow.fi confirmation).
- Deploy: Task 6.
- Documentation: Tasks 7 (validation log), 8 (tag + Phase 2 issue), 9 (memory).

**Placeholders**
- `0xREPLACE_WITH_TASK_1_ADDRESS` is the only placeholder, and it is **explicitly required to be replaced before commit** in both Task 2 and Task 3. The phase gate (Task 7) catches the issue if it survives — `metadata.partnerFee.recipient` would be the placeholder string and the verification would fail.

**Type / name consistency**
- `OPHIS_PARTNER_FEE_BPS` (5) and `OPHIS_PARTNER_FEE_RECIPIENT` are referenced with the same names across `packages/sdk/src/partner-fee.ts` and `apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts`. Keeping the duplicate in sync is documented in `apps/frontend/.ophis-divergences.md`.
- `PartnerFee` type imported from `@cowprotocol/widget-lib` matches the type expected by `injectedWidgetPartnerFeeAtom`.

**Risks the plan acknowledges**
- The cowswap fork modification creates a tracked divergence from upstream. Documented in Task 3's `.ophis-divergences.md`.
- The recipient EOA is single-sig in Phase 1.5; upgrade to Safe in Phase 2.5 before any meaningful balance accumulates (CoW pays out weekly, smallest payout 0.001 WETH, so timing aligns).
- Sepolia solver coverage is sparse — Task 7 Step 5 explicitly accepts that the order may not settle within the validation window. The phase gate is partner-fee injection, not settlement timing.

**Out of scope (to prevent drift)**
- DCA / TWAP UI — Phase 2.
- Safe app — Phase 2.
- MEV-proof receipts — Phase 2.
- Embed widget — Phase 2.
- Treasury tier (T2 self-serve) — Phase 3.5.
- API tier (T3 self-serve) — Phase 4.
- MegaETH deployment — Phase 3.
- Stripe / OFAC / VAT compliance — explicitly excluded per Clement's instruction (2026-05-03).
