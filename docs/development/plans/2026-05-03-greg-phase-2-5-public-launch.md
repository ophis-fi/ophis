# Greg Phase 2.5 — Public Launch Implementation Plan


**Goal:** Take the Phase-2 substrate to a public launch — finish the engineering polish (trade-data threading into receipts, SVG icon for Safe, top-level DCA CTA), make operational decisions (real brand + domain + multisig recipient), and ship the launch (production Vercel deploy + Safe-list submission + Show HN).

**Architecture:** Phase 2.5 is mostly **operational + small engineering**, not new product. The Phase-2 substrate already ships the heavy machinery (mevReceipt module, manifest hardening, PWA, Safe-app readiness). Phase 2.5 adds polish (trade-data thread, SVG icon, top-level DCA entry), changes operational state (brand, domain, multisig, production target, Safe-list listing), and does the launch (Show HN, PH, social).

**Tech Stack:** TypeScript, cow-sdk's `orderBookApi`, the vendored cowswap fork, Vercel custom domains + production target, Cloudflare DNS, Safe wallet (deployed via [app.safe.global](https://app.safe.global) for the multisig recipient), GitHub PR against [`safe-global/safe-apps-list`](https://github.com/safe-global/safe-apps-list).

**Spec:** [`docs/development/specs/2026-05-02-greg-design.md`](../specs/2026-05-02-greg-design.md) + [`docs/development/specs/2026-05-03-greg-design-amendment.md`](../specs/2026-05-03-greg-design-amendment.md)

**Predecessor plan:** [`docs/development/plans/2026-05-03-greg-phase-2-retail-substrate.md`](2026-05-03-greg-phase-2-retail-substrate.md) — Phase 2 PASS, tag `v0.2-phase2`.

---

## Operator decisions to lock BEFORE execution

These three decisions must be captured before the plan starts. The implementer cannot decide them; Clement does. The plan tasks reference these inputs.

| # | Decision | Default if undecided |
|---|---|---|
| **D1** | Real project name (vs keep codename `greg`) | Keep `greg`; rename can land in a Phase 2.6 mini-plan once a name surfaces |
| **D2** | Production domain | Use the existing Vercel branch alias `https://greg-git-main-clementfrmds-projects.vercel.app`; switch to a real domain in a Phase 2.6 mini-plan |
| **D3** | Safe multisig recipient — which chain to deploy on, and which signer EOAs | Deploy a 2-of-3 Safe on Gnosis Chain (lowest gas), signers = Clement's primary EOA + 1 backup EOA + 1 hardware-wallet-protected EOA |

If Clement does not decide D1 / D2 by the time Tasks 4 (manifest update) or 7 (production deploy) start, the plan executes the **defaults** above. D3 is required to start Task 6 (multisig upgrade) — the implementer holds Task 6 if undecided.

**Phase gate:**

1. Trade-data threaded through `ReceiptModal` so settled orders' receipts contain `settlementTxHash` + `settlementBlock`.
2. SVG icon variant added; manifest updated.
3. DCA top-level CTA visible on home page; clicks route to `/advanced`.
4. Multisig partner-fee recipient deployed and live in `@greg/sdk` + `partnerFeeDefault.ts`.
5. Production Vercel deployment promoted (or already serving the same content with SSO disabled on production target only).
6. Safe-list PR against `safe-global/safe-apps-list` open with our deployment URL.
7. Show HN draft committed to `docs/development/show-hn-draft.md`; Product Hunt page draft committed to `docs/development/product-hunt-draft.md`.

Validation log committed to `docs/development/phase-2-5-validation.md`. Tag `v0.2.5-phase2-5`.

---

## File Structure (created or modified by this plan)

| Path | Action | Purpose |
|---|---|---|
| `apps/frontend/apps/cowswap-frontend/src/modules/ordersTable/pure/ReceiptModal/ReceiptModal.modal.tsx` | modify | Fetch trades via `orderBookApi.getTrades(...)`, pass first trade into `DownloadReceiptButton.input.trade` |
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts` | modify | Test that confirms `settlementTxHash` populates when `trade` is supplied (already covered by existing tests; this task changes the consumer, not buildReceipt itself) |
| `apps/frontend/apps/cowswap-frontend/public/greg-icon.svg` | create | Square SVG ≥ 128×128 for Safe app store |
| `apps/frontend/apps/cowswap-frontend/public/manifest.json` | modify | `iconPath` → `/greg-icon.svg` |
| `apps/frontend/apps/cowswap-frontend/src/<home page>` | modify | Add a "Set up a DCA" top-level CTA linking to `/advanced` |
| `packages/sdk/src/partner-fee.ts` | modify | `GREG_PARTNER_FEE_RECIPIENT` → multisig address |
| `apps/frontend/apps/cowswap-frontend/src/greg/partnerFeeDefault.ts` | modify | mirror update |
| `apps/frontend/.greg-divergences.md` | modify | track Phase-2.5 entries |
| `docs/development/show-hn-draft.md` | create | Show HN post + thread plan |
| `docs/development/product-hunt-draft.md` | create | Product Hunt submission text |
| `docs/development/phase-2-5-validation.md` | create | phase-gate evidence |

**Not modified:** `apps/backend/`, `infra/`, the partner-fee atom (Phase 1.5), the mevReceipt module's internals (Phase 2 — only the consumer changes).

---

## Dispatch hints

- **Tasks 1, 2, 5, 9, 10:** `frontend` agent — engineering tasks (TDD-shaped where applicable).
- **Tasks 3, 4, 6, 7, 8:** main session (CTO) — operational tasks needing wallet + Safe + DNS access.
- **Task 11:** main session — close-out + tag.

---

## Task 1: Thread trade-API data into `ReceiptModal`

**Files:**
- Modify: `apps/frontend/apps/cowswap-frontend/src/modules/ordersTable/pure/ReceiptModal/ReceiptModal.modal.tsx`

The `mevReceipt` module's `buildReceipt` already accepts a `trade` argument and produces `settlementTxHash` + `settlementBlock` from it. The modal currently passes `trade: null`. This task fetches trades from `api.cow.fi/<chain>/api/v1/trades?orderUid=<uid>` via cowswap's existing `orderBookApi` singleton and passes the first matching trade in.

### Step 1: Inspect cowswap's orderBookApi for the trades method

```bash
cd /Users/scep/greg/apps/frontend
grep -RIn 'getTrades\|/trades' node_modules/@cowprotocol/cow-sdk/dist 2>/dev/null \
  | grep -v 'd.ts.map' | head -10
# or check the OrderBookApi class:
grep -RIn 'class OrderBookApi' node_modules/@cowprotocol/cow-sdk/ 2>/dev/null | head -3
```

Cowswap's `cow-sdk` `OrderBookApi` exposes `getTrades({ orderUid }) → Promise<Trade[]>`. The full signature lives in the cow-sdk types — confirm by reading the type or by inspecting how cowswap already calls `orderBookApi.<method>` elsewhere in the codebase.

### Step 2: Read the current `ReceiptModal.modal.tsx`

Open the file. Locate the spot where `<DownloadReceiptButton input={...} />` is mounted (added in Phase 2 Task 4). The current call is something like:

```typescript
<DownloadReceiptButton
  input={{
    order: { /* mapped from ParsedOrder */ },
    trade: null,
    chainId,
  }}
  format="json"
/>
```

(The exact field mapping was set up by the Phase-2 implementer; preserve everything except the `trade: null` part.)

### Step 3: Add trade-fetching state + effect

Add at the top of the `ReceiptModal` functional component:

```typescript
import { useEffect, useState } from 'react'
import { orderBookApi } from 'cowSdk'

// ... existing imports ...

interface MinimalTrade {
  blockNumber: number
  txHash: string
  buyAmount: string
  sellAmount: string
}

// Inside the component, near other state:
const [tradeForReceipt, setTradeForReceipt] = useState<MinimalTrade | null>(null)

useEffect(() => {
  // Only fetch when the order is fulfilled and we have a UID + chainId.
  if (order.status !== OrderStatus.FULFILLED || !order.id || !chainId) {
    setTradeForReceipt(null)
    return
  }

  let cancelled = false
  orderBookApi
    .getTrades({ orderUid: order.id }, { chainId })
    .then((trades) => {
      if (cancelled || !trades || trades.length === 0) return
      const t = trades[0]
      setTradeForReceipt({
        blockNumber: t.blockNumber,
        txHash: t.txHash,
        buyAmount: String(t.buyAmount),
        sellAmount: String(t.sellAmount),
      })
    })
    .catch(() => {
      if (!cancelled) setTradeForReceipt(null)
    })
  return () => {
    cancelled = true
  }
}, [order.status, order.id, chainId])
```

Notes:
- `OrderStatus.FULFILLED` is imported from `legacy/state/orders/actions` (already imported in the file).
- The exact `getTrades` call signature on `OrderBookApi` may differ — check `cow-sdk` types. Common forms:
  - `orderBookApi.getTrades({ orderUid: order.id })` (chain inferred from configured `chainId` on the API instance)
  - `orderBookApi.getTrades({ orderUid: order.id }, { chainId })` (explicit per-call override)
- If the call needs an `owner` filter instead of `orderUid`, fetch by owner and filter the result array client-side. Either path produces a single trade for a fulfilled order.

### Step 4: Pass `tradeForReceipt` into the button

Replace `trade: null` in the `<DownloadReceiptButton input={...}>` mount with:

```typescript
trade: tradeForReceipt,
```

### Step 5: Build cowswap to confirm types check + UI compiles

```bash
cd /Users/scep/greg/apps/frontend
pnpm run build:cowswap 2>&1 | tail -10
```
Expected: build succeeds. If TypeScript errors on the trade type mapping, fix the mapping (likely a string-vs-number coercion on `blockNumber` or `buyAmount`/`sellAmount`).

### Step 6: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/apps/cowswap-frontend/src/modules/ordersTable/pure/ReceiptModal/ReceiptModal.modal.tsx
git status
git commit -m "feat(mevReceipt): thread orderBookApi.getTrades into ReceiptModal so receipts include settlementTxHash + block"
git push
git log --oneline -3
```

### Step 7: Live verification (recommended; defer if no settled order is open)

If the Phase-1.5 test wallet has a recent fulfilled order on Sepolia (e.g., the `0x8e03c24d…79657` from Phase 1.5 validation), open the deployed app, navigate to the order in the orders table, click to open `ReceiptModal`, hit "Download JSON receipt", inspect the file. Expected: `settlementTxHash` is `"0x00eb2964…d17e9"`, `settlementBlock` is `10783287`.

If no settled order is available, mark this step as deferred and note it in the validation log.

## Task 2: Real brand + name decision (operator)

**Files:** none, OR a sweeping rename if Clement decides to retire `greg`.

This is a decision point, not engineering work. **Clement decides between:**

- **A.** Keep codename `greg` for Phase 2.5 launch. Rename later in a Phase 2.6 mini-plan.
- **B.** Retire `greg`, pick a real name. Rename across the codebase and assets.

If **A**, this task closes immediately with a one-line note in the validation log: `Decision A — codename "greg" retained for Phase 2.5 launch.`

If **B**, the rename touches:

- [ ] `apps/frontend/apps/cowswap-frontend/public/manifest.json` — `name`, `short_name`, `description`
- [ ] `apps/frontend/apps/cowswap-frontend/index.html` — `<title>`, OG tags
- [ ] `apps/frontend/libs/ui/src/pure/ProductLogo/index.tsx` — alt text
- [ ] `packages/sdk/package.json` — package name
- [ ] `infra/rpc/package.json` — package name
- [ ] All `@greg/*` imports across the workspace
- [ ] Root `package.json` — `name` field
- [ ] `README.md`
- [ ] GitHub repo rename (`san-npm/greg` → `san-npm/<newname>`) via `gh repo rename`
- [ ] Vercel project rename via API/dashboard
- [ ] Memory: `project_greg.md` rename (or just update content; file rename optional)

If Clement picks **B**, the rename is mechanical but wide-reaching. Treat it as a single atomic commit `chore: rename project from greg to <newname>` with the entire diff prepared in one go. Verify Vercel auto-deploys still trigger after the GitHub repo rename.

If undecided by the time Task 4 (manifest update for icon) starts, default to **A** and proceed.

## Task 3: Real domain configuration (operator)

**Files:** maybe `apps/frontend/apps/cowswap-frontend/public/manifest.json` (`homepage_url`).

### Step 1: Decide

Clement picks one of:
- Keep using `greg-git-main-clementfrmds-projects.vercel.app` (free, automatic, hash-shaped). Plan default if undecided.
- Use one of the existing `openletz.{com,fr,info,ai}` domains as a Greg subdomain (e.g., `greg.openletz.com`). Free; just DNS work.
- Register a new domain — e.g., `greg.app`, `greg.fi`, `usegreg.app`, or whatever brand work picks.

### Step 2: Configure domain (only if not the default)

If using an existing Cloudflare-managed domain:

```bash
# 1. Add the domain to the Vercel project as a custom domain.
VC_TOKEN=$(cat ~/Library/Application\ Support/com.vercel.cli/auth.json | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
TEAM=team_C0UfZCb5p2kuRtKKRcZpt0qd
PROJECT=prj_Bphlj9iJ6kFDT9n99ojNYULs8cDc
DOMAIN=<your domain, e.g., greg.openletz.com>

curl -sS -X POST "https://api.vercel.com/v10/projects/${PROJECT}/domains?teamId=${TEAM}" \
  -H "Authorization: Bearer $VC_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${DOMAIN}\"}"

# 2. Vercel returns required DNS records. Add them to Cloudflare via UI or API.

# 3. Wait for DNS propagation; verify HTTPS via:
curl -sI "https://${DOMAIN}" | head -3
```

If registering a new domain: register through Cloudflare (Clement's existing account) for cleanest setup; or any registrar Clement prefers.

### Step 3: Update `manifest.json`

```bash
cd /Users/scep/greg
# Edit apps/frontend/apps/cowswap-frontend/public/manifest.json:
# - "homepage_url": "https://greg-git-main-clementfrmds-projects.vercel.app"
# + "homepage_url": "https://<new-domain>"
```

### Step 4: Commit (only if changes made)

```bash
git add apps/frontend/apps/cowswap-frontend/public/manifest.json
git commit -m "feat(domain): manifest homepage_url → real production domain"
git push
```

If keeping the Vercel branch alias as the launch URL, this task closes with no commits.

## Task 4: SVG icon for Safe app store

**Files:**
- Create: `apps/frontend/apps/cowswap-frontend/public/greg-icon.svg`
- Modify: `apps/frontend/apps/cowswap-frontend/public/manifest.json` (update `iconPath`)

Safe app store prefers SVG icons (≥ 128×128 square). The current `iconPath` points at the 512px PNG inherited from cowswap upstream. A Greg-specific SVG is small to produce and improves Safe app presentation.

### Step 1: Create the SVG

If Clement has a brand identity, use it. If not (default), use a placeholder geometric "G" mark. Drop it at `apps/frontend/apps/cowswap-frontend/public/greg-icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="48" fill="#0F172A"/>
  <text x="50%" y="50%" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif"
        font-size="160" font-weight="700" fill="#F8FAFC"
        text-anchor="middle" dominant-baseline="central">G</text>
</svg>
```

Adjust colours / shapes per brand decision. Anything respecting "square ≥128×128 SVG" passes Safe spec.

### Step 2: Update manifest

Edit `apps/frontend/apps/cowswap-frontend/public/manifest.json`:
```json
"iconPath": "/greg-icon.svg"
```
(Was `/android-chrome-512x512.png`. Keep the `icons` array as-is — those are the W3C-spec PWA icons; `iconPath` is the Safe-spec field only.)

### Step 3: Build + verify

```bash
cd /Users/scep/greg/apps/frontend
pnpm run build:cowswap 2>&1 | tail -5
ls build/cowswap/greg-icon.svg && echo "✓ icon copied to build"
cat build/cowswap/manifest.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('iconPath:', d.get('iconPath'))
"
```

### Step 4: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/apps/cowswap-frontend/public/greg-icon.svg \
        apps/frontend/apps/cowswap-frontend/public/manifest.json
git status
git commit -m "feat(branding): SVG icon variant + manifest iconPath update"
git push
```

## Task 5: DCA top-level CTA on home page

**Files:**
- Modify: cowswap home page component (location to be discovered in Step 1)

The DCA flow already exists at the `/advanced` route via `TwapFormWidget` (Phase 2 Task 1 verified). Phase 2.5 surfaces it from the home page so retail users discover it without spelunking through "Advanced".

### Step 1: Locate the home / swap page component

```bash
cd /Users/scep/greg/apps/frontend
grep -RIln 'export.*Swap.*Page\|export.*Trade.*Page' apps/cowswap-frontend/src/pages/ 2>/dev/null \
  | grep -v 'test\|mock' | head -5

ls apps/cowswap-frontend/src/pages/ 2>/dev/null
```

The home page is most likely `apps/cowswap-frontend/src/pages/Swap/SwapPage.tsx` or `apps/cowswap-frontend/src/pages/index.tsx` or similar. Confirm by inspecting the cowswap router config:
```bash
grep -RIn 'path:.*"/"' apps/cowswap-frontend/src/ 2>/dev/null | head -5
```

### Step 2: Add a CTA banner

Add (do not refactor) a small element above the existing swap form on the home page. Aim for ~10-15 lines of JSX:

```tsx
import { Link } from 'react-router-dom'

// ... near the top of the home page render ...

<div
  style={{
    margin: '12px 0',
    padding: '12px 16px',
    border: '1px solid currentColor',
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  }}
>
  <span>
    <strong>New:</strong> Set up a DCA — buy on a schedule, MEV-protected, gas-free.
  </span>
  <Link
    to="/advanced"
    style={{
      padding: '8px 16px',
      borderRadius: 8,
      background: 'currentColor',
      color: 'inherit',
      textDecoration: 'none',
      whiteSpace: 'nowrap',
    }}
  >
    Set up a DCA →
  </Link>
</div>
```

Adjust styling to match cowswap's existing component library (`@cowprotocol/ui`) if obvious patterns exist — but don't refactor extensively. The goal is "visible, clickable, routes to /advanced." Polish + brand-aligned styling is a Phase 2.6 task once a brand exists.

### Step 3: Build + visual smoke check

```bash
cd /Users/scep/greg/apps/frontend
pnpm run build:cowswap 2>&1 | tail -5
```

Optionally run the dev server and visit `/` to confirm the CTA renders. If the dev server is overkill, building successfully is enough — visual regression testing is a Phase 2.6 task.

### Step 4: Commit

```bash
cd /Users/scep/greg
git add <home-page-file>
git status
git commit -m "feat(dca): top-level 'Set up a DCA' CTA on home page"
git push
```

## Task 6: Multisig partner-fee recipient upgrade (operator)

**Files:**
- Modify: `packages/sdk/src/partner-fee.ts`
- Modify: `apps/frontend/apps/cowswap-frontend/src/greg/partnerFeeDefault.ts`

The Phase-1.5 single-sig EOA `0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E` becomes a single point of failure once partner-fee accrual hits the first WETH disbursement (≥ 0.001 WETH per [CoW partner-fee docs](https://docs.cow.fi/governance/fees/partner-fee)). Upgrade to a multisig before that.

### Step 1: Deploy a Safe (operator)

Open [https://app.safe.global](https://app.safe.global) → "Create Safe". Configuration:
- **Network:** Gnosis Chain (lowest gas; Safe is CREATE2-deployed so the same address can be claimed on every CoW-supported chain later).
- **Owners:** at least 2 EOAs Clement controls (recommendation: primary EOA + hardware-wallet-backed EOA + 1 backup).
- **Threshold:** 2-of-3 (or 2-of-2 if only 2 signers).
- **Salt:** none — leave default.

After deployment, capture the Safe's address. **Verify the same address resolves on every other CoW-supported chain** by visiting the Safe URL on each (Safe deploys deterministically via CREATE2 + ProxyFactory — same code, same address, same threshold needed if you want it usable across chains; some chains may need a follow-up deploy with the same factory + same salt).

### Step 2: Update `@greg/sdk` source of truth

Edit `/Users/scep/greg/packages/sdk/src/partner-fee.ts`:
```typescript
export const GREG_PARTNER_FEE_RECIPIENT =
  '0x<NEW_SAFE_ADDRESS>' as `0x${string}`;
```

### Step 3: Update inline mirror in cowswap fork

Edit `/Users/scep/greg/apps/frontend/apps/cowswap-frontend/src/greg/partnerFeeDefault.ts`:
```typescript
const GREG_PARTNER_FEE_RECIPIENT = '0x<NEW_SAFE_ADDRESS>' as const
```

### Step 4: Run tests

```bash
cd /Users/scep/greg
pnpm --filter @greg/sdk test
pnpm --filter @greg/sdk typecheck

cd apps/frontend
pnpm run build:cowswap 2>&1 | tail -5
```
Expected: 7 sdk tests still pass (4 of them assert `recipient` matches the constant; they pass regardless of which address is set). Cowswap build succeeds.

### Step 5: Update docs

Edit `apps/frontend/.greg-divergences.md` to note the recipient change. Edit `docs/development/safe-app-submission.md` and `docs/development/phase-1-5-validation.md` to reflect the new recipient (search-replace the old EOA address).

### Step 6: Commit

```bash
cd /Users/scep/greg
git add packages/sdk/src/partner-fee.ts \
        apps/frontend/apps/cowswap-frontend/src/greg/partnerFeeDefault.ts \
        apps/frontend/.greg-divergences.md \
        docs/development/
git status
git commit -m "feat(partnerFee): upgrade recipient from single-sig EOA to multisig Safe"
git push
```

### Step 7: Memory + Keychain update

- Update `<local notes>/project_greg.md` — replace the EOA address with the Safe address; note signer setup.
- Optionally: keychain entry `greg-partner-fee-recipient` can be **deleted** since the EOA is no longer the recipient (Safe is signed via owner EOAs, which Clement holds elsewhere).

## Task 7: Promote production Vercel deployment + SSO state

**Files:** none (Vercel-side configuration).

### Step 1: Promote latest preview to production

```bash
VC_TOKEN=$(cat ~/Library/Application\ Support/com.vercel.cli/auth.json | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
TEAM=team_C0UfZCb5p2kuRtKKRcZpt0qd
PROJECT=prj_Bphlj9iJ6kFDT9n99ojNYULs8cDc

# Find the latest READY preview deployment for main:
LATEST_DEP_ID=$(curl -sS "https://api.vercel.com/v6/deployments?projectId=${PROJECT}&teamId=${TEAM}&state=READY&limit=1&target=preview" \
  -H "Authorization: Bearer $VC_TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
deps = d.get('deployments', [])
if deps:
    print(deps[0].get('uid', ''))
")
echo "Latest deploy: $LATEST_DEP_ID"

# Promote to production via API:
curl -sS -X POST "https://api.vercel.com/v13/deployments/${LATEST_DEP_ID}/promote?teamId=${TEAM}" \
  -H "Authorization: Bearer $VC_TOKEN"
```

(Or use `vercel promote <deployment-url>` from the CLI if simpler.)

### Step 2: Verify SSO state

Production should be public (anyone can load it); previews stay team-gated.

```bash
curl -sS "https://api.vercel.com/v9/projects/${PROJECT}?teamId=${TEAM}" \
  -H "Authorization: Bearer $VC_TOKEN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('ssoProtection:', d.get('ssoProtection'))
"
```

The `deploymentType: "preview"` setting from Phase 1.5 is correct — production deployments are not SSO-gated when this is set. Confirm with:

```bash
PROD_URL=https://<production-alias>  # e.g., the project's production domain or default *.vercel.app
curl -sI "$PROD_URL" | head -3  # expect HTTP 200, not 401
```

If production is unexpectedly 401: the project may have `ssoProtection.deploymentType: "all"` instead of `"preview"`. Patch back to preview-only.

### Step 3: Document in `infra/local/README.md` or a new ops doc

Add a brief operator note to `docs/development/` capturing the production URL + SSO state for future reference.

### Step 4: No code commit (Vercel-side state)

If `infra/` doc was edited, commit that. Otherwise this task closes with no git activity.

## Task 8: Submit Safe-app PR against `safe-global/safe-apps-list`

**Files:** none in this repo (PR lives in the upstream repo).

### Step 1: Fork `safe-global/safe-apps-list`

```bash
gh repo fork safe-global/safe-apps-list --clone --remote
cd safe-apps-list
```

### Step 2: Add Greg's entry

Open the appropriate community list file (`apps.json`, `community-list.json`, or whatever the current convention is — read `CONTRIBUTING.md` first). Append a new entry:

```json
{
  "url": "https://<production URL from Task 3 — or the Vercel branch alias if Task 3 kept the default>",
  "networks": [1, 100, 8453, 42161, 137, 43114, 56, 59144, 11155111]
}
```

(Drop `networks` items that the upstream list doesn't accept, if any. Match the format of existing entries in the file.)

### Step 3: Open the PR

```bash
git checkout -b add-greg-app
git add <the modified list file>
git commit -m "Add Greg — DCA + TWAP for power users on top of CoW Protocol"
git push -u origin add-greg-app
gh pr create --repo safe-global/safe-apps-list \
  --title "Add Greg — DCA + TWAP for power users on top of CoW Protocol" \
  --body "$(cat <<'EOF'
## App URL

https://<production URL>

## Description

Greg is a DCA / TWAP front-end built on top of CoW Protocol. MEV-protected, gasless, multi-chain. The deployment is a Safe app: it loads cleanly inside the Safe iframe and uses the upstream `@safe-global/safe-apps-sdk` integration to detect a Safe parent and prompt for connection.

## Networks

Same as CoW Protocol's deployed chains: 1 (Ethereum), 100 (Gnosis), 8453 (Base), 42161 (Arbitrum), 137 (Polygon), 43114 (Avalanche), 56 (BNB), 59144 (Linea), 11155111 (Sepolia).

## Manifest

Served at `<URL>/manifest.json` with `Access-Control-Allow-Origin: *`. Includes Safe-spec fields: `name`, `description` (≤200 chars), `iconPath`.

## Safe-app readiness checks

- [x] Manifest reachable + CORS-allowed
- [x] No `X-Frame-Options` blocking iframe load
- [x] Cowswap upstream's `@safe-global/safe-apps-sdk` integration detects Safe parent
- [x] Manifest includes Safe-spec `iconPath` + `description`

Verification log: <link to docs/development/safe-app-submission.md>
EOF
)"
```

### Step 4: Capture the PR URL

The Safe-list PR URL is part of the Phase 2.5 validation log (Task 11).

## Task 9: Show HN draft

**Files:**
- Create: `docs/development/show-hn-draft.md`

Write the post + comment thread plan. Engineering-light, content-heavy. Treat as a writing task, not a code task.

### Step 1: Write the draft

`docs/development/show-hn-draft.md`:

```markdown
# Show HN draft — Greg

## Title
(60-80 characters; HN cap is around 80)

> Show HN: Greg – DCA and TWAP on CoW Protocol with MEV-proof receipts

## Body (≤ 200 words)

Hi HN,

Greg is a frontend over CoW Protocol focused on power-user retail: DCA, TWAP,
and MEV-proof execution receipts that DAO treasuries can hand to their
auditors. We use CoW's settlement contracts and solver network — same MEV
protection, same gasless UX as cow.fi — but we layer:

- A polished DCA / TWAP entry point from the home page (no "Advanced Orders" hunt)
- Downloadable MEV-proof receipts (JSON + PDF) on every settled order, including
  solver competition data and surplus capture vs the quote
- Safe app integration so multisig treasurers can batch-approve

Live on 10 chains (ETH, Gnosis, Base, Arb, Polygon, Avax, BNB, Linea, Plasma, Ink).
Free for users — we make money via CoW's partner-fee mechanism (5 bps,
disbursed weekly in WETH by CoW DAO).

Source: <repo URL once public, or "private GPL-3.0 repo, opening up at v0.3">

Would love feedback on:
- Is the receipt schema useful for treasury accounting? (gist of a sample receipt linked above)
- Anyone running a DAO treasury who wants to pilot?

Thanks!

## First-comment / OP follow-up plan

A pre-drafted OP comment posted ~30 seconds after the submission goes live.
Format: explain the technical approach + link to the spec / amendment / phase-2-validation.

> A bit more context for HN: ...
> 1) ...
> 2) ...
> 3) ...

## Timing

Best HN submission window: Tuesday or Wednesday, 8:00–10:00 EST. Avoid
weekends (lower traffic) and Mondays (everyone posts then).

## Anticipated questions + prepared answers

| Q | A |
|---|---|
| "How is this different from cow.fi?" | We add DCA-as-a-product, MEV-proof receipts, and a treasury-friendly UX. Cow.fi's UI is general; we're vertical. |
| "Why ride CoW Protocol instead of forking?" | Audited contracts + a solver network we can't replicate. Forking would mean a 6-figure audit and bootstrapping solvers. Phase 3 of our roadmap addresses non-CoW chains by deploying CoW's audited bytecode unchanged. |
| "How do you make money?" | 5 bps partner fee on every order, disbursed weekly in WETH by CoW DAO. Free for users on the same chains. |
| "What's the catch?" | We're locked to CoW's chain footprint until we deploy our own settlement (Phase 3). |
```

### Step 2: Commit

```bash
cd /Users/scep/greg
git add docs/development/show-hn-draft.md
git commit -m "docs(launch): Show HN post draft"
git push
```

## Task 10: Product Hunt draft

**Files:**
- Create: `docs/development/product-hunt-draft.md`

`docs/development/product-hunt-draft.md`:

```markdown
# Product Hunt draft — Greg

## Tagline (≤ 60 chars)
DCA and TWAP for power users — MEV-protected, gasless

## Description (≤ 260 chars)
Greg lets you DCA into any token across 10 chains with MEV protection, gasless UX, and downloadable execution receipts your treasury auditor will actually accept. Built on CoW Protocol's solver network. Free for retail.

## Topics
- Crypto
- DeFi
- Trading
- Productivity
- Open Source

## First-day media checklist
- Hero GIF: home page → DCA setup → confirmation (15-20 sec)
- Screenshot: receipt PDF download
- Screenshot: Safe app integration
- Screenshot: TWAP order in flight on Etherscan

## Maker comment (pinned)
Greg captures partner-fee revenue from CoW Protocol's mechanism and
re-invests it in shipping the features you'd actually pay for: DCA,
treasury-friendly receipts, Safe-native flows. We're positioning this as
"the trader's CoW" — same execution quality, vertical UX. Feedback wanted!

## Launch timing
- Submit Sunday evening for Monday launch (PH's standard pattern).
- Coordinate with Show HN: 1-2 days apart, not the same day.
- Pre-warm: 5-10 community members ready to upvote in the first hour.
```

Commit: `git commit -m "docs(launch): Product Hunt draft"`

## Task 11: Phase 2.5 close-out

**Files:**
- Create: `docs/development/phase-2-5-validation.md`
- Modify: `apps/frontend/.greg-divergences.md` (add Phase 2.5 entries)

### Step 1: Append Phase 2.5 divergences

Open `apps/frontend/.greg-divergences.md`. Append:

```markdown
## Modified (Phase 2.5, 2026-05-XX)

- `apps/cowswap-frontend/src/modules/ordersTable/pure/ReceiptModal/ReceiptModal.modal.tsx` —
  fetch trades via `orderBookApi.getTrades` and pass into `DownloadReceiptButton.input.trade`
  so receipts include settlementTxHash + block. Phase 2.5 Task 1.
- `apps/cowswap-frontend/public/manifest.json` — `iconPath` → `/greg-icon.svg`. Phase 2.5 Task 4.
- `apps/cowswap-frontend/<home-page-file>` — added "Set up a DCA" top-level CTA. Phase 2.5 Task 5.

## Added (Phase 2.5)

- `apps/cowswap-frontend/public/greg-icon.svg` — Safe-app SVG icon. Phase 2.5 Task 4.
```

### Step 2: Write `docs/development/phase-2-5-validation.md`

```markdown
# Phase 2.5 — Public Launch Validation Log

**Date:** <YYYY-MM-DD>
**Commit at validation:** `<git rev-parse HEAD>`
**Production URL:** <production URL after Task 3 / Task 7>

## Operator decisions captured

- D1 (brand): <Greg codename retained | renamed to <newname>>
- D2 (domain): <Vercel branch alias | <real domain>>
- D3 (multisig): <Safe address — chain — signer setup>

## Phase gate

| Gate | Evidence | Result |
|---|---|---|
| Trade-data threaded into ReceiptModal | Task 1 commit `<sha>`. <Live verify result if performed.> | <PASS / DEFERRED> |
| SVG icon variant added; manifest updated | Task 4 commit `<sha>`. `iconPath: /greg-icon.svg` in served manifest. | PASS |
| DCA top-level CTA visible | Task 5 commit `<sha>`. CTA links to `/advanced` from home. | PASS |
| Multisig partner-fee recipient deployed and live | Task 6 commit `<sha>`. Recipient = `<safe address>`. | PASS |
| Production deploy promoted + SSO state correct | Task 7. Production URL serves 200; SSO `deploymentType: preview`. | PASS |
| Safe-list PR open | Task 8. PR URL: `<github URL>`. | PASS |
| Show HN draft + Product Hunt draft committed | Tasks 9 + 10. Committed at `<sha>` and `<sha>`. | PASS |

## Phase 2.5 verdict: PASS

Greg is live to the public. Partner-fee meter runs on every swap. Safe-app
listing pending review. Show HN / PH ready to fire on Clement's signal.

## Next phase

Phase 3 — MegaETH fork-deploy (issue #4). Deploys CoW's audited
GPv2Settlement + GPv2VaultRelayer bytecode unchanged on MegaETH (chainId
4326) under our own AllowListAuthentication. Calendar Jun 1–21.
```

### Step 3: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/.greg-divergences.md docs/development/phase-2-5-validation.md
git status
git commit -m "docs(phase-2-5): close-out — Greg launched publicly"
git push
```

### Step 4: Tag

```bash
git tag -a v0.2.5-phase2-5 -m "Phase 2.5 — Public Launch PASS

Trade-API data threaded into ReceiptModal: receipts now include
settlementTxHash + block on settled orders.
SVG icon for Safe app store. DCA top-level CTA on home page.
Multisig partner-fee recipient deployed.
Production Vercel target promoted; SSO preview-only.
Safe-list submission PR open at <URL>.
Show HN + Product Hunt drafts committed.

Greg is publicly accessible. Partner-fee meter runs on every swap.
Phase 3 (MegaETH fork-deploy) is the next milestone."
git push --tags
```

### Step 5: Close issue #5; verify Phase 3 issue (#4) still accurate

```bash
gh issue close 5 --repo san-npm/greg --comment "Phase 2.5 complete and tagged \`v0.2.5-phase2-5\`. Validation: \`docs/development/phase-2-5-validation.md\`. Phase 3 (issue #4) is next."
```

### Step 6: Update memory

- `<local notes>/project_greg.md` — append Phase 2.5 to gates section, add `v0.2.5-phase2-5` tag, update Next Step to reference Phase 3 (MegaETH).
- `<local notes>/MEMORY.md` — update Greg one-liner.

## Task 12: Operational follow-ups (non-blocking)

These are not phase-gate items but should be tracked.

- [ ] **Watch for first WETH disbursement.** CoW DAO disburses partner fees weekly when accrued ≥ 0.001 WETH. Monitor the recipient address (multisig from Task 6) and announce the first payout publicly (great social-proof content).
- [ ] **Greg-styled receipt PDF** — current `exportPdf` uses plain monospace. Phase 2.6 task: add Greg logo + brand colours to the PDF template.
- [ ] **Mobile PWA install verification** — once a real domain exists, run install on iOS Safari + Android Chrome.
- [ ] **Embed widget productisation** — cowswap supports widget mode; Phase 2.6 or Phase 4 turns it into a public component for partners to drop into their pages.
- [ ] **Trade-data 2nd pass** — Task 1 wires `orderBookApi.getTrades` for fulfilled orders. Open / partial orders still show `settlementTxHash: null`. That's correct behaviour, but the UI can hide the receipt-download button for non-fulfilled orders to reduce confusion.

---

## Self-Review Notes

**Spec coverage**

- Trade-data into ReceiptModal: Task 1 (engineering, must-have).
- Brand decision: Task 2 (operator decision; default = keep `greg`).
- Domain: Task 3 (operator; default = Vercel alias).
- SVG icon for Safe: Task 4 (engineering, small).
- DCA top-level CTA: Task 5 (engineering, small).
- Multisig recipient: Task 6 (operator + engineering).
- Production deploy + SSO state: Task 7 (operator).
- Safe-list PR: Task 8 (operator + content).
- Show HN draft: Task 9 (content).
- Product Hunt draft: Task 10 (content).
- Phase 2.5 close-out: Task 11.
- Operational follow-ups: Task 12 (tracking only).

**Placeholders:** explicit `<placeholder>` tokens are used where Clement-decided values are required (D1/D2/D3, PR URLs, Safe address). The plan is honest about which fields the implementer fills at runtime vs which Clement decides upfront.

**Type / name consistency:** `GREG_PARTNER_FEE_RECIPIENT` / `GREG_DEFAULT_PARTNER_FEE` / `MevProofReceipt` / `BuildReceiptInput` / `tradeForReceipt` types are reused consistently across Tasks 1, 6.

**Out of scope (to prevent drift)**

- Power-user analytics dashboard — deferred.
- Embed widget productisation — Phase 2.6 / Phase 4.
- Greg-styled PDF receipt template — Phase 2.6.
- Mobile PWA install (real-domain dependent) — Phase 2.6.
- MegaETH fork-deploy — Phase 3.
- Treasury tier (T2 self-serve) — Phase 3.5.
- API tier (T3 self-serve) — Phase 4.

## Sources

- [Greg spec](../specs/2026-05-02-greg-design.md) and [Phase-1.5 amendment](../specs/2026-05-03-greg-design-amendment.md)
- [Phase 2 validation](../phase-2-validation.md)
- [Phase 2 plan](2026-05-03-greg-phase-2-retail-substrate.md)
- [CoW Protocol Partner Fee documentation](https://docs.cow.fi/governance/fees/partner-fee) — recipient + 75% net + weekly WETH disbursement
- [`safe-global/safe-apps-list`](https://github.com/safe-global/safe-apps-list) — Safe-app submission PR target
- [How to build a Safe App and get it listed (Safe help center)](https://help.safe.global/en/articles/145503-how-to-build-a-safe-app-and-get-it-listed-in-safe-wallet)
- [Vercel API: project domains](https://vercel.com/docs/rest-api/endpoints/projects#add-a-domain-to-a-project)
- [Safe Wallet — Create Safe](https://app.safe.global) — operator-driven multisig deployment
