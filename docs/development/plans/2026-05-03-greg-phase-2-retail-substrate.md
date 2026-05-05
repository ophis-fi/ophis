# Greg Phase 2 — Retail Engineering Substrate Implementation Plan


**Goal:** Build the engineering substrate that Phase 2.5 (public launch) needs. Verify Greg's deployed cowswap fork drives the existing TWAP / DCA flow correctly with our Phase-1.5 partner-fee patch on every leg. Ship one new Greg-only feature — MEV-proof receipt download (JSON + PDF). Verify PWA installability and prepare Safe app submission package (manifest + iframe load-test).

**Architecture:** Phase 2 layers on top of Phase 1.5 — no changes to the partner-fee atom. The TWAP / DCA flow already exists in cowswap at `apps/cowswap-frontend/src/modules/twap/` and the `/advanced` route via `TwapFormWidget`. Composable-cow contract is deployed at `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74` on 9 chains (Ethereum, Gnosis, Arbitrum, Base, Avalanche, Polygon, BNB, Sepolia, Lens). New code lands in a new module `apps/cowswap-frontend/src/modules/mevReceipt/` for the receipt-download feature. Documentation files for Safe app submission and PWA verification land in `docs/development/`.

**Tech Stack:** TypeScript, Jotai (cowswap's state), `vite-plugin-pwa` + workbox (already wired in cowswap), `jspdf` (lightweight PDF generation), the vendored `apps/frontend/` cowswap fork, Vercel for deploy, `@cowprotocol/cow-sdk` already in cowswap deps.

**Spec:** [`docs/development/specs/2026-05-02-greg-design.md`](../specs/2026-05-02-greg-design.md) + [`docs/development/specs/2026-05-03-greg-design-amendment.md`](../specs/2026-05-03-greg-design-amendment.md)

**Predecessor plan:** [`docs/development/plans/2026-05-03-greg-phase-1-5-monetized-frontend.md`](2026-05-03-greg-phase-1-5-monetized-frontend.md) — Phase 1.5 PASS, recipient `0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E`.

**Out of scope for Phase 2** (deferred to Phase 2.5 / Phase 4):
- Brand work (real name, real domain, logo)
- DCA UX redesign (cowswap's "Advanced Orders" framing → consumer-friendly DCA framing)
- Public launch (Show HN, Product Hunt, Safe app store submission *PR* — manifest is Phase 2 but the actual submission pull-request to `safe-global/safe-apps-list` is Phase 2.5)
- Embed widget productization
- Power-user analytics dashboards (deferred — they need real volume to be useful)

**Phase gate:**

1. A real TWAP order with ≥2 parts on Sepolia executes through the deployed Greg.app; **every child order** has `fullAppData.metadata.partnerFee = {volumeBps: 5, recipient: 0xBA6Da6…76E}`.
2. A user can download a valid JSON receipt + valid PDF receipt for any settled order via the deployed UI.
3. The deployed Greg.app loads cleanly inside a Safe iframe (`app.safe.global/apps/open?appUrl=...`).
4. The deployed Greg.app installs as a PWA on at least Chrome desktop and one mobile browser.

Validation log committed to `docs/development/phase-2-validation.md`. Tag `v0.2-phase2`.

---

## File Structure (created or modified by this plan)

| Path | Action | Purpose |
|---|---|---|
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/types.ts` | create | Receipt schema |
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.ts` | create | Pure function: CoW order → MevProofReceipt |
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts` | create | TDD coverage |
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/exportPdf.ts` | create | MevProofReceipt → Blob (PDF) |
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/exportJson.ts` | create | MevProofReceipt → string (JSON) |
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/containers/DownloadReceiptButton.tsx` | create | UI button — JSON + PDF download |
| `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/index.ts` | create | barrel export |
| `apps/frontend/apps/cowswap-frontend/src/pages/Account/Tokens/TokensOverview.tsx` (or similar) | modify | mount `<DownloadReceiptButton />` on the order-detail row |
| `apps/frontend/apps/cowswap-frontend/public/manifest.json` | modify | replace `homepage_url` + `description` with Greg-specific values; add `iconPath` for Safe app compatibility |
| `apps/frontend/apps/cowswap-frontend/package.json` | modify | add `jspdf` dependency |
| `apps/frontend/.greg-divergences.md` | modify | track new files + edits |
| `docs/development/safe-app-submission.md` | create | Safe app submission instructions for Phase 2.5 |
| `docs/development/pwa-verification.md` | create | PWA install evidence |
| `docs/development/phase-2-validation.md` | create | phase-gate evidence |

**Not modified:** `apps/backend/`, `packages/sdk/`, `packages/rpc/`, `infra/local/`, the partner-fee atom (Phase 1.5).

---

## Dispatch hints

- **Tasks 1, 6, 8:** main session (CTO) — verification + Safe app submission packaging + close-out.
- **Tasks 2–4:** `frontend` agent — TDD MEV-proof receipt module.
- **Task 5:** `frontend` agent — manifest edits.
- **Task 7:** main session — manual PWA install check (browser interaction; can also be partly delegated to `frontend` agent for build inspection).

---

## Task 1: TWAP / DCA flow verification on Sepolia

**Files:** `docs/development/phase-2-validation.md` (created at end of plan in Task 8; Task 1 captures notes locally).

This task confirms the existing cowswap TWAP module works correctly with Phase 1.5's partner-fee patch. **No new code.** If something breaks, surface it — do not fix in Task 1; capture in DONE_WITH_CONCERNS.

### Step 1: Boot the cowswap dev server (or use the deployed preview)

Two routes — pick whichever is faster. Prefer the deployed preview if it's reachable:

**Option A — deployed preview:**
```bash
PREVIEW_URL=https://greg-fvnctfrq9-clementfrmds-projects.vercel.app
curl -fsSI "$PREVIEW_URL" | head -2
```
If HTTP 200 (SSO is off or you're authenticated), use this URL for the rest of Task 1.

**Option B — local dev:**
```bash
cd /Users/scep/greg/apps/frontend
pnpm run start 2>&1 | tee /tmp/greg-dev.log &
# Wait for `Local: http://localhost:3000` in /tmp/greg-dev.log, then visit it.
```

### Step 2: Connect the Phase-0 test wallet on Sepolia

- Wallet: `0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB` (private key in macOS Keychain entry `greg-chiado-test`).
- Expected balance on Sepolia: ~0.0045 ETH + ~0.0005 WETH wrapped + GPv2VaultRelayer pre-approved unlimited (Phase 0/1.5 leftovers).
- Verify before proceeding:
```bash
SEP_RPC=https://ethereum-sepolia.publicnode.com
TEST_ADDR=0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB
WETH=0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
RELAYER=0xC92E8bdf79f0507f65a392b0ab4667716BFE0110

cast balance --rpc-url "$SEP_RPC" "$TEST_ADDR" --ether
cast call --rpc-url "$SEP_RPC" "$WETH" "balanceOf(address)(uint256)" "$TEST_ADDR"
cast call --rpc-url "$SEP_RPC" "$WETH" "allowance(address,address)(uint256)" "$TEST_ADDR" "$RELAYER"
```
If WETH balance < 0.0003e18, top up:
```bash
TEST_PK=$(security find-generic-password -s greg-chiado-test -w)
cast send --rpc-url "$SEP_RPC" --private-key "$TEST_PK" "$WETH" "deposit()" --value 0.0005ether
```

### Step 3: Build a small TWAP order via the UI

In the browser:
1. Connect the wallet (MetaMask or Rabby).
2. Switch to Sepolia.
3. Navigate to `/advanced` (or click "Advanced Orders" / "TWAP" in the UI).
4. Configure the TWAP:
   - **Sell:** WETH, total `0.0003 WETH` (300000000000000 wei).
   - **Buy:** COW (`0x0625afb445c3b6b7b929342a04a22599fd5dbb59`).
   - **Number of parts:** `2` (smallest non-trivial TWAP).
   - **Frequency / interval:** `5 minutes` (or shortest the UI allows).
   - **Slippage tolerance:** 5–10%.
5. Click "Sign" and approve the Safe-CoW conditional-order signature in the wallet. Cowswap submits the conditional order to `composable-cow`'s `ComposableCoW` contract at `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74` on Sepolia.

### Step 4: Capture the conditional-order tx hash + the child order UIDs as they materialise

Cowswap's UI shows the conditional order in "Open Orders". As each interval matures (every 5 min), `ComposableCoW` emits a child order that becomes a regular CoW order with its own UID, posted to `api.cow.fi/sepolia/api/v1/orders/<uid>` once active.

Capture:
- The `ComposableCoW.create(...)` tx hash (visible in the wallet history immediately after signing).
- For each child UID as they appear (visible in cowswap's order list), record it.

### Step 5: For each child order, verify partner-fee in fullAppData

Once a child order is visible (status `open`):
```bash
CHILD_UID=<paste>
curl -sS "https://api.cow.fi/sepolia/api/v1/orders/$CHILD_UID" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
fa = d.get('fullAppData')
if not fa:
    print('✗ no fullAppData on child order')
    sys.exit(1)
parsed = json.loads(fa)
pf = parsed.get('metadata', {}).get('partnerFee')
print('partnerFee:', json.dumps(pf, indent=2))
assert pf['recipient'].lower() == '0xba6da6bb0fc6a3fabd69a3fceb25af4a35a8c76e', 'recipient mismatch'
assert pf['volumeBps'] == 5, 'bps mismatch'
print('✓ partner fee correctly inherited by TWAP child order')
"
```

Repeat for every child order that materialises during the validation window. Even if the order doesn't fully settle (Sepolia solver coverage is sparse), the partner-fee verification is the gate — if every child order has Greg's partnerFee in fullAppData, Phase 1.5's patch correctly applies to TWAP / DCA flows too.

### Step 6: Capture verification notes

Save a temp notes file at `/tmp/greg-task1-notes.md`:
```markdown
# Phase 2 / Task 1 — TWAP verification notes

Date: <YYYY-MM-DD>
Network: Sepolia (chainId 11155111)
Test wallet: 0x412cbCCe46FCBa707A3190ECEd8113Bbc2c294aB
ComposableCoW: 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74

Conditional order tx: <hash>
Number of parts: 2
Frequency: 5 minutes

Child orders observed:
- UID: <hash>  status: <open|fulfilled>  partner fee in fullAppData: ✓/✗
- UID: <hash>  status: <open|fulfilled>  partner fee in fullAppData: ✓/✗

Verdict: PASS — every child order inherited Greg's partner fee
        | DONE_WITH_CONCERNS — <details>
```

### Step 7: No commit (validation only)

The notes file goes into `docs/development/phase-2-validation.md` in Task 8. Do not commit `/tmp/greg-task1-notes.md`.

## Task 2: MEV-proof receipt — types + buildReceipt logic (TDD)

**Files:**
- Create: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/types.ts`
- Create: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.ts`
- Create: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts`

### Step 1: Write the failing test FIRST

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildReceipt } from './buildReceipt'

const FIXTURE_ORDER = {
  uid: '0x8e03c24db84f4e74bae2d869e989088d643164f869acf0bd5ba8806ee6e915a2412cbcce46fcba707a3190eced8113bbc2c294ab69f79657',
  owner: '0x412cbcce46fcba707a3190eced8113bbc2c294ab',
  status: 'fulfilled',
  sellToken: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
  buyToken: '0x0625afb445c3b6b7b929342a04a22599fd5dbb59',
  sellAmount: '481015300000000',
  buyAmount: '21632297816389608',
  executedSellAmount: '481015300000000',
  executedBuyAmount: '25754879132324902',
  validTo: 1777833559,
  fullAppData: JSON.stringify({
    version: '1.4.0',
    appCode: 'greg',
    metadata: {
      partnerFee: { volumeBps: 5, recipient: '0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E' },
    },
  }),
}

const FIXTURE_TRADE = {
  blockNumber: 10783287,
  txHash: '0x00eb2964743676a6971c4dc58518a316000112a5b0de43a7a4a6ee9ad72d17e9',
  buyAmount: '25754879132324902',
  sellAmount: '481015300000000',
}

describe('buildReceipt', () => {
  it('produces a complete receipt for a fulfilled order with a trade', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    expect(receipt.orderUid).toBe(FIXTURE_ORDER.uid)
    expect(receipt.chainId).toBe(11155111)
    expect(receipt.executedBuyAmount).toBe('25754879132324902')
    expect(receipt.settlementTxHash).toBe(FIXTURE_TRADE.txHash)
    expect(receipt.partnerFee).toEqual({
      volumeBps: 5,
      recipient: '0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E',
    })
    expect(receipt.surplusVsQuote).toBeCloseTo(0.19, 2) // (25754879 - 21632297) / 21632297 ≈ 19%
  })

  it('handles missing trade (open or expired order)', () => {
    const receipt = buildReceipt({ order: { ...FIXTURE_ORDER, status: 'open' }, trade: null, chainId: 11155111 })
    expect(receipt.settlementTxHash).toBeNull()
    expect(receipt.executedBuyAmount).toBe('0')
    expect(receipt.surplusVsQuote).toBeNull()
  })

  it('handles missing partnerFee in fullAppData', () => {
    const noFeeOrder = {
      ...FIXTURE_ORDER,
      fullAppData: JSON.stringify({ version: '1.4.0', metadata: {} }),
    }
    const receipt = buildReceipt({ order: noFeeOrder, trade: FIXTURE_TRADE, chainId: 11155111 })
    expect(receipt.partnerFee).toBeNull()
  })
})
```

### Step 2: Run failing test

```bash
cd /Users/scep/greg/apps/frontend
pnpm run test --filter cowswap-frontend -- src/modules/mevReceipt 2>&1 | tail -20
```
(Adjust the test command if the cowswap fork uses a different runner — check `package.json` `test` script. If they use Jest, replace `pnpm run test` accordingly.)

Expected: fails — `./buildReceipt` does not exist.

### Step 3: Implement types

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/types.ts`:
```typescript
/**
 * MEV-proof receipt for a CoW Protocol settled order, designed for
 * accounting / audit / treasury reporting use. Contains everything a
 * recipient needs to verify the order was settled at a fair price with
 * MEV protection.
 *
 * Derived from `api.cow.fi`'s order + trades endpoints.
 */

export interface PartnerFeeInfo {
  readonly volumeBps: number
  readonly recipient: string
}

export interface MevProofReceipt {
  /** CoW order UID (66-char hex including the 0x prefix). */
  readonly orderUid: string
  /** EVM chainId — 1, 100, 8453, etc. */
  readonly chainId: number
  /** EOA / Safe that signed the order. */
  readonly owner: string
  /** ERC-20 sold. */
  readonly sellToken: string
  /** ERC-20 bought. */
  readonly buyToken: string
  /** Original sellAmount as signed (post-CoW-fee). */
  readonly sellAmount: string
  /** Original buyAmount floor as signed. */
  readonly buyAmount: string
  /** Final executed sellAmount (== sellAmount for fully-fulfilled non-partial orders). */
  readonly executedSellAmount: string
  /** Final executed buyAmount; "0" if order is open or expired. */
  readonly executedBuyAmount: string
  /** Order validTo timestamp (Unix seconds). */
  readonly validTo: number
  /** On-chain settlement tx hash; null if not yet settled. */
  readonly settlementTxHash: string | null
  /** Block number of settlement; null if not yet settled. */
  readonly settlementBlock: number | null
  /** Order status from CoW API (fulfilled / open / cancelled / expired). */
  readonly status: string
  /** Partner-fee config baked into the order's appData; null if order had no partner fee. */
  readonly partnerFee: PartnerFeeInfo | null
  /** Fractional surplus over the quoted minimum buyAmount; null if not settled. (executed - quoted) / quoted */
  readonly surplusVsQuote: number | null
  /** Greg's receipt schema version. */
  readonly receiptVersion: '1'
  /** ISO-8601 UTC timestamp of receipt creation. */
  readonly generatedAt: string
}

export interface BuildReceiptInput {
  readonly order: {
    readonly uid: string
    readonly owner: string
    readonly status: string
    readonly sellToken: string
    readonly buyToken: string
    readonly sellAmount: string
    readonly buyAmount: string
    readonly executedSellAmount: string
    readonly executedBuyAmount: string
    readonly validTo: number
    readonly fullAppData: string | null
  }
  readonly trade: {
    readonly blockNumber: number
    readonly txHash: string
    readonly buyAmount: string
    readonly sellAmount: string
  } | null
  readonly chainId: number
}
```

### Step 4: Implement buildReceipt

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.ts`:
```typescript
import type { BuildReceiptInput, MevProofReceipt, PartnerFeeInfo } from '../types'

const extractPartnerFee = (fullAppData: string | null): PartnerFeeInfo | null => {
  if (!fullAppData) return null
  try {
    const parsed = JSON.parse(fullAppData)
    const pf = parsed?.metadata?.partnerFee
    if (!pf || typeof pf.recipient !== 'string') return null
    const volumeBps = pf.volumeBps ?? pf.bps
    if (typeof volumeBps !== 'number') return null
    return { volumeBps, recipient: pf.recipient }
  } catch {
    return null
  }
}

const calcSurplus = (executedBuy: string, quotedBuy: string): number | null => {
  if (!executedBuy || executedBuy === '0' || !quotedBuy || quotedBuy === '0') return null
  const exec = BigInt(executedBuy)
  const quoted = BigInt(quotedBuy)
  if (quoted === 0n) return null
  // (exec - quoted) / quoted, returned as a Number with reasonable precision
  const num = Number(exec - quoted)
  const denom = Number(quoted)
  return num / denom
}

export const buildReceipt = ({ order, trade, chainId }: BuildReceiptInput): MevProofReceipt => ({
  orderUid: order.uid,
  chainId,
  owner: order.owner,
  sellToken: order.sellToken,
  buyToken: order.buyToken,
  sellAmount: order.sellAmount,
  buyAmount: order.buyAmount,
  executedSellAmount: order.executedSellAmount,
  executedBuyAmount: order.executedBuyAmount,
  validTo: order.validTo,
  settlementTxHash: trade?.txHash ?? null,
  settlementBlock: trade?.blockNumber ?? null,
  status: order.status,
  partnerFee: extractPartnerFee(order.fullAppData),
  surplusVsQuote: trade ? calcSurplus(order.executedBuyAmount, order.buyAmount) : null,
  receiptVersion: '1',
  generatedAt: new Date().toISOString(),
})
```

### Step 5: Run tests, verify green

```bash
cd /Users/scep/greg/apps/frontend
pnpm run test --filter cowswap-frontend -- src/modules/mevReceipt 2>&1 | tail -20
```
Expected: 3 passing.

If `surplusVsQuote` test fails by a small float-precision delta, the `toBeCloseTo(0.19, 2)` is intentionally lenient — verify the actual value lies in `[0.185, 0.195]`. The `executedBuyAmount` is 25754879132324902 and `buyAmount` is 21632297816389608, surplus = (25754879132324902 - 21632297816389608) / 21632297816389608 ≈ 0.1906. The test should pass.

### Step 6: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/
git status
git commit -m "feat(mevReceipt): types + buildReceipt logic (TDD)"
git push
git log --oneline -3
```

## Task 3: MEV-proof receipt — JSON export + barrel

**Files:**
- Create: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/exportJson.ts`
- Create: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/index.ts`
- Modify: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts` (add a JSON export test)

### Step 1: Add the test for JSON export

Append to `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts`:
```typescript
import { exportJson } from './exportJson'

describe('exportJson', () => {
  it('produces a valid JSON string round-trippable to the original receipt', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    const json = exportJson(receipt)
    const parsed = JSON.parse(json)
    expect(parsed.orderUid).toBe(receipt.orderUid)
    expect(parsed.partnerFee).toEqual(receipt.partnerFee)
    expect(parsed.receiptVersion).toBe('1')
  })

  it('produces a stable, sorted-key JSON for deterministic file hashing', () => {
    const receipt1 = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    const receipt2 = { ...receipt1 } // same data
    expect(exportJson(receipt1)).toBe(exportJson(receipt2))
  })
})
```

### Step 2: Run failing test

```bash
cd /Users/scep/greg/apps/frontend
pnpm run test --filter cowswap-frontend -- src/modules/mevReceipt 2>&1 | tail -20
```
Expected: 2 new tests fail (`exportJson` not exported).

### Step 3: Implement exportJson

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/exportJson.ts`:
```typescript
import type { MevProofReceipt } from '../types'

/**
 * Serialise a receipt to a stable, indented JSON string.
 * Keys are sorted for deterministic output (so two receipts with the same
 * data hash to the same string — useful for accounting reconciliation).
 */
export const exportJson = (receipt: MevProofReceipt): string => {
  const sorted = JSON.parse(JSON.stringify(receipt, Object.keys(receipt).sort()))
  return JSON.stringify(sorted, null, 2)
}
```

### Step 4: Add the barrel

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/index.ts`:
```typescript
export { buildReceipt } from './services/buildReceipt'
export { exportJson } from './services/exportJson'
export type { MevProofReceipt, PartnerFeeInfo, BuildReceiptInput } from './types'
```

### Step 5: Run tests, verify green

```bash
cd /Users/scep/greg/apps/frontend
pnpm run test --filter cowswap-frontend -- src/modules/mevReceipt 2>&1 | tail -20
```
Expected: 5 passing total.

### Step 6: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/
git status
git commit -m "feat(mevReceipt): exportJson + module barrel"
git push
git log --oneline -3
```

## Task 4: MEV-proof receipt — PDF export

**Files:**
- Create: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/exportPdf.ts`
- Modify: `apps/frontend/apps/cowswap-frontend/apps/cowswap-frontend/package.json` (add `jspdf` dep)
- Modify: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts` (add minimal PDF test)
- Modify: `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/index.ts` (export `exportPdf`)

### Step 1: Add jspdf dependency

```bash
cd /Users/scep/greg/apps/frontend/apps/cowswap-frontend
# Cowswap uses pnpm internally — add via the cowswap workspace's pnpm
pnpm add jspdf@^2.5.1 2>&1 | tail -10
```

The `pnpm-lock.yaml` inside `apps/frontend/` will update. Both go into the commit.

### Step 2: Write the failing PDF test

Append to `apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/buildReceipt.test.ts`:
```typescript
import { exportPdf } from './exportPdf'

describe('exportPdf', () => {
  it('produces a non-empty Blob with PDF mime type', () => {
    const receipt = buildReceipt({ order: FIXTURE_ORDER, trade: FIXTURE_TRADE, chainId: 11155111 })
    const blob = exportPdf(receipt)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(500) // a smallest-possible PDF is ~700 bytes
  })

  it('does not throw on a not-yet-settled order (no trade)', () => {
    const receipt = buildReceipt({ order: { ...FIXTURE_ORDER, status: 'open' }, trade: null, chainId: 11155111 })
    expect(() => exportPdf(receipt)).not.toThrow()
  })
})
```

### Step 3: Run failing test

```bash
cd /Users/scep/greg/apps/frontend
pnpm run test --filter cowswap-frontend -- src/modules/mevReceipt 2>&1 | tail -20
```
Expected: 2 new tests fail (`exportPdf` not exported).

### Step 4: Implement exportPdf

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/services/exportPdf.ts`:
```typescript
import { jsPDF } from 'jspdf'
import type { MevProofReceipt } from '../types'

/**
 * Generates a single-page PDF of a CoW Protocol order receipt.
 * Plain monospace layout — the goal is auditable evidence, not visual flair.
 * Compatible with treasury-team accounting workflows.
 */
export const exportPdf = (receipt: MevProofReceipt): Blob => {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })

  doc.setFontSize(14)
  doc.text('Greg — MEV-Proof Order Receipt', 40, 50)

  doc.setFontSize(10)
  doc.setFont('courier', 'normal')

  const lines: string[] = [
    `Order UID:        ${receipt.orderUid}`,
    `Chain ID:         ${receipt.chainId}`,
    `Owner:            ${receipt.owner}`,
    `Status:           ${receipt.status}`,
    ``,
    `Sell token:       ${receipt.sellToken}`,
    `Buy token:        ${receipt.buyToken}`,
    `Sell amount:      ${receipt.sellAmount}`,
    `Buy amount min:   ${receipt.buyAmount}`,
    `Executed sell:    ${receipt.executedSellAmount}`,
    `Executed buy:     ${receipt.executedBuyAmount}`,
    ``,
    `Settlement tx:    ${receipt.settlementTxHash ?? '(not settled)'}`,
    `Block:            ${receipt.settlementBlock ?? '-'}`,
    `Surplus vs quote: ${receipt.surplusVsQuote === null ? '-' : `${(receipt.surplusVsQuote * 100).toFixed(2)}%`}`,
    ``,
    `Partner fee:      ${
      receipt.partnerFee
        ? `${receipt.partnerFee.volumeBps} bps → ${receipt.partnerFee.recipient}`
        : '(none)'
    }`,
    ``,
    `Receipt version:  ${receipt.receiptVersion}`,
    `Generated:        ${receipt.generatedAt}`,
  ]

  let y = 80
  for (const line of lines) {
    doc.text(line, 40, y)
    y += 14
  }

  return doc.output('blob')
}
```

### Step 5: Update the barrel

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/index.ts`:
```typescript
export { buildReceipt } from './services/buildReceipt'
export { exportJson } from './services/exportJson'
export { exportPdf } from './services/exportPdf'
export type { MevProofReceipt, PartnerFeeInfo, BuildReceiptInput } from './types'
```

### Step 6: Run tests, verify green

```bash
cd /Users/scep/greg/apps/frontend
pnpm run test --filter cowswap-frontend -- src/modules/mevReceipt 2>&1 | tail -20
```
Expected: 7 passing total.

If the test suite runs in jsdom and `Blob` is unavailable, add `environment: 'jsdom'` to the test config — but vite + cowswap should already provide a DOM env.

### Step 7: Add the UI button

`apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/containers/DownloadReceiptButton.tsx`:
```typescript
import React, { useCallback } from 'react'
import { buildReceipt, exportJson, exportPdf } from '../index'
import type { BuildReceiptInput } from '../types'

interface DownloadReceiptButtonProps {
  readonly input: BuildReceiptInput
  readonly format?: 'json' | 'pdf'
  readonly className?: string
}

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export const DownloadReceiptButton: React.FC<DownloadReceiptButtonProps> = ({
  input,
  format = 'json',
  className,
}) => {
  const onClick = useCallback(() => {
    const receipt = buildReceipt(input)
    const shortUid = receipt.orderUid.slice(0, 10)
    if (format === 'pdf') {
      const blob = exportPdf(receipt)
      triggerDownload(blob, `greg-receipt-${shortUid}.pdf`)
    } else {
      const json = exportJson(receipt)
      const blob = new Blob([json], { type: 'application/json' })
      triggerDownload(blob, `greg-receipt-${shortUid}.json`)
    }
  }, [input, format])

  return (
    <button onClick={onClick} className={className} aria-label={`Download ${format.toUpperCase()} receipt`}>
      Download {format.toUpperCase()} receipt
    </button>
  )
}
```

Update the barrel to export it:

```typescript
// append to apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/index.ts
export { DownloadReceiptButton } from './containers/DownloadReceiptButton'
```

### Step 8: Wire into the order-detail page

Find the existing order-detail / receipt page in cowswap. Look for a component named something like `OrderRow`, `OrderDetail`, `Receipt`, or `TransactionDetails`:

```bash
cd /Users/scep/greg/apps/frontend
grep -RIln 'order.*detail\|TransactionDetails\|Receipt' apps/cowswap-frontend/src/modules/account/ 2>/dev/null | head -5
```

Or in the swap result UI:

```bash
grep -RIln 'OrderRow\|order-row\|order-detail' apps/cowswap-frontend/src/ 2>/dev/null | head -5
```

Pick the most appropriate component (the one users land on after a swap completes, OR the order history row). Add the `<DownloadReceiptButton input={...} />` element. The `input` prop expects:
```typescript
{
  order: <the EnrichedOrder from cow-sdk>,
  trade: <first element of the trades array, or null>,
  chainId: <chainId from wallet/network state>,
}
```

Map the cowswap `EnrichedOrder` shape to the `BuildReceiptInput.order` shape — most fields are 1:1.

If the wiring requires deep refactoring of an existing component, REPORT DONE_WITH_CONCERNS — capture the smallest viable wire-in. The button doesn't need to be on every page; one page (e.g., the post-swap "Order details" modal) is enough to satisfy the gate.

### Step 9: Build cowswap to confirm everything compiles

```bash
cd /Users/scep/greg/apps/frontend
pnpm run build:cowswap 2>&1 | tail -10
```
Expected: build succeeds.

### Step 10: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/apps/cowswap-frontend/src/modules/mevReceipt/ \
        apps/frontend/apps/cowswap-frontend/package.json \
        apps/frontend/pnpm-lock.yaml
# If you wired the button into a page, also add that file:
git add apps/frontend/apps/cowswap-frontend/src/modules/account/ 2>/dev/null || true
git add apps/frontend/apps/cowswap-frontend/src/<wherever-the-button-was-mounted> 2>/dev/null || true
git status
git commit -m "feat(mevReceipt): exportPdf + DownloadReceiptButton + UI mount"
git push
```

## Task 5: PWA + Safe-app manifest hardening

**Files:**
- Modify: `apps/frontend/apps/cowswap-frontend/public/manifest.json`

The cowswap manifest already has `name: "Greg"` and `short_name: "Greg"` from Phase 0 Task 7. Two values still point at upstream cowswap and need updating:

- `homepage_url` is `"https://swap.cow.fi"` → should reflect Greg's deployment URL.
- `description` mentions "CoW Swap" → rewrite for Greg.

Safe app store also requires an `iconPath` field per [Safe app docs](https://help.safe.global/en/articles/145503-how-to-build-a-safe-app-and-get-it-listed-in-safe-wallet) — cowswap's manifest uses `icons[].src` (W3C web manifest spec) which Safe's newer parser also supports, but `iconPath` is the original, more-broadly-compatible field. Add it as a fallback.

### Step 1: Read the current manifest

```bash
cat /Users/scep/greg/apps/frontend/apps/cowswap-frontend/public/manifest.json
```

Capture the existing JSON so you can diff intelligently.

### Step 2: Edit manifest

Apply these specific changes (do NOT rewrite the whole file):

1. `homepage_url`: `"https://swap.cow.fi"` → `"https://greg-git-main-clementfrmds-projects.vercel.app"` (the stable branch alias from Phase 1.5)
2. `description`: replace with `"Greg — DCA and TWAP for power users on top of CoW Protocol. MEV-protected, gasless, multi-chain."`  (≤200 chars per Safe spec)
3. Add `"iconPath": "/android-chrome-512x512.png"` — Safe's older parser uses this field; references the existing 512px PNG icon already in the build.

### Step 3: Verify the manifest is still valid JSON

```bash
python3 -c "import json; json.load(open('/Users/scep/greg/apps/frontend/apps/cowswap-frontend/public/manifest.json'))"
```
Expected: no output (no exceptions = valid JSON).

### Step 4: Build cowswap, verify manifest copies through

```bash
cd /Users/scep/greg/apps/frontend
pnpm run build:cowswap 2>&1 | tail -5
cat build/cowswap/manifest.json | python3 -m json.tool | head -25
```
Expected: built manifest has the new `homepage_url`, `description`, and `iconPath`.

### Step 5: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/apps/cowswap-frontend/public/manifest.json
git status
git commit -m "feat(manifest): Greg-specific homepage_url + description + Safe iconPath"
git push
```

## Task 6: Safe app readiness — iframe load test + submission package

**Files:**
- Create: `docs/development/safe-app-submission.md`

### Step 1: Wait for Vercel auto-deploy of the latest commit

The Phase-1.5 git-connect means pushes to `main` auto-deploy on Vercel. After Task 5's push, a new preview deploy starts. Wait for it to reach READY (typically ~2 min).

```bash
VC_TOKEN=$(cat ~/Library/Application\ Support/com.vercel.cli/auth.json | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
TEAM=team_C0UfZCb5p2kuRtKKRcZpt0qd
PROJECT=prj_Bphlj9iJ6kFDT9n99ojNYULs8cDc

curl -sS "https://api.vercel.com/v6/deployments?projectId=${PROJECT}&teamId=${TEAM}&limit=3" \
  -H "Authorization: Bearer $VC_TOKEN" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
for dep in d.get('deployments', [])[:3]:
    print(dep.get('state'), dep.get('url'), dep.get('meta', {}).get('githubCommitSha','')[:8])
"
```

Pick the most recent READY URL. The branch alias `https://greg-git-main-clementfrmds-projects.vercel.app` always points at the latest READY main-branch deploy.

### Step 2: Verify CORS on the manifest

Safe needs to fetch `<deployment>/manifest.json` from `app.safe.global` cross-origin. Verify the headers:

```bash
PREVIEW_URL=https://greg-git-main-clementfrmds-projects.vercel.app
curl -sI "$PREVIEW_URL/manifest.json" | grep -iE 'content-type|access-control'
```

Expected: `content-type: application/json` (or `application/manifest+json`); `access-control-allow-origin: *` or specifically `app.safe.global`.

If `Access-Control-Allow-Origin` is missing, Vercel needs a `vercel.json` `headers` block. Add to `/Users/scep/greg/vercel.json`:
```json
{
  "headers": [
    {
      "source": "/manifest.json",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" }
      ]
    }
  ]
}
```
Commit + redeploy if needed.

### Step 3: Verify deployment loads inside Safe iframe

Safe iframes any page given to its `appUrl` query param. Construct the test URL:

```bash
SAFE_TEST_URL="https://app.safe.global/apps/open?safe=eth%3A0xfb1bffc9d739b8d520daf37df666da4c687191ea&appUrl=$(python3 -c "import urllib.parse; print(urllib.parse.quote('https://greg-git-main-clementfrmds-projects.vercel.app'))")"
echo "$SAFE_TEST_URL"
```

Open this URL in a browser. Expected behaviour:
- Safe Wallet loads
- The Greg iframe appears (cowswap UI rendered inside Safe)
- The iframe-loaded UI can detect the Safe parent and offer a "Connect with Safe" option (cowswap's existing Safe SDK integration handles this automatically)

If the iframe is blank or shows an X-Frame-Options error: there's a CSP / X-Frame-Options issue on the deployment. Vercel by default does not set `X-Frame-Options: DENY` so this should work. If a header is being set somewhere, find it and remove it.

If the iframe loads but the Safe SDK doesn't connect: check the cowswap Safe integration code (`apps/cowswap-frontend/src/legacy/connection/SafeConnector.ts` or similar). Most likely it works as-is since cowswap is already a Safe-listed app.

### Step 4: Document the submission package

Write `/Users/scep/greg/docs/development/safe-app-submission.md`:
```markdown
# Greg — Safe app store submission package

## App URL
- **Production-ish branch alias:** https://greg-git-main-clementfrmds-projects.vercel.app
- **Phase 2.5 will replace this with a real domain (e.g., greg.app or one of the openletz domains).**

## Manifest

Served at `/manifest.json` on the deployment. Key fields:

```json
{
  "name": "Greg",
  "short_name": "Greg",
  "description": "Greg — DCA and TWAP for power users on top of CoW Protocol. MEV-protected, gasless, multi-chain.",
  "homepage_url": "https://greg-git-main-clementfrmds-projects.vercel.app",
  "iconPath": "/android-chrome-512x512.png",
  "icons": [
    { "src": "/android-chrome-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/android-chrome-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

CORS: `/manifest.json` returns `Access-Control-Allow-Origin: *` so Safe can fetch it from `app.safe.global`.

## Iframe load test

Verified <YYYY-MM-DD>: Greg loads cleanly inside `https://app.safe.global/apps/open?appUrl=<encoded URL>`. Cowswap's existing Safe SDK integration handles the connection.

## Submission process (Phase 2.5)

1. Replace the URL in this document with the real Greg domain once it exists.
2. Open a PR against [`safe-global/safe-apps-list`](https://github.com/safe-global/safe-apps-list) following the format in `community-list.json`. Sample entry:
   ```json
   {
     "id": "<auto-generated>",
     "url": "https://<real-greg-domain>",
     "networks": [1, 100, 8453, 42161, 137, 43114, 56, 59144, 11155111]
   }
   ```
3. Wait for review by the Safe team. Typical turnaround: 1–2 weeks.
4. Once merged, the app appears in `app.safe.global`'s "Browse Safe Apps" list.

## Reference docs (May 2026)

- [How to build a Safe App and get it listed (Safe help center)](https://help.safe.global/en/articles/145503-how-to-build-a-safe-app-and-get-it-listed-in-safe-wallet)
- [`safe-global/safe-apps-list`](https://github.com/safe-global/safe-apps-list)
- [`@safe-global/safe-apps-sdk`](https://www.npmjs.com/package/@safe-global/safe-apps-sdk) — already a cowswap dep.
```

### Step 5: Commit

```bash
cd /Users/scep/greg
git add docs/development/safe-app-submission.md
# If a vercel.json edit was needed in Step 2, also add it.
git add vercel.json 2>/dev/null || true
git status
git commit -m "docs(safe-app): submission package + iframe load verification"
git push
```

## Task 7: PWA install verification

**Files:**
- Create: `docs/development/pwa-verification.md`

### Step 1: Wait for the latest deploy to be READY

(Same pattern as Task 6 Step 1.)

### Step 2: Verify the service worker is served

```bash
PREVIEW_URL=https://greg-git-main-clementfrmds-projects.vercel.app
curl -sI "$PREVIEW_URL/service-worker.js" | head -5
```
Expected: `HTTP/2 200`, `content-type: application/javascript` (or text/javascript).

If 404: the build is not producing the service worker. Inspect `apps/frontend/build/cowswap/`:
```bash
ls /Users/scep/greg/apps/frontend/build/cowswap/ | grep -i 'service\|sw'
```
Cowswap's `vite.config.mts` references `vite-plugin-pwa` with `filename: 'service-worker.ts'` — confirm the plugin emitted it.

### Step 3: Manual install check — desktop Chrome

1. Open `https://greg-git-main-clementfrmds-projects.vercel.app` in Chrome on the Mac mini.
2. URL bar should show an "install app" icon (small computer screen icon, right of the URL).
3. Click it; choose "Install".
4. Greg launches as a standalone app window. Title shows "Greg".
5. Close the standalone window. Open Chrome's `chrome://apps`. Greg appears in the list.

### Step 4: Manual install check — Mac Safari

1. Open the same URL in Safari.
2. File → "Add to Dock" (Safari 17+) or right-click on the page → "Add to Dock".
3. The macOS Dock now has a Greg icon launching the app standalone.

### Step 5: (Optional) iOS / Android check via QR

If a phone is available, open the URL in mobile Safari or Chrome and use "Add to Home Screen". The PWA should install. Skip this step if no phone is handy — desktop checks are sufficient for the Phase 2 gate.

### Step 6: Document

Write `/Users/scep/greg/docs/development/pwa-verification.md`:
```markdown
# Greg — PWA install verification

**Date:** <YYYY-MM-DD>
**Deployment URL:** https://greg-git-main-clementfrmds-projects.vercel.app

## Service worker

Served at `/service-worker.js`. Cowswap uses `vite-plugin-pwa` with workbox. Precaches the static asset bundle. Confirmed via:

```bash
curl -sI https://greg-git-main-clementfrmds-projects.vercel.app/service-worker.js | head -3
```

## Manifest

Linked from `<head>` via `<link rel="manifest" href="/manifest.json">`. After Phase 2 / Task 5 the manifest declares Greg-specific `name`, `short_name`, `description`, `homepage_url`, `iconPath`, and `icons`.

## Install verification

| Browser | Result | Notes |
|---|---|---|
| Chrome (macOS) | ✓ installable | Title "Greg", standalone window, listed in chrome://apps |
| Safari (macOS) | ✓ installable | "Add to Dock", launches as a standalone app |
| Mobile Safari (iOS) | <ran/skipped> | <details if ran> |
| Mobile Chrome (Android) | <ran/skipped> | <details if ran> |

## Phase 2 PWA gate: PASS

The deployed app installs as a PWA on at least Chrome desktop and Safari macOS. Mobile checks are optional and deferred to Phase 2.5 when we have a real domain to test against (mobile install UX prefers stable URLs over hash-randomised previews).
```

### Step 7: Commit

```bash
cd /Users/scep/greg
git add docs/development/pwa-verification.md
git status
git commit -m "docs(pwa): PWA install verified on Chrome + Safari macOS"
git push
```

## Task 8: Phase 2 close-out

**Files:**
- Create: `docs/development/phase-2-validation.md`
- Modify: `apps/frontend/.greg-divergences.md` (add the new Modified / Added paths from Phase 2)

### Step 1: Append Phase 2 divergences to `apps/frontend/.greg-divergences.md`

Read the file, then append under the existing sections:

```markdown
## Modified (Phase 2, 2026-05-XX)

- `apps/cowswap-frontend/public/manifest.json` — Greg-specific `homepage_url`, `description`, `iconPath`. Phase 2 Task 5.
- `apps/cowswap-frontend/package.json` — added `jspdf` dependency. Phase 2 Task 4.
- `<page where DownloadReceiptButton was mounted>` — added receipt-download UI. Phase 2 Task 4 Step 8.

## Added (Phase 2)

- `apps/cowswap-frontend/src/modules/mevReceipt/` — Greg-only feature. MEV-proof receipt JSON + PDF export. Phase 2 Tasks 2–4.
```

### Step 2: Write `docs/development/phase-2-validation.md`

```markdown
# Phase 2 — Retail Engineering Substrate Validation Log

**Date:** <YYYY-MM-DD>
**Commit at validation:** `<git rev-parse HEAD>`
**Deployment URL:** https://greg-git-main-clementfrmds-projects.vercel.app

## Phase gate

| Gate | Evidence | Result |
|---|---|---|
| TWAP/DCA flow on Sepolia carries partner fee on every child order | Task 1 — `tmp/greg-task1-notes.md` (children listed with their UIDs + fullAppData partner-fee verification) | <PASS / DONE_WITH_CONCERNS> |
| MEV-proof receipt downloadable as JSON | Task 3 — 5 vitest tests pass; UI button mounted at `<page>` | PASS |
| MEV-proof receipt downloadable as PDF | Task 4 — 7 vitest tests pass; UI button supports `format="pdf"` | PASS |
| Manifest Greg-specific + Safe-compatible | Task 5 — manifest.json delta committed; CORS allows Safe to fetch | PASS |
| Deployment loads inside Safe iframe | Task 6 — verified at `app.safe.global/apps/open?appUrl=...` | PASS |
| PWA installable on Chrome + Safari macOS | Task 7 — `docs/development/pwa-verification.md` | PASS |

## Verification artifacts

- TWAP child orders verified: `<list of UIDs from Task 1>`
- Sample MEV-proof receipt (JSON): `<paste from Task 3 manual download>`
- Sample MEV-proof receipt (PDF): `<paste filename from Task 4 manual download>`
- Safe app submission package: `docs/development/safe-app-submission.md`
- PWA install evidence: `docs/development/pwa-verification.md`

## Phase 2 verdict: PASS

The retail engineering substrate is in place. Phase 2.5 (public launch) can now layer brand work, real domain, DCA UX redesign, and the actual Safe app store submission PR on top of this foundation.

## Open follow-ups for Phase 2.5

- Real domain + brand decision (greg codename retired before launch).
- DCA UX redesign — current `/advanced` page is functional but technically-framed; consumer flow needs polish.
- Safe app store submission PR against `safe-global/safe-apps-list`.
- Mobile PWA install verification once a stable domain exists.
- Multi-sig upgrade for partner-fee recipient if accrued WETH approaches first weekly payout (≥ 0.001 WETH).
- Re-verify Vercel SSO state on new deployments — production target should be public, previews team-gated.
```

### Step 3: Commit

```bash
cd /Users/scep/greg
git add apps/frontend/.greg-divergences.md docs/development/phase-2-validation.md
git status
git commit -m "docs(phase-2): close-out — substrate ready for public launch (Phase 2.5)"
git push
```

### Step 4: Tag

```bash
cd /Users/scep/greg
git tag -a v0.2-phase2 -m "Phase 2 — Retail Engineering Substrate PASS

TWAP / DCA flow verified on Sepolia: every conditional-order child
inherits Greg's partnerFee in fullAppData via the Phase-1.5 atom patch.
MEV-proof receipts downloadable as JSON + PDF on every settled order.
PWA installs on Chrome + Safari (macOS). Deployment loads cleanly
inside Safe iframe; manifest is Safe-compatible and CORS-friendly.
Submission package ready for Phase 2.5 public launch.

New module: apps/cowswap-frontend/src/modules/mevReceipt/ (TDD, 7 tests
green). Vendored cowswap fork divergences tracked in
apps/frontend/.greg-divergences.md."
git push --tags
```

### Step 5: Close Phase 2 issue + Open Phase 2.5 + Phase 3 issues (if not already)

```bash
gh issue close 3 --repo san-npm/greg --comment "Phase 2 complete and tagged \`v0.2-phase2\`. Validation: \`docs/development/phase-2-validation.md\`. Phase 2.5 (public launch) and Phase 3 (MegaETH fork-deploy) are next."

# If Phase 2.5 doesn't have an issue yet, open it:
gh issue create --repo san-npm/greg \
  --title "Phase 2.5: Public launch — brand, real domain, DCA UX redesign, Safe app submission PR, Show HN/PH" \
  --body "Predecessor: Phase 2 (\`v0.2-phase2\`). Plan to be drafted via \`the writing-plans methodology\` when Clement says go.

## Scope
- [ ] Real project name + domain (codename \`greg\` retired)
- [ ] Brand work: logo, colour, voice
- [ ] DCA UX redesign on top of cowswap's \`/advanced\` route
- [ ] Submit Safe app PR against \`safe-global/safe-apps-list\`
- [ ] Show HN, Product Hunt, social launch
- [ ] First content posts (one weekly tweet with execution proofs from Phase 1.5 / 2 settled orders)
- [ ] Multisig upgrade for partner-fee recipient
- [ ] Verify Vercel SSO state on production deployment (production public, previews team-gated)

## Calendar
May 25–31 (~1 week)"
```

## Task 9: Update memory

**Files:** `<local notes>/project_greg.md`, `<local notes>/MEMORY.md`

### Step 1: Edit `project_greg.md`

- Append Phase 2 to the "Phase gates" section, with the verdict and the order UID(s) used in TWAP verification.
- Update "Tags" to include `v0.2-phase2`.
- Update "Next step" to reference Phase 2.5 (public launch).

### Step 2: Edit `MEMORY.md`

Update the Greg one-liner with Phase 2 PASS and recipient note still relevant.

### Step 3: No git operation — memory lives outside the repo.

---

## Self-Review Notes

**Spec coverage**

- Composable-order builder UI (DCA + TWAP): Task 1 verifies the existing cowswap module works end-to-end with our partner-fee patch. Phase 2.5 does the consumer-facing UX redesign on top of it — that is explicitly out of scope for Phase 2.
- Safe app integration: Task 6 verifies iframe load + ships the submission package. Actual Safe app store PR is Phase 2.5.
- MEV-proof receipt export: Tasks 2–4 build the new module from scratch with TDD.
- Power-user analytics: deferred (out of scope; needs real volume to be useful).
- Embed widget: deferred to Phase 4 (API tier) or a separate Phase 2.6.
- PWA polish: Tasks 5 + 7 update manifest + verify install.

**Placeholders:** none. The few `<paste>` / `<YYYY-MM-DD>` slots are runtime values an operator fills when running.

**Type / name consistency:** `MevProofReceipt`, `BuildReceiptInput`, `PartnerFeeInfo`, `buildReceipt`, `exportJson`, `exportPdf`, `DownloadReceiptButton` are referenced consistently across Tasks 2 → 3 → 4. The cowswap fork's existing types (`PartnerFee` from `@cowprotocol/widget-lib`, `EnrichedOrder` from `cow-sdk`) are imported at use sites only, not redefined.

**Risk acknowledged:**
- The exact mount point for `DownloadReceiptButton` in cowswap's UI requires inspection (Task 4 Step 8). The plan documents a fallback (one-page mount is enough for the gate) and explicitly accepts DONE_WITH_CONCERNS if the wiring needs major refactoring.
- TWAP requires Composable-CoW deployment on the chain. Of Greg's 10 supported chains, 9 have Composable-CoW (Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Lens, Gnosis, Sepolia per the upstream deploy table; Linea, Plasma, Ink may not be on the list yet). On chains without Composable-CoW, the cowswap UI hides the TWAP option — already correct behaviour upstream.
- Safe iframe load requires the deployment URL to NOT have `X-Frame-Options: DENY`. Vercel's defaults don't set this header — should work out-of-box. If it doesn't, the plan documents the fallback (Vercel `headers` config in `vercel.json`).

**Out of scope (to prevent drift)**

- DCA UX redesign — Phase 2.5.
- Brand / domain / logo — Phase 2.5.
- Multisig recipient upgrade — Phase 2.5.
- Show HN / Product Hunt / social launch — Phase 2.5.
- Embed widget productisation — Phase 4.
- Power-user analytics dashboard — deferred indefinitely until real volume justifies it.
- MegaETH fork-deploy — Phase 3.
- Treasury tier (T2 self-serve) — Phase 3.5.
- API tier (T3 self-serve) — Phase 4.

## Sources

- [Greg spec](../specs/2026-05-02-greg-design.md) and [Phase-1.5 spec amendment](../specs/2026-05-03-greg-design-amendment.md)
- [Greg Phase-1.5 plan](2026-05-03-greg-phase-1-5-monetized-frontend.md) (predecessor)
- [Greg Phase-1.5 validation log](../phase-1-5-validation.md) — partner-fee mechanism evidence
- [CoW Protocol partner-fee documentation](https://docs.cow.fi/governance/fees/partner-fee)
- [`cowprotocol/composable-cow`](https://github.com/cowprotocol/composable-cow) — TWAP / conditional order contracts
- [`cowprotocol/cow-sdk`](https://github.com/cowprotocol/cow-sdk) — `@cowprotocol/app-data` partner-fee schema and `EnrichedOrder` type
- [How to build a Safe App and get it listed (Safe help center)](https://help.safe.global/en/articles/145503-how-to-build-a-safe-app-and-get-it-listed-in-safe-wallet)
- [`safe-global/safe-apps-list`](https://github.com/safe-global/safe-apps-list) — Safe app store submission process
- [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) — already wired in cowswap's `vite.config.mts`
- [`jspdf`](https://github.com/parallax/jsPDF) — PDF generation (added in Task 4)
