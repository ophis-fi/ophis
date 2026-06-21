# On-chain appData Swap Scan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `pnpm scan --since 48h` CLI in the rebate-indexer that lists every Ophis swap across chains by discovering fills on-chain (`getLogs(Trade)`) and attributing them via each order's appData — independent of the rebate wallet allowlist.

**Architecture:** Two data sources feed one normalized `Swap[]`: self-hosted chains (OP) read the local orderbook Postgres via `docker exec psql`; hosted majors (mainnet/Base/Arbitrum/Polygon/Avalanche) scan the Settlement contract's `Trade` event over the window, dedup orderUids, and resolve each via CoW's `getOrder` to filter `appCode ∈ {ophis, greg}`. Output goes to a terminal table, an out-of-repo JSON artifact, and an optional Telegram DM. It reuses the indexer's `cow/client.ts`, `pricer.ts`, `telegram/alerter.ts`, and `viem` — no new dependencies.

**Tech Stack:** TypeScript (ESM, NodeNext), viem ^2.21 (RPC: `getLogs`/`getBlock`/`readContract`, ABI decode), zod, vitest, postgres (via `docker exec`, not a direct dep).

**Deviation from spec §5:** The spec said "extend `cli.ts`". `cli.ts` imports `./db/index.js`, which **throws at import** when `DATABASE_URL` is unset and otherwise connects to the rebate DB (on the Aleph VM). The scan runs on the Mac mini and must never touch the rebate DB, so it gets a **dedicated entrypoint** `src/scan/cli.ts` exposed as `pnpm scan`. Everything else matches the spec.

## Global Constraints

- **Read-only:** never import `./db/index.js`, never write the rebate DB. (The scan must not be able to enroll a wallet or alter the ledger.)
- **Secrets** (`alchemy-api-key`, `ophis-telegram-bot`) are read from macOS Keychain into `process.env` at process start only — never hardcoded, never logged, never in command args that echo.
- **Output artifacts** (JSON + orderUid→appCode cache) write **out-of-repo** under `~/.ophis/`; default JSON `~/.ophis/scans/scan-<iso>.json`.
- **Attribution:** appCode allowlist is exactly `APP_CODES = ['ophis','greg']` (reuse `cow/types.ts`); referral codes must match `/^[a-z0-9_-]{3,64}$/`.
- **Settlement address** (all chains): `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`.
- **`Trade` event:** `event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)` — topic0 `0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17`.
- **No em-dash** in user-facing report/Telegram strings (use `:` or `,`).
- TDD, vitest, frequent commits. No new npm dependencies.

## File Structure

```
apps/rebate-indexer/
  src/scan/
    types.ts           # Swap, TokenLeg, Coverage, ChainConfig, ScanResult, ScanCache
    appdata.ts         # parseAppData(fullAppData) -> {appCode, refCode, feeBps}
    window.ts          # parseSince(), blockAtTimestamp() binary search
    chains.ts          # SCAN_CHAINS config + resolveRpcUrl()
    cache.ts           # loadCache() persistent orderUid->appCode|'none'
    enrich.ts          # tokenMeta() (+static fast-path) + enrichSwap() (USD via priceTrade)
    sources/
      onchain.ts       # TRADE_EVENT, fillsFromLogs(), classifyFills(), scanHostedChain()
      localDb.ts       # parseLocalRows(), scanLocalDbChain()
    report.ts          # renderTable(), telegramSummary(), defaultJsonPath(), writeJsonArtifact()
    secrets.ts         # loadAlchemyEnv(), loadTelegramEnv() (keychain -> env)
    cli.ts             # entrypoint: parse args, orchestrate, render (pnpm scan)
  tests/scan/
    appdata.test.ts
    window.test.ts
    onchain.test.ts
    localDb.test.ts
    enrich.test.ts
    cache.test.ts
    report.test.ts
    cli.test.ts
    fixtures/
      op-localdb-row.tsv
      mainnet-ophis-order.json
      non-ophis-order.json
```

---

### Task 1: Scaffold types + `pnpm scan` entrypoint

**Files:**
- Create: `apps/rebate-indexer/src/scan/types.ts`
- Create: `apps/rebate-indexer/src/scan/cli.ts`
- Modify: `apps/rebate-indexer/package.json` (add `"scan"` script)
- Test: `apps/rebate-indexer/tests/scan/types.smoke.test.ts`

**Interfaces:**
- Produces: `Swap`, `TokenLeg`, `Coverage`, `ChainConfig`, `ScanResult`, `ScanCache` (consumed by every later task).

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/types.smoke.test.ts
import { describe, it, expect } from 'vitest';
import type { Swap, Coverage } from '../../src/scan/types.js';

describe('scan types', () => {
  it('Swap and Coverage are usable shapes', () => {
    const s: Swap = {
      chainId: 1, chainName: 'ethereum', tsUtc: '2026-06-18T20:43:11Z',
      orderUid: '0xda3c', txHash: '0x5348', owner: '0xba3c', receiver: '0x0494',
      sell: { token: '0xc02a', symbol: 'WETH', decimals: 18, amount: '41000000000000000' },
      buy: { token: '0xdac1', symbol: 'USDT', decimals: 6, amount: '69927413' },
      appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: 69.93,
    };
    const c: Coverage = { chainId: 1, chainName: 'ethereum', status: 'ok', fillsScanned: 2880, ophisFound: 1, unresolved: 0 };
    expect(s.appCode).toBe('ophis');
    expect(c.status).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/types.smoke.test.ts`
Expected: FAIL — cannot find module `../../src/scan/types.js`.

- [ ] **Step 3: Create the types file**

```ts
// src/scan/types.ts
import type { AppCode } from '../cow/types.js';

export interface TokenLeg {
  token: `0x${string}`;
  symbol: string | null;
  decimals: number | null;
  amount: string; // raw atoms (uint256 as decimal string)
}

export interface Swap {
  chainId: number;
  chainName: string;
  tsUtc: string;             // ISO8601; order creationDate (settlement is near-instant)
  orderUid: `0x${string}`;
  txHash: `0x${string}` | null;
  owner: `0x${string}`;      // on-chain owner (eth-flow router for native-ETH sells)
  receiver: `0x${string}`;   // actual recipient (the user, for eth-flow)
  sell: TokenLeg;
  buy: TokenLeg;
  appCode: AppCode;
  refCode: string | null;
  feeBps: number | null;
  notionalUsd: number | null;
}

export interface Coverage {
  chainId: number;
  chainName: string;
  status: 'ok' | 'degraded';
  fillsScanned: number;
  ophisFound: number;
  unresolved: number;
  error?: string;
}

export type ChainKind = 'local-db' | 'rpc';

export interface ChainConfig {
  chainId: number;
  name: string;
  kind: ChainKind;
  dbContainer?: string;      // local-db chains
  alchemySubdomain?: string; // rpc chains
}

export interface ScanResult {
  swaps: Swap[];
  coverage: Coverage;
}

// orderUid -> classification. 'none' = resolved, confirmed NOT Ophis (negative cache).
export type CachedClass = AppCode | 'none';
export interface ScanCache {
  get(uid: string): CachedClass | undefined;
  set(uid: string, v: CachedClass): void;
  save(): Promise<void>;
}
```

- [ ] **Step 4: Create the entrypoint stub**

```ts
// src/scan/cli.ts
// Dedicated entrypoint (NOT src/cli.ts) so we never import ./db/index.js,
// which throws without DATABASE_URL and connects to the rebate DB.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm scan --since <48h|2d|90m> [--chains a,b] [--telegram] [--json <path>]');
    return;
  }
  console.log('scan: not yet implemented');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Add the package.json script**

In `apps/rebate-indexer/package.json`, add to `"scripts"`:

```json
    "scan": "tsx src/scan/cli.ts",
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/types.smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Verify the entrypoint runs**

Run: `cd apps/rebate-indexer && pnpm scan --help`
Expected: prints the usage line, exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/rebate-indexer/src/scan/types.ts apps/rebate-indexer/src/scan/cli.ts apps/rebate-indexer/package.json apps/rebate-indexer/tests/scan/types.smoke.test.ts
git commit -m "feat(scan): scaffold types + pnpm scan entrypoint"
```

---

### Task 2: `appdata.ts` — appData → {appCode, refCode, feeBps}

**Files:**
- Create: `apps/rebate-indexer/src/scan/appdata.ts`
- Create: `apps/rebate-indexer/tests/scan/appdata.test.ts`
- Create fixtures: `tests/scan/fixtures/mainnet-ophis-order.json`, `tests/scan/fixtures/non-ophis-order.json`

**Interfaces:**
- Consumes: `APP_CODES`, `AppCode` from `../cow/types.js`.
- Produces: `parseAppData(fullAppData: string | null | undefined): AppDataInfo` where `AppDataInfo = { appCode: AppCode | null; refCode: string | null; feeBps: number | null }`.

- [ ] **Step 1: Create fixtures**

```json
// tests/scan/fixtures/mainnet-ophis-order.json
{"appCode":"ophis","metadata":{"orderClass":{"orderClass":"market"},"partnerFee":{"recipient":"0x858f0F5eE954846D47155F5203c04aF1819eCeF8","volumeBps":10},"quote":{"slippageBips":158,"smartSlippage":true}},"version":"1.14.0"}
```

```json
// tests/scan/fixtures/non-ophis-order.json
{"appCode":"CoW Swap","metadata":{"quote":{"slippageBips":50}},"version":"1.1.0"}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/scan/appdata.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppData } from '../../src/scan/appdata.js';

const fx = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

describe('parseAppData', () => {
  it('extracts appCode + feeBps from a real Ophis order', () => {
    const r = parseAppData(fx('mainnet-ophis-order.json'));
    expect(r.appCode).toBe('ophis');
    expect(r.feeBps).toBe(10);
    expect(r.refCode).toBeNull();
  });
  it('rejects a non-Ophis appCode', () => {
    expect(parseAppData(fx('non-ophis-order.json')).appCode).toBeNull();
  });
  it('keeps a grammar-valid referral code, drops a bad one', () => {
    expect(parseAppData('{"appCode":"ophis","metadata":{"ophisReferrer":{"code":"Friend_01"}}}').refCode).toBe('friend_01');
    expect(parseAppData('{"appCode":"ophis","metadata":{"ophisReferrer":{"code":"a"}}}').refCode).toBeNull();
  });
  it('is null-safe on missing/malformed input', () => {
    expect(parseAppData(null)).toEqual({ appCode: null, refCode: null, feeBps: null });
    expect(parseAppData('{not json')).toEqual({ appCode: null, refCode: null, feeBps: null });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/appdata.test.ts`
Expected: FAIL — cannot find module `appdata.js`.

- [ ] **Step 4: Implement**

```ts
// src/scan/appdata.ts
import { APP_CODES, type AppCode } from '../cow/types.js';

export interface AppDataInfo {
  appCode: AppCode | null;
  refCode: string | null;
  feeBps: number | null;
}

const REF_RE = /^[a-z0-9_-]{3,64}$/;

export function parseAppData(fullAppData: string | null | undefined): AppDataInfo {
  const empty: AppDataInfo = { appCode: null, refCode: null, feeBps: null };
  if (!fullAppData) return empty;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(fullAppData) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const rawCode = (meta as { appCode?: unknown }).appCode;
  const appCode = typeof rawCode === 'string' && (APP_CODES as readonly string[]).includes(rawCode)
    ? (rawCode as AppCode)
    : null;

  const metadata = (meta as { metadata?: Record<string, unknown> }).metadata ?? {};
  let refCode: string | null = null;
  const rawRef = (metadata as { ophisReferrer?: { code?: unknown } }).ophisReferrer?.code;
  if (typeof rawRef === 'string') {
    const c = rawRef.trim().toLowerCase();
    if (REF_RE.test(c)) refCode = c;
  }
  const rawBps = (metadata as { partnerFee?: { volumeBps?: unknown } }).partnerFee?.volumeBps;
  const feeBps = typeof rawBps === 'number' && Number.isFinite(rawBps) ? rawBps : null;

  return { appCode, refCode, feeBps };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/appdata.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/rebate-indexer/src/scan/appdata.ts apps/rebate-indexer/tests/scan/appdata.test.ts apps/rebate-indexer/tests/scan/fixtures/
git commit -m "feat(scan): appData parser (appCode/refCode/feeBps)"
```

---

### Task 3: `window.ts` — duration parsing + block-by-timestamp

**Files:**
- Create: `apps/rebate-indexer/src/scan/window.ts`
- Create: `apps/rebate-indexer/tests/scan/window.test.ts`

**Interfaces:**
- Produces:
  - `parseSince(s: string): number` (seconds).
  - `interface BlockClient { getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>; getBlockNumber(): Promise<bigint> }`
  - `blockAtTimestamp(client: BlockClient, targetTsSec: number): Promise<bigint>` — lowest block with `timestamp >= target`; returns `head+1` if the chain head is older than target.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/window.test.ts
import { describe, it, expect } from 'vitest';
import { parseSince, blockAtTimestamp, type BlockClient } from '../../src/scan/window.js';

describe('parseSince', () => {
  it('parses units', () => {
    expect(parseSince('48h')).toBe(48 * 3600);
    expect(parseSince('2d')).toBe(2 * 86400);
    expect(parseSince('90m')).toBe(90 * 60);
    expect(parseSince('30s')).toBe(30);
  });
  it('throws on garbage', () => {
    expect(() => parseSince('soon')).toThrow();
  });
});

describe('blockAtTimestamp', () => {
  // synthetic chain: block N has timestamp N*12, head = 1000
  const client: BlockClient = {
    getBlockNumber: async () => 1000n,
    getBlock: async ({ blockNumber }) => ({ timestamp: blockNumber * 12n }),
  };
  it('finds the first block at/after the target', async () => {
    expect(await blockAtTimestamp(client, 6000)).toBe(500n);  // 500*12 = 6000
    expect(await blockAtTimestamp(client, 6001)).toBe(501n);
  });
  it('returns head+1 when target is past the head', async () => {
    expect(await blockAtTimestamp(client, 999_999)).toBe(1001n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/window.test.ts`
Expected: FAIL — cannot find module `window.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/window.ts
export function parseSince(s: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad --since '${s}'; use e.g. 48h, 2d, 90m, 30s`);
  const n = Number(m[1]);
  const mult = m[2] === 's' ? 1 : m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 86400;
  return n * mult;
}

export interface BlockClient {
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getBlockNumber(): Promise<bigint>;
}

// Lowest block whose timestamp >= targetTsSec. If the head is older than the
// target (no blocks in window), returns head+1 so a getLogs(fromBlock=head+1)
// is a no-op rather than scanning history.
export async function blockAtTimestamp(client: BlockClient, targetTsSec: number): Promise<bigint> {
  const target = BigInt(targetTsSec);
  const head = await client.getBlockNumber();
  const headTs = (await client.getBlock({ blockNumber: head })).timestamp;
  if (headTs < target) return head + 1n;
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const ts = (await client.getBlock({ blockNumber: mid })).timestamp;
    if (ts < target) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/window.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/window.ts apps/rebate-indexer/tests/scan/window.test.ts
git commit -m "feat(scan): --since parsing + block-by-timestamp binary search"
```

---

### Task 4: `chains.ts` — chain config + RPC URL resolution

**Files:**
- Create: `apps/rebate-indexer/src/scan/chains.ts`
- Create: `apps/rebate-indexer/tests/scan/chains.test.ts`

**Interfaces:**
- Consumes: `ChainConfig` from `./types.js`.
- Produces:
  - `SCAN_CHAINS: readonly ChainConfig[]` (OP local-db; mainnet/base/arbitrum/polygon/avalanche rpc).
  - `resolveRpcUrl(cfg: ChainConfig, apiKey: string): string`.
  - `selectChains(names?: string[]): ChainConfig[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/chains.test.ts
import { describe, it, expect } from 'vitest';
import { SCAN_CHAINS, resolveRpcUrl, selectChains } from '../../src/scan/chains.js';

describe('chains', () => {
  it('includes OP as local-db and mainnet as rpc', () => {
    const op = SCAN_CHAINS.find((c) => c.chainId === 10)!;
    const eth = SCAN_CHAINS.find((c) => c.chainId === 1)!;
    expect(op.kind).toBe('local-db');
    expect(op.dbContainer).toBe('optimism-mainnet-db-1');
    expect(eth.kind).toBe('rpc');
    expect(eth.alchemySubdomain).toBe('eth-mainnet');
  });
  it('builds an Alchemy URL without leaking the key into the host', () => {
    const eth = SCAN_CHAINS.find((c) => c.chainId === 1)!;
    expect(resolveRpcUrl(eth, 'SECRETKEY')).toBe('https://eth-mainnet.g.alchemy.com/v2/SECRETKEY');
  });
  it('selectChains filters by name, defaults to all', () => {
    expect(selectChains(['ethereum']).map((c) => c.chainId)).toEqual([1]);
    expect(selectChains().length).toBe(SCAN_CHAINS.length);
    expect(() => selectChains(['nope'])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/chains.test.ts`
Expected: FAIL — cannot find module `chains.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/chains.ts
import type { ChainConfig } from './types.js';

export const SCAN_CHAINS: readonly ChainConfig[] = [
  { chainId: 10,    name: 'optimism',  kind: 'local-db', dbContainer: 'optimism-mainnet-db-1' },
  { chainId: 1,     name: 'ethereum',  kind: 'rpc', alchemySubdomain: 'eth-mainnet' },
  { chainId: 8453,  name: 'base',      kind: 'rpc', alchemySubdomain: 'base-mainnet' },
  { chainId: 42161, name: 'arbitrum',  kind: 'rpc', alchemySubdomain: 'arb-mainnet' },
  { chainId: 137,   name: 'polygon',   kind: 'rpc', alchemySubdomain: 'polygon-mainnet' },
  { chainId: 43114, name: 'avalanche', kind: 'rpc', alchemySubdomain: 'avax-mainnet' },
];

export function resolveRpcUrl(cfg: ChainConfig, apiKey: string): string {
  if (cfg.kind !== 'rpc' || !cfg.alchemySubdomain) {
    throw new Error(`chain ${cfg.name} is not an rpc chain`);
  }
  if (!apiKey) throw new Error('alchemy api key is empty');
  return `https://${cfg.alchemySubdomain}.g.alchemy.com/v2/${apiKey}`;
}

export function selectChains(names?: string[]): ChainConfig[] {
  if (!names || names.length === 0) return [...SCAN_CHAINS];
  return names.map((n) => {
    const cfg = SCAN_CHAINS.find((c) => c.name === n.trim().toLowerCase());
    if (!cfg) throw new Error(`unknown chain '${n}'; known: ${SCAN_CHAINS.map((c) => c.name).join(', ')}`);
    return cfg;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/chains.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/chains.ts apps/rebate-indexer/tests/scan/chains.test.ts
git commit -m "feat(scan): chain config + Alchemy URL resolution"
```

---

### Task 5: `cache.ts` — persistent orderUid→class cache

**Files:**
- Create: `apps/rebate-indexer/src/scan/cache.ts`
- Create: `apps/rebate-indexer/tests/scan/cache.test.ts`

**Interfaces:**
- Consumes: `ScanCache`, `CachedClass` from `./types.js`.
- Produces: `loadCache(path?: string): Promise<ScanCache>` (default `~/.ophis/scan-cache.json`; missing/corrupt file -> empty; `save()` persists).

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/cache.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCache } from '../../src/scan/cache.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'scan-')), 'c.json');

describe('loadCache', () => {
  it('round-trips entries', async () => {
    const p = tmp();
    const c = await loadCache(p);
    c.set('0xaaa', 'ophis');
    c.set('0xbbb', 'none');
    await c.save();
    const c2 = await loadCache(p);
    expect(c2.get('0xaaa')).toBe('ophis');
    expect(c2.get('0xbbb')).toBe('none');
    expect(c2.get('0xccc')).toBeUndefined();
  });
  it('treats a missing file as empty', async () => {
    const c = await loadCache(join(tmpdir(), 'does-not-exist-12345', 'c.json'));
    expect(c.get('0xaaa')).toBeUndefined();
  });
  it('treats a corrupt file as empty', async () => {
    const p = tmp();
    writeFileSync(p, '{not json');
    const c = await loadCache(p);
    expect(c.get('0xaaa')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/cache.test.ts`
Expected: FAIL — cannot find module `cache.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/cache.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CachedClass, ScanCache } from './types.js';

export function defaultCachePath(): string {
  return join(homedir(), '.ophis', 'scan-cache.json');
}

export async function loadCache(path: string = defaultCachePath()): Promise<ScanCache> {
  const map = new Map<string, CachedClass>();
  try {
    const raw = await readFile(path, 'utf8');
    const obj = JSON.parse(raw) as Record<string, CachedClass>;
    for (const [k, v] of Object.entries(obj)) {
      if (v === 'ophis' || v === 'greg' || v === 'none') map.set(k.toLowerCase(), v);
    }
  } catch {
    // missing or corrupt -> start empty (the scan re-resolves; cache is an optimization)
  }
  return {
    get: (uid) => map.get(uid.toLowerCase()),
    set: (uid, v) => { map.set(uid.toLowerCase(), v); },
    save: async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(Object.fromEntries(map)), 'utf8');
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/cache.ts apps/rebate-indexer/tests/scan/cache.test.ts
git commit -m "feat(scan): persistent orderUid->class cache"
```

---

### Task 6: `sources/onchain.ts` — Trade decode, dedup, classify

**Files:**
- Create: `apps/rebate-indexer/src/scan/sources/onchain.ts`
- Create: `apps/rebate-indexer/tests/scan/onchain.test.ts`
- Create fixture: `tests/scan/fixtures/non-ophis-order.json` already exists (Task 2).

**Interfaces:**
- Consumes: `Swap`, `ScanCache` from `../types.js`; `parseAppData` from `../appdata.js`; `CowOrder` from `../../cow/types.js`.
- Produces:
  - `TRADE_EVENT` (parsed ABI item), `SETTLEMENT_ADDRESS`.
  - `interface DecodedTradeLog { args: { owner: \`0x${string}\`; sellToken: \`0x${string}\`; buyToken: \`0x${string}\`; sellAmount: bigint; buyAmount: bigint; orderUid: \`0x${string}\` }; transactionHash: \`0x${string}\` | null; blockNumber: bigint }`
  - `interface RawFill { orderUid: \`0x${string}\`; owner: \`0x${string}\`; sellToken: \`0x${string}\`; buyToken: \`0x${string}\`; sellAmount: bigint; buyAmount: bigint; txHash: \`0x${string}\` | null }`
  - `fillsFromLogs(logs: DecodedTradeLog[]): RawFill[]` (dedup by orderUid).
  - `classifyFills(chainId: number, chainName: string, fills: RawFill[], t0Sec: number, deps: { getOrder(chainId: number, uid: \`0x${string}\`): Promise<CowOrder>; cache: ScanCache }): Promise<{ swaps: Swap[]; ophisFound: number; unresolved: number }>` — resolves each fill's order, keeps Ophis appCodes whose `creationDate >= t0`, returns partial `Swap`s (symbol/decimals/notionalUsd left null for the enrich step).

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/onchain.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillsFromLogs, classifyFills, type DecodedTradeLog } from '../../src/scan/sources/onchain.js';
import type { CowOrder } from '../../src/cow/types.js';

const fx = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

const log = (orderUid: string, over: Partial<DecodedTradeLog['args']> = {}): DecodedTradeLog => ({
  args: {
    owner: '0xba3cb449bd2b4adddbc894d8697f5170800eadec',
    sellToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    buyToken: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    sellAmount: 41000000000000000n,
    buyAmount: 69927413n,
    orderUid: orderUid as `0x${string}`,
    ...over,
  },
  transactionHash: '0x5348',
  blockNumber: 100n,
});

describe('fillsFromLogs', () => {
  it('dedups multiple fills of the same order', () => {
    const fills = fillsFromLogs([log('0xuid1'), log('0xuid1'), log('0xuid2')]);
    expect(fills.map((f) => f.orderUid)).toEqual(['0xuid1', '0xuid2']);
  });
});

describe('classifyFills', () => {
  const ophisOrder: CowOrder = {
    uid: '0xuid1', owner: '0xba3c', sellToken: '0xc02a', buyToken: '0xdac1',
    sellAmount: '41000000000000000', buyAmount: '69927413',
    appData: '0xhash', fullAppData: fx('mainnet-ophis-order.json'),
    creationDate: '2026-06-18T20:43:11Z', status: 'fulfilled',
    receiver: '0x0494f503912c101bfd76b88e4f5d8a33de284d1a',
  } as unknown as CowOrder;
  const nonOphis: CowOrder = { ...ophisOrder, uid: '0xuid2', fullAppData: fx('non-ophis-order.json') };

  const t0 = Math.floor(new Date('2026-06-17T00:00:00Z').getTime() / 1000);

  it('keeps Ophis orders, drops non-Ophis, counts coverage', async () => {
    const cache = new Map<string, any>();
    const deps = {
      getOrder: async (_c: number, uid: `0x${string}`) => (uid === '0xuid1' ? ophisOrder : nonOphis),
      cache: { get: (u: string) => cache.get(u), set: (u: string, v: any) => cache.set(u, v), save: async () => {} },
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1'), log('0xuid2')]), t0, deps);
    expect(out.ophisFound).toBe(1);
    expect(out.swaps).toHaveLength(1);
    expect(out.swaps[0]!.appCode).toBe('ophis');
    expect(out.swaps[0]!.feeBps).toBe(10);
    expect(out.swaps[0]!.receiver).toBe('0x0494f503912c101bfd76b88e4f5d8a33de284d1a');
    // negative-cached the non-Ophis uid
    expect(cache.get('0xuid2')).toBe('none');
  });

  it('window-filters by creationDate', async () => {
    const future = Math.floor(new Date('2026-06-19T00:00:00Z').getTime() / 1000);
    const deps = {
      getOrder: async () => ophisOrder,
      cache: { get: () => undefined, set: () => {}, save: async () => {} },
    };
    const out = await classifyFills(1, 'ethereum', fillsFromLogs([log('0xuid1')]), future, deps);
    expect(out.swaps).toHaveLength(0); // order is older than t0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/onchain.test.ts`
Expected: FAIL — cannot find module `sources/onchain.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/sources/onchain.ts
import { parseAbiItem } from 'viem';
import type { CowOrder } from '../../cow/types.js';
import type { ScanCache, Swap } from '../types.js';
import { parseAppData } from '../appdata.js';

export const SETTLEMENT_ADDRESS = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;
export const TRADE_EVENT = parseAbiItem(
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
);

export interface DecodedTradeLog {
  args: {
    owner: `0x${string}`;
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    sellAmount: bigint;
    buyAmount: bigint;
    orderUid: `0x${string}`;
  };
  transactionHash: `0x${string}` | null;
  blockNumber: bigint;
}

export interface RawFill {
  orderUid: `0x${string}`;
  owner: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  txHash: `0x${string}` | null;
}

// One order can settle across multiple fills (same orderUid). Keep the first.
export function fillsFromLogs(logs: DecodedTradeLog[]): RawFill[] {
  const seen = new Set<string>();
  const out: RawFill[] = [];
  for (const l of logs) {
    const uid = l.args.orderUid.toLowerCase();
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      orderUid: l.args.orderUid,
      owner: l.args.owner,
      sellToken: l.args.sellToken,
      buyToken: l.args.buyToken,
      sellAmount: l.args.sellAmount,
      buyAmount: l.args.buyAmount,
      txHash: l.transactionHash,
    });
  }
  return out;
}

export interface ClassifyDeps {
  getOrder(chainId: number, uid: `0x${string}`): Promise<CowOrder>;
  cache: ScanCache;
}

export async function classifyFills(
  chainId: number,
  chainName: string,
  fills: RawFill[],
  t0Sec: number,
  deps: ClassifyDeps,
): Promise<{ swaps: Swap[]; ophisFound: number; unresolved: number }> {
  const swaps: Swap[] = [];
  let unresolved = 0;

  for (const f of fills) {
    // Negative cache: a uid we already resolved to non-Ophis is skipped cheaply.
    if (deps.cache.get(f.orderUid) === 'none') continue;

    let order: CowOrder;
    try {
      order = await deps.getOrder(chainId, f.orderUid);
    } catch {
      unresolved += 1; // order aged out of CoW's DB, or transient failure
      continue;
    }

    const info = parseAppData(order.fullAppData);
    if (!info.appCode) {
      deps.cache.set(f.orderUid, 'none');
      continue;
    }
    deps.cache.set(f.orderUid, info.appCode);

    // Window-filter by the order's creationDate (settlement is near-instant).
    const tsSec = Math.floor(new Date(order.creationDate).getTime() / 1000);
    if (!Number.isFinite(tsSec) || tsSec < t0Sec) continue;

    swaps.push({
      chainId,
      chainName,
      tsUtc: order.creationDate,
      orderUid: f.orderUid,
      txHash: f.txHash,
      owner: f.owner,
      receiver: (order.receiver as `0x${string}`) ?? f.owner,
      sell: { token: f.sellToken, symbol: null, decimals: null, amount: f.sellAmount.toString() },
      buy: { token: f.buyToken, symbol: null, decimals: null, amount: f.buyAmount.toString() },
      appCode: info.appCode,
      refCode: info.refCode,
      feeBps: info.feeBps,
      notionalUsd: null,
    });
  }

  return { swaps, ophisFound: swaps.length, unresolved };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/onchain.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/sources/onchain.ts apps/rebate-indexer/tests/scan/onchain.test.ts
git commit -m "feat(scan): Trade-log decode, dedup, appData classification"
```

---

### Task 7: `sources/onchain.ts` — live chain driver (`scanHostedChain`)

**Files:**
- Modify: `apps/rebate-indexer/src/scan/sources/onchain.ts` (append)
- Modify: `apps/rebate-indexer/tests/scan/onchain.test.ts` (append a chunking test using a fake client)

**Interfaces:**
- Consumes: `blockAtTimestamp`, `BlockClient` from `../window.js`; `getLogs`-shaped client.
- Produces:
  - `interface LogClient extends BlockClient { getLogs(a: { address: \`0x${string}\`; event: typeof TRADE_EVENT; fromBlock: bigint; toBlock: bigint }): Promise<DecodedTradeLog[]> }`
  - `collectTradeLogs(client: LogClient, fromBlock: bigint, toBlock: bigint, chunk?: bigint): Promise<DecodedTradeLog[]>` — chunked getLogs with halving retry.
  - `scanHostedChain(cfg: ChainConfig, t0Sec: number, deps: { client: LogClient } & ClassifyDeps): Promise<ScanResult>`.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to tests/scan/onchain.test.ts
import { collectTradeLogs, type LogClient } from '../../src/scan/sources/onchain.js';

describe('collectTradeLogs', () => {
  it('chunks the block range and concatenates', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const client = {
      getBlockNumber: async () => 0n,
      getBlock: async () => ({ timestamp: 0n }),
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return [];
      },
    } as unknown as LogClient;
    await collectTradeLogs(client, 0n, 4500n, 2000n);
    expect(calls).toEqual([[0n, 1999n], [2000n, 3999n], [4000n, 4500n]]);
  });

  it('halves the chunk and retries on a getLogs error', async () => {
    let attempts = 0;
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        attempts += 1;
        if (toBlock - fromBlock > 500n) throw new Error('query returned more than 10000 results');
        return [];
      },
    } as unknown as LogClient;
    await collectTradeLogs(client, 0n, 1000n, 2000n);
    expect(attempts).toBeGreaterThan(1); // it backed off into smaller windows
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/onchain.test.ts`
Expected: FAIL — `collectTradeLogs` is not exported.

- [ ] **Step 3: Implement (append to onchain.ts)**

```ts
// append to src/scan/sources/onchain.ts
import type { ChainConfig, ScanResult } from '../types.js';
import { blockAtTimestamp, type BlockClient } from '../window.js';

export interface LogClient extends BlockClient {
  getLogs(a: {
    address: `0x${string}`;
    event: typeof TRADE_EVENT;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<DecodedTradeLog[]>;
}

const DEFAULT_CHUNK = 2_000n;
const MIN_CHUNK = 100n;

export async function collectTradeLogs(
  client: LogClient,
  fromBlock: bigint,
  toBlock: bigint,
  chunk: bigint = DEFAULT_CHUNK,
): Promise<DecodedTradeLog[]> {
  const out: DecodedTradeLog[] = [];
  let start = fromBlock;
  let size = chunk;
  while (start <= toBlock) {
    const end = start + size - 1n > toBlock ? toBlock : start + size - 1n;
    try {
      const logs = await client.getLogs({ address: SETTLEMENT_ADDRESS, event: TRADE_EVENT, fromBlock: start, toBlock: end });
      out.push(...logs);
      start = end + 1n;
      if (size < chunk) size = chunk; // recover chunk size after a successful smaller window
    } catch (err) {
      if (size <= MIN_CHUNK) throw err; // genuinely failing, not a range/size limit
      size = size / 2n > MIN_CHUNK ? size / 2n : MIN_CHUNK;
    }
  }
  return out;
}

export async function scanHostedChain(
  cfg: ChainConfig,
  t0Sec: number,
  deps: { client: LogClient } & ClassifyDeps,
): Promise<ScanResult> {
  const base: ScanResult['coverage'] = {
    chainId: cfg.chainId, chainName: cfg.name, status: 'ok', fillsScanned: 0, ophisFound: 0, unresolved: 0,
  };
  try {
    const fromBlock = await blockAtTimestamp(deps.client, t0Sec);
    const head = await deps.client.getBlockNumber();
    if (fromBlock > head) return { swaps: [], coverage: base };
    const logs = await collectTradeLogs(deps.client, fromBlock, head);
    const fills = fillsFromLogs(logs);
    const { swaps, ophisFound, unresolved } = await classifyFills(cfg.chainId, cfg.name, fills, t0Sec, deps);
    return { swaps, coverage: { ...base, fillsScanned: fills.length, ophisFound, unresolved } };
  } catch (err) {
    return { swaps: [], coverage: { ...base, status: 'degraded', error: err instanceof Error ? err.message : String(err) } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/onchain.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/sources/onchain.ts apps/rebate-indexer/tests/scan/onchain.test.ts
git commit -m "feat(scan): chunked getLogs collector + hosted-chain driver"
```

---

### Task 8: `sources/localDb.ts` — OP orderbook Postgres source

**Files:**
- Create: `apps/rebate-indexer/src/scan/sources/localDb.ts`
- Create: `apps/rebate-indexer/tests/scan/localDb.test.ts`
- Create fixture: `tests/scan/fixtures/op-localdb-row.tsv`

**Interfaces:**
- Consumes: `Swap`, `ChainConfig`, `ScanResult` from `../types.js`; `parseAppData` from `../appdata.js`.
- Produces:
  - `type PsqlRunner = (container: string, sql: string) => Promise<string>`
  - `buildLocalQuery(t0Iso: string): string`
  - `parseLocalRows(tsv: string, chainId: number, chainName: string): Swap[]`
  - `scanLocalDbChain(cfg: ChainConfig, t0Iso: string, run?: PsqlRunner): Promise<ScanResult>`

The query selects, tab-separated (psql `-F '\t' -A -t`), in this exact column order:
`creation_timestamp_iso, order_uid, owner, receiver, sell_token, buy_token, executed_sell, executed_buy, tx_hash, full_app_data`.

- [ ] **Step 1: Create the fixture (real OP swap row)**

```
// tests/scan/fixtures/op-localdb-row.tsv  (single line, tab-separated)
2026-06-18T20:36:27+00:00	0x56a0f30b1c70528f3971297d42fb8a49eb48618da9b65923f1f570eb61ecf9b10494f503912c101bfd76b88e4f5d8a33de284d1a6a345dc8	0x0494f503912c101bfd76b88e4f5d8a33de284d1a	0x0494f503912c101bfd76b88e4f5d8a33de284d1a	0x4200000000000000000000000000000000000006	0x94b008aa00579c1307b0ef2c499ad98a8ce58e58	20000000000000000	34214818	0xe315ae6193e796abf9247c4d3bc2dbca0fd02c2954bce1c8f41f3a8af7cdcf1b	{"appCode":"ophis","metadata":{"partnerFee":{"recipient":"0x858f0F5eE954846D47155F5203c04aF1819eCeF8","volumeBps":10}},"version":"1.14.0"}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/scan/localDb.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLocalRows, buildLocalQuery, scanLocalDbChain } from '../../src/scan/sources/localDb.js';

const tsv = readFileSync(join(__dirname, 'fixtures', 'op-localdb-row.tsv'), 'utf8');

describe('parseLocalRows', () => {
  it('parses a real OP row into a Swap', () => {
    const [s, ...rest] = parseLocalRows(tsv, 10, 'optimism');
    expect(rest).toHaveLength(0);
    expect(s!.chainId).toBe(10);
    expect(s!.sell.token).toBe('0x4200000000000000000000000000000000000006');
    expect(s!.sell.amount).toBe('20000000000000000');
    expect(s!.buy.amount).toBe('34214818');
    expect(s!.appCode).toBe('ophis');
    expect(s!.feeBps).toBe(10);
    expect(s!.txHash).toBe('0xe315ae6193e796abf9247c4d3bc2dbca0fd02c2954bce1c8f41f3a8af7cdcf1b');
  });
  it('ignores blank lines', () => {
    expect(parseLocalRows('\n\n', 10, 'optimism')).toEqual([]);
  });
});

describe('buildLocalQuery', () => {
  it('filters by window and Ophis appCode', () => {
    const q = buildLocalQuery('2026-06-17T00:00:00Z');
    expect(q).toContain("2026-06-17T00:00:00Z");
    expect(q).toMatch(/appCode'\s*in\s*\('ophis','greg'\)/i);
  });
});

describe('scanLocalDbChain', () => {
  it('runs the injected psql runner and returns coverage', async () => {
    const run = async () => tsv;
    const res = await scanLocalDbChain({ chainId: 10, name: 'optimism', kind: 'local-db', dbContainer: 'optimism-mainnet-db-1' }, '2026-06-17T00:00:00Z', run);
    expect(res.coverage.status).toBe('ok');
    expect(res.coverage.ophisFound).toBe(1);
    expect(res.swaps).toHaveLength(1);
  });
  it('marks the chain degraded when psql throws', async () => {
    const run = async () => { throw new Error('container not running'); };
    const res = await scanLocalDbChain({ chainId: 10, name: 'optimism', kind: 'local-db', dbContainer: 'x' }, '2026-06-17T00:00:00Z', run);
    expect(res.coverage.status).toBe('degraded');
    expect(res.coverage.error).toContain('container not running');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/localDb.test.ts`
Expected: FAIL — cannot find module `sources/localDb.js`.

- [ ] **Step 4: Implement**

```ts
// src/scan/sources/localDb.ts
import { execFile } from 'node:child_process';
import type { ChainConfig, ScanResult, Swap } from '../types.js';
import { parseAppData } from '../appdata.js';

export type PsqlRunner = (container: string, sql: string) => Promise<string>;

// The orderbook DB stores bytea columns; we hex-encode + prefix 0x in SQL. Join the
// app_data document so we can filter on appCode without a second round-trip, and use
// trades' executed amounts (summed across fills) for true settled volume.
export function buildLocalQuery(t0Iso: string): string {
  return `
    select
      to_char(o.creation_timestamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      '0x'||encode(o.uid,'hex'),
      '0x'||encode(o.owner,'hex'),
      '0x'||encode(o.receiver,'hex'),
      '0x'||encode(o.sell_token,'hex'),
      '0x'||encode(o.buy_token,'hex'),
      sum(t.sell_amount)::text,
      sum(t.buy_amount)::text,
      '0x'||encode(max(s.tx_hash),'hex'),
      convert_from(a.full_app_data,'UTF8')
    from trades t
      join orders o on o.uid = t.order_uid
      join app_data a on a.contract_app_data = o.app_data
      left join settlements s on s.block_number = t.block_number
    where o.creation_timestamp >= '${t0Iso}'::timestamptz
      and convert_from(a.full_app_data,'UTF8')::jsonb->>'appCode' in ('ophis','greg')
    group by o.uid, o.creation_timestamp, o.owner, o.receiver, o.sell_token, o.buy_token, a.full_app_data
    order by o.creation_timestamp desc;`;
}

export const dockerPsql: PsqlRunner = (container, sql) =>
  new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'psql', '-U', 'ophis', '-d', 'ophis', '-F', '\t', '-A', '-t', '-c', sql],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });

export function parseLocalRows(tsv: string, chainId: number, chainName: string): Swap[] {
  const out: Swap[] = [];
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const [tsUtc, uid, owner, receiver, sellToken, buyToken, sellAmount, buyAmount, txHash, fullAppData] = line.split('\t');
    const info = parseAppData(fullAppData);
    if (!info.appCode) continue; // defensive; the SQL already filtered
    out.push({
      chainId, chainName, tsUtc: tsUtc!,
      orderUid: uid as `0x${string}`,
      txHash: (txHash && txHash !== '0x') ? (txHash as `0x${string}`) : null,
      owner: owner as `0x${string}`,
      receiver: receiver as `0x${string}`,
      sell: { token: sellToken as `0x${string}`, symbol: null, decimals: null, amount: sellAmount! },
      buy: { token: buyToken as `0x${string}`, symbol: null, decimals: null, amount: buyAmount! },
      appCode: info.appCode, refCode: info.refCode, feeBps: info.feeBps, notionalUsd: null,
    });
  }
  return out;
}

export async function scanLocalDbChain(cfg: ChainConfig, t0Iso: string, run: PsqlRunner = dockerPsql): Promise<ScanResult> {
  const base: ScanResult['coverage'] = { chainId: cfg.chainId, chainName: cfg.name, status: 'ok', fillsScanned: 0, ophisFound: 0, unresolved: 0 };
  try {
    const tsv = await run(cfg.dbContainer!, buildLocalQuery(t0Iso));
    const swaps = parseLocalRows(tsv, cfg.chainId, cfg.name);
    return { swaps, coverage: { ...base, fillsScanned: swaps.length, ophisFound: swaps.length } };
  } catch (err) {
    return { swaps: [], coverage: { ...base, status: 'degraded', error: err instanceof Error ? err.message : String(err) } };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/localDb.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/rebate-indexer/src/scan/sources/localDb.ts apps/rebate-indexer/tests/scan/localDb.test.ts apps/rebate-indexer/tests/scan/fixtures/op-localdb-row.tsv
git commit -m "feat(scan): OP local orderbook Postgres source"
```

---

### Task 9: `enrich.ts` — token symbol/decimals + USD

**Files:**
- Create: `apps/rebate-indexer/src/scan/enrich.ts`
- Create: `apps/rebate-indexer/tests/scan/enrich.test.ts`

**Interfaces:**
- Consumes: `Swap` from `./types.js`; `priceTrade` from `../pricer.js`.
- Produces:
  - `interface Erc20Reader { readContract(a: { address: \`0x${string}\`; abi: unknown; functionName: 'symbol' | 'decimals' }): Promise<unknown> }`
  - `tokenMeta(addr: \`0x${string}\`, reader: Erc20Reader | null, cache: Map<string, { symbol: string | null; decimals: number | null }>): Promise<{ symbol: string | null; decimals: number | null }>`
  - `enrichSwap(swap: Swap, deps: { reader: Erc20Reader | null; metaCache: Map<string, { symbol: string | null; decimals: number | null }>; priceFn?: typeof priceTrade }): Promise<Swap>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/enrich.test.ts
import { describe, it, expect } from 'vitest';
import { tokenMeta, enrichSwap } from '../../src/scan/enrich.js';
import type { Swap } from '../../src/scan/types.js';

const WETH_OP = '0x4200000000000000000000000000000000000006' as const;

describe('tokenMeta', () => {
  it('uses the static fast-path without any RPC', async () => {
    const m = await tokenMeta(WETH_OP, null, new Map());
    expect(m).toEqual({ symbol: 'WETH', decimals: 18 });
  });
  it('falls back to on-chain reads and caches them', async () => {
    let calls = 0;
    const reader = { readContract: async ({ functionName }: any) => { calls++; return functionName === 'symbol' ? 'FOO' : 9; } };
    const cache = new Map();
    const a = '0x1111111111111111111111111111111111111111' as const;
    expect(await tokenMeta(a, reader, cache)).toEqual({ symbol: 'FOO', decimals: 9 });
    await tokenMeta(a, reader, cache); // cached
    expect(calls).toBe(2); // symbol + decimals once only
  });
  it('returns nulls when reads throw', async () => {
    const reader = { readContract: async () => { throw new Error('no code'); } };
    expect(await tokenMeta('0x2222222222222222222222222222222222222222', reader, new Map())).toEqual({ symbol: null, decimals: null });
  });
});

describe('enrichSwap', () => {
  const swap: Swap = {
    chainId: 10, chainName: 'optimism', tsUtc: '2026-06-18T20:36:27Z', orderUid: '0x56a0', txHash: '0xe315',
    owner: '0x0494', receiver: '0x0494',
    sell: { token: WETH_OP, symbol: null, decimals: null, amount: '20000000000000000' },
    buy: { token: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', symbol: null, decimals: null, amount: '34214818' },
    appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: null,
  };
  it('fills symbols/decimals and notionalUsd', async () => {
    const out = await enrichSwap(swap, { reader: null, metaCache: new Map(), priceFn: async () => 34.21 });
    expect(out.sell.symbol).toBe('WETH');
    expect(out.buy.symbol).toBe('USDT'); // static map for OP USDT
    expect(out.notionalUsd).toBe(34.21);
  });
  it('leaves notionalUsd null when pricing throws', async () => {
    const out = await enrichSwap(swap, { reader: null, metaCache: new Map(), priceFn: async () => { throw new Error('no liquidity'); } });
    expect(out.notionalUsd).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/enrich.test.ts`
Expected: FAIL — cannot find module `enrich.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/enrich.ts
import { priceTrade } from '../pricer.js';
import type { Swap } from './types.js';

// Static fast-path for the common tokens so a quiet run needs zero token RPC.
// Keyed by lowercased address. Covers WETH/USDC/USDT/DAI/WBTC on the scanned chains.
const STATIC: Record<string, { symbol: string; decimals: number }> = {
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 }, // OP WETH
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },  // OP USDT
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },  // OP USDC
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 }, // ETH WETH
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },  // ETH USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },  // ETH USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },  // ETH DAI
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },  // ETH WBTC
};

const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export interface Erc20Reader {
  readContract(a: { address: `0x${string}`; abi: unknown; functionName: 'symbol' | 'decimals' }): Promise<unknown>;
}

export async function tokenMeta(
  addr: `0x${string}`,
  reader: Erc20Reader | null,
  cache: Map<string, { symbol: string | null; decimals: number | null }>,
): Promise<{ symbol: string | null; decimals: number | null }> {
  const key = addr.toLowerCase();
  const stat = STATIC[key];
  if (stat) return stat;
  const cached = cache.get(key);
  if (cached) return cached;
  if (!reader) {
    const r = { symbol: null, decimals: null };
    cache.set(key, r);
    return r;
  }
  let result: { symbol: string | null; decimals: number | null };
  try {
    const [symbol, decimals] = await Promise.all([
      reader.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }),
      reader.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }),
    ]);
    result = { symbol: String(symbol), decimals: Number(decimals) };
  } catch {
    result = { symbol: null, decimals: null };
  }
  cache.set(key, result);
  return result;
}

export interface EnrichDeps {
  reader: Erc20Reader | null;
  metaCache: Map<string, { symbol: string | null; decimals: number | null }>;
  priceFn?: typeof priceTrade;
  refPriceCache?: Map<number, number>;
}

export async function enrichSwap(swap: Swap, deps: EnrichDeps): Promise<Swap> {
  const price = deps.priceFn ?? priceTrade;
  const [sellMeta, buyMeta] = await Promise.all([
    tokenMeta(swap.sell.token, deps.reader, deps.metaCache),
    tokenMeta(swap.buy.token, deps.reader, deps.metaCache),
  ]);
  let notionalUsd: number | null = null;
  try {
    notionalUsd = await price(
      { tradeUid: swap.orderUid, chainId: swap.chainId, sellToken: swap.sell.token, sellAmount: BigInt(swap.sell.amount) },
      deps.refPriceCache,
    );
  } catch {
    notionalUsd = null; // thin/unrouteable token, same fail-safe the indexer uses
  }
  return {
    ...swap,
    sell: { ...swap.sell, ...sellMeta },
    buy: { ...swap.buy, ...buyMeta },
    notionalUsd,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/enrich.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/enrich.ts apps/rebate-indexer/tests/scan/enrich.test.ts
git commit -m "feat(scan): token metadata (static + on-chain) and USD enrichment"
```

---

### Task 10: `report.ts` — table, JSON artifact, Telegram summary

**Files:**
- Create: `apps/rebate-indexer/src/scan/report.ts`
- Create: `apps/rebate-indexer/tests/scan/report.test.ts`

**Interfaces:**
- Consumes: `Swap`, `Coverage` from `./types.js`.
- Produces:
  - `fmtAmount(amount: string, decimals: number | null): string`
  - `renderTable(swaps: Swap[], coverage: Coverage[]): string`
  - `telegramSummary(swaps: Swap[], coverage: Coverage[], windowLabel: string): string`
  - `defaultJsonPath(nowIso: string): string`
  - `writeJsonArtifact(path: string, payload: { window: string; generatedAt: string; swaps: Swap[]; coverage: Coverage[] }): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/report.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fmtAmount, renderTable, telegramSummary, defaultJsonPath, writeJsonArtifact } from '../../src/scan/report.js';
import type { Swap, Coverage } from '../../src/scan/types.js';

const swap: Swap = {
  chainId: 1, chainName: 'ethereum', tsUtc: '2026-06-18T20:43:11Z', orderUid: '0xda3c', txHash: '0x5348',
  owner: '0xba3c', receiver: '0x0494',
  sell: { token: '0xc02a', symbol: 'WETH', decimals: 18, amount: '41000000000000000' },
  buy: { token: '0xdac1', symbol: 'USDT', decimals: 6, amount: '69927413' },
  appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: 69.93,
};
const cov: Coverage[] = [{ chainId: 1, chainName: 'ethereum', status: 'ok', fillsScanned: 2880, ophisFound: 1, unresolved: 0 }];

describe('fmtAmount', () => {
  it('formats by decimals, raw when unknown', () => {
    expect(fmtAmount('41000000000000000', 18)).toBe('0.041');
    expect(fmtAmount('69927413', 6)).toBe('69.927413');
    expect(fmtAmount('123', null)).toBe('123 (raw)');
  });
});

describe('renderTable', () => {
  it('shows the swap and a coverage line, no em-dash', () => {
    const out = renderTable([swap], cov);
    expect(out).toContain('0.041 WETH');
    expect(out).toContain('69.927413 USDT');
    expect(out).toContain('ethereum');
    expect(out).not.toContain('—');
  });
  it('states when a window is empty', () => {
    expect(renderTable([], cov)).toContain('No Ophis swaps');
  });
});

describe('telegramSummary', () => {
  it('summarizes count + degraded chains', () => {
    const degraded: Coverage[] = [...cov, { chainId: 137, chainName: 'polygon', status: 'degraded', fillsScanned: 0, ophisFound: 0, unresolved: 0, error: 'rpc 429' }];
    const s = telegramSummary([swap], degraded, 'last 48h');
    expect(s).toContain('1');
    expect(s).toContain('polygon');
  });
});

describe('writeJsonArtifact', () => {
  it('defaults under ~/.ophis (out of repo)', () => {
    expect(defaultJsonPath('2026-06-19T09:00:00Z').startsWith(join(homedir(), '.ophis'))).toBe(true);
  });
  it('writes parseable JSON', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scan-')), 'r.json');
    await writeJsonArtifact(p, { window: 'last 48h', generatedAt: '2026-06-19T09:00:00Z', swaps: [swap], coverage: cov });
    const back = JSON.parse(readFileSync(p, 'utf8'));
    expect(back.swaps[0].orderUid).toBe('0xda3c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/report.test.ts`
Expected: FAIL — cannot find module `report.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/report.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Coverage, Swap } from './types.js';

export function fmtAmount(amount: string, decimals: number | null): string {
  if (decimals === null) return `${amount} (raw)`;
  const neg = amount.startsWith('-');
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

const leg = (l: Swap['sell']) => `${fmtAmount(l.amount, l.decimals)} ${l.symbol ?? l.token.slice(0, 10)}`;

export function renderTable(swaps: Swap[], coverage: Coverage[]): string {
  const lines: string[] = [];
  if (swaps.length === 0) {
    lines.push('No Ophis swaps in window.');
  } else {
    lines.push(`Ophis swaps: ${swaps.length}`);
    for (const s of swaps) {
      const usd = s.notionalUsd !== null ? `$${s.notionalUsd.toFixed(2)}` : 'n/a';
      lines.push(`  ${s.tsUtc}  ${s.chainName.padEnd(9)}  ${leg(s.sell)} -> ${leg(s.buy)}  (${usd})  ${s.orderUid.slice(0, 12)}...`);
    }
  }
  lines.push('');
  lines.push('Coverage:');
  for (const c of coverage) {
    const tail = c.status === 'ok'
      ? `scanned ${c.fillsScanned}, ophis ${c.ophisFound}, unresolved ${c.unresolved}`
      : `DEGRADED: ${c.error ?? 'unknown'}`;
    lines.push(`  ${c.chainName.padEnd(9)}  ${c.status.toUpperCase().padEnd(8)}  ${tail}`);
  }
  return lines.join('\n');
}

export function telegramSummary(swaps: Swap[], coverage: Coverage[], windowLabel: string): string {
  const totalUsd = swaps.reduce((a, s) => a + (s.notionalUsd ?? 0), 0);
  const degraded = coverage.filter((c) => c.status === 'degraded').map((c) => c.chainName);
  const head = `Ophis swap report (${windowLabel}): ${swaps.length} swaps, ~$${totalUsd.toFixed(2)} notional`;
  const top = swaps.slice(0, 5).map((s) => `- ${s.chainName}: ${leg(s.sell)} to ${leg(s.buy)}`);
  const warn = degraded.length ? `\nDegraded chains: ${degraded.join(', ')}` : '';
  return [head, ...top].join('\n') + warn;
}

export function defaultJsonPath(nowIso: string): string {
  return join(homedir(), '.ophis', 'scans', `scan-${nowIso.replace(/[:.]/g, '-')}.json`);
}

export async function writeJsonArtifact(
  path: string,
  payload: { window: string; generatedAt: string; swaps: Swap[]; coverage: Coverage[] },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/report.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/report.ts apps/rebate-indexer/tests/scan/report.test.ts
git commit -m "feat(scan): terminal table, JSON artifact, Telegram summary"
```

---

### Task 11: `secrets.ts` — Keychain → env (no leakage)

**Files:**
- Create: `apps/rebate-indexer/src/scan/secrets.ts`
- Create: `apps/rebate-indexer/tests/scan/secrets.test.ts`

**Interfaces:**
- Produces:
  - `type SecretReader = (service: string) => Promise<string | null>`
  - `loadAlchemyEnv(read?: SecretReader): Promise<string>` — returns the key, setting `process.env.ALCHEMY_API_KEY` if it had to fetch it.
  - `loadTelegramEnv(read?: SecretReader): Promise<boolean>` — sets `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID=735726338`; returns true if a token is available.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/secrets.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAlchemyEnv, loadTelegramEnv } from '../../src/scan/secrets.js';

beforeEach(() => {
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('loadAlchemyEnv', () => {
  it('prefers an already-set env var (no keychain read)', async () => {
    process.env.ALCHEMY_API_KEY = 'ENVKEY';
    let read = 0;
    const k = await loadAlchemyEnv(async () => { read++; return 'KCKEY'; });
    expect(k).toBe('ENVKEY');
    expect(read).toBe(0);
  });
  it('falls back to keychain and populates env', async () => {
    const k = await loadAlchemyEnv(async () => 'KCKEY');
    expect(k).toBe('KCKEY');
    expect(process.env.ALCHEMY_API_KEY).toBe('KCKEY');
  });
  it('throws if no key anywhere', async () => {
    await expect(loadAlchemyEnv(async () => null)).rejects.toThrow();
  });
});

describe('loadTelegramEnv', () => {
  it('sets token + Clement chat id', async () => {
    const ok = await loadTelegramEnv(async () => 'BOTTOKEN');
    expect(ok).toBe(true);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('BOTTOKEN');
    expect(process.env.TELEGRAM_CHAT_ID).toBe('735726338');
  });
  it('returns false if no token', async () => {
    expect(await loadTelegramEnv(async () => null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/secrets.test.ts`
Expected: FAIL — cannot find module `secrets.js`.

- [ ] **Step 3: Implement**

```ts
// src/scan/secrets.ts
import { execFile } from 'node:child_process';

export type SecretReader = (service: string) => Promise<string | null>;

// Reads a generic password from the macOS Keychain. Never logs the value.
export const keychainReader: SecretReader = (service) =>
  new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], (err, stdout) =>
      resolve(err ? null : stdout.trim() || null));
  });

const CLEMENT_CHAT_ID = '735726338';

export async function loadAlchemyEnv(read: SecretReader = keychainReader): Promise<string> {
  const fromEnv = process.env.ALCHEMY_API_KEY;
  if (fromEnv) return fromEnv;
  const k = await read('alchemy-api-key');
  if (!k) throw new Error('no Alchemy key: set ALCHEMY_API_KEY or add keychain item "alchemy-api-key"');
  process.env.ALCHEMY_API_KEY = k;
  return k;
}

export async function loadTelegramEnv(read: SecretReader = keychainReader): Promise<boolean> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    const t = await read('ophis-telegram-bot');
    if (!t) return false;
    process.env.TELEGRAM_BOT_TOKEN = t;
  }
  if (!process.env.TELEGRAM_CHAT_ID) process.env.TELEGRAM_CHAT_ID = CLEMENT_CHAT_ID;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/secrets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/src/scan/secrets.ts apps/rebate-indexer/tests/scan/secrets.test.ts
git commit -m "feat(scan): keychain->env secret loading (alchemy, telegram)"
```

---

### Task 12: `cli.ts` — orchestration + viem client wiring

**Files:**
- Modify: `apps/rebate-indexer/src/scan/cli.ts` (replace the stub)
- Create: `apps/rebate-indexer/src/scan/run.ts` (testable orchestrator, no process/viem coupling)
- Create: `apps/rebate-indexer/tests/scan/run.test.ts`

**Interfaces:**
- Consumes: every prior module.
- Produces:
  - `interface RunArgs { sinceSec: number; chains: ChainConfig[]; nowSec: number }`
  - `interface RunDeps { scanChain(cfg: ChainConfig): Promise<ScanResult>; enrich(swap: Swap): Promise<Swap> }`
  - `runScan(args: RunArgs, deps: RunDeps): Promise<{ swaps: Swap[]; coverage: Coverage[] }>` — runs chains in parallel (isolated), enriches, merges, sorts by tsUtc desc.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scan/run.test.ts
import { describe, it, expect } from 'vitest';
import { runScan } from '../../src/scan/run.js';
import type { ChainConfig, ScanResult, Swap } from '../../src/scan/types.js';

const cfg = (id: number, name: string): ChainConfig => ({ chainId: id, name, kind: 'rpc', alchemySubdomain: 'x' });
const swap = (chain: string, ts: string): Swap => ({
  chainId: 1, chainName: chain, tsUtc: ts, orderUid: '0x', txHash: null, owner: '0x', receiver: '0x',
  sell: { token: '0x', symbol: null, decimals: null, amount: '1' },
  buy: { token: '0x', symbol: null, decimals: null, amount: '1' },
  appCode: 'ophis', refCode: null, feeBps: 10, notionalUsd: null,
});

describe('runScan', () => {
  it('merges chains, sorts by tsUtc desc, isolates failures', async () => {
    const results: Record<string, ScanResult> = {
      a: { swaps: [swap('a', '2026-06-18T10:00:00Z')], coverage: { chainId: 1, chainName: 'a', status: 'ok', fillsScanned: 1, ophisFound: 1, unresolved: 0 } },
      b: { swaps: [swap('b', '2026-06-18T20:00:00Z')], coverage: { chainId: 2, chainName: 'b', status: 'ok', fillsScanned: 1, ophisFound: 1, unresolved: 0 } },
    };
    const out = await runScan(
      { sinceSec: 48 * 3600, chains: [cfg(1, 'a'), cfg(2, 'b')], nowSec: 1_800_000_000 },
      { scanChain: async (c) => results[c.name]!, enrich: async (s) => s },
    );
    expect(out.swaps.map((s) => s.chainName)).toEqual(['b', 'a']); // newest first
    expect(out.coverage).toHaveLength(2);
  });
  it('turns a thrown scanChain into a degraded coverage row', async () => {
    const out = await runScan(
      { sinceSec: 3600, chains: [cfg(1, 'a')], nowSec: 1_800_000_000 },
      { scanChain: async () => { throw new Error('boom'); }, enrich: async (s) => s },
    );
    expect(out.swaps).toHaveLength(0);
    expect(out.coverage[0]!.status).toBe('degraded');
    expect(out.coverage[0]!.error).toContain('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/run.test.ts`
Expected: FAIL — cannot find module `run.js`.

- [ ] **Step 3: Implement the orchestrator**

```ts
// src/scan/run.ts
import type { ChainConfig, Coverage, ScanResult, Swap } from './types.js';

export interface RunArgs {
  sinceSec: number;
  chains: ChainConfig[];
  nowSec: number;
}
export interface RunDeps {
  scanChain(cfg: ChainConfig): Promise<ScanResult>;
  enrich(swap: Swap): Promise<Swap>;
}

export async function runScan(args: RunArgs, deps: RunDeps): Promise<{ swaps: Swap[]; coverage: Coverage[] }> {
  const settled = await Promise.all(
    args.chains.map(async (cfg): Promise<ScanResult> => {
      try {
        return await deps.scanChain(cfg);
      } catch (err) {
        return {
          swaps: [],
          coverage: { chainId: cfg.chainId, chainName: cfg.name, status: 'degraded', fillsScanned: 0, ophisFound: 0, unresolved: 0, error: err instanceof Error ? err.message : String(err) },
        };
      }
    }),
  );
  const rawSwaps = settled.flatMap((r) => r.swaps);
  const swaps = await Promise.all(rawSwaps.map((s) => deps.enrich(s)));
  swaps.sort((a, b) => (a.tsUtc < b.tsUtc ? 1 : a.tsUtc > b.tsUtc ? -1 : 0));
  return { swaps, coverage: settled.map((r) => r.coverage) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/rebate-indexer && pnpm vitest run tests/scan/run.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the real entrypoint (replace cli.ts)**

```ts
// src/scan/cli.ts
import { createPublicClient, http } from 'viem';
import { notify } from '../telegram/alerter.js';
import { selectChains, resolveRpcUrl } from './chains.js';
import { parseSince } from './window.js';
import { loadCache } from './cache.js';
import { loadAlchemyEnv, loadTelegramEnv } from './secrets.js';
import { getOrder } from '../cow/client.js';
import { scanHostedChain, type LogClient } from './sources/onchain.js';
import { scanLocalDbChain } from './sources/localDb.js';
import { enrichSwap, type Erc20Reader } from './enrich.js';
import { runScan } from './run.js';
import { renderTable, telegramSummary, defaultJsonPath, writeJsonArtifact } from './report.js';
import type { ChainConfig, ScanResult, Swap } from './types.js';

function arg(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm scan --since <48h|2d|90m> [--chains a,b] [--telegram] [--json <path>]');
    return;
  }

  const sinceSec = parseSince(arg(args, 'since') ?? '48h');
  const chains = selectChains(arg(args, 'chains')?.split(','));
  const wantTelegram = args.includes('--telegram');
  const nowSec = Math.floor(Date.now() / 1000);
  const t0Sec = nowSec - sinceSec;
  const t0Iso = new Date(t0Sec * 1000).toISOString();

  const cache = await loadCache();
  const metaCache = new Map<string, { symbol: string | null; decimals: number | null }>();
  const refPriceCache = new Map<number, number>();

  // Only fetch the Alchemy key if at least one rpc chain is selected.
  const needsRpc = chains.some((c) => c.kind === 'rpc');
  const alchemyKey = needsRpc ? await loadAlchemyEnv() : '';
  const clients = new Map<number, ReturnType<typeof createPublicClient>>();
  const clientFor = (cfg: ChainConfig) => {
    let c = clients.get(cfg.chainId);
    if (!c) { c = createPublicClient({ transport: http(resolveRpcUrl(cfg, alchemyKey)) }); clients.set(cfg.chainId, c); }
    return c;
  };

  const scanChain = (cfg: ChainConfig): Promise<ScanResult> => {
    if (cfg.kind === 'local-db') return scanLocalDbChain(cfg, t0Iso);
    const client = clientFor(cfg) as unknown as LogClient;
    return scanHostedChain(cfg, t0Sec, { client, getOrder, cache });
  };

  const enrich = (swap: Swap): Promise<Swap> => {
    const cfg = chains.find((c) => c.chainId === swap.chainId);
    const reader = (cfg && cfg.kind === 'rpc') ? (clientFor(cfg) as unknown as Erc20Reader) : null;
    return enrichSwap(swap, { reader, metaCache, refPriceCache });
  };

  const { swaps, coverage } = await runScan({ sinceSec, chains, nowSec }, { scanChain, enrich });
  await cache.save();

  const windowLabel = `last ${arg(args, 'since') ?? '48h'}`;
  console.log(renderTable(swaps, coverage));

  const jsonPath = arg(args, 'json') ?? defaultJsonPath(new Date(nowSec * 1000).toISOString());
  await writeJsonArtifact(jsonPath, { window: windowLabel, generatedAt: new Date(nowSec * 1000).toISOString(), swaps, coverage });
  console.log(`\nJSON: ${jsonPath}`);

  if (wantTelegram) {
    if (await loadTelegramEnv()) {
      await notify(telegramSummary(swaps, coverage, windowLabel));
      console.log('Telegram: sent');
    } else {
      console.log('Telegram: skipped (no token in keychain/env)');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: Typecheck + full scan test suite**

Run: `cd apps/rebate-indexer && pnpm typecheck && pnpm vitest run tests/scan/`
Expected: typecheck clean; all scan tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/rebate-indexer/src/scan/run.ts apps/rebate-indexer/src/scan/cli.ts apps/rebate-indexer/tests/scan/run.test.ts
git commit -m "feat(scan): orchestrator + viem client wiring + CLI"
```

---

### Task 13: Defense-in-depth ignore + README + live verification

**Files:**
- Modify: `apps/rebate-indexer/.gitignore` (create if absent) — add `.scans/`
- Modify: `apps/rebate-indexer/README.md` — add a "Swap scan" section
- No new tests (live run is the acceptance check)

**Interfaces:** none new.

- [ ] **Step 1: Add the ignore entry**

Append to `apps/rebate-indexer/.gitignore`:

```
# scan artifacts (defense-in-depth; default output is ~/.ophis, out of repo)
.scans/
```

- [ ] **Step 2: Add README usage**

Append to `apps/rebate-indexer/README.md`:

````markdown
## Swap scan (exhaustive, allowlist-free)

Report every Ophis swap in a window across chains, independent of the rebate
wallet allowlist. Read-only: never touches the rebate DB.

```bash
# OP (local DB) + hosted majors via Alchemy, last 48h, also DM Clement:
pnpm scan --since 48h --telegram

# one chain, custom window, custom artifact path:
pnpm scan --since 2d --chains ethereum --json /tmp/eth.json
```

Discovery is on-chain (`getLogs(Trade)` on the Settlement contract) plus per-order
appData resolution via CoW's API. Self-hosted OP reads its local orderbook Postgres
directly. Secrets (`alchemy-api-key`, `ophis-telegram-bot`) come from the macOS
Keychain. JSON + cache default to `~/.ophis/` (out of repo). See
`docs/development/specs/2026-06-19-onchain-appdata-swap-scan-design.md`.
````

- [ ] **Step 3: Run the full package test + lint + typecheck**

Run: `cd apps/rebate-indexer && pnpm typecheck && pnpm lint && pnpm vitest run tests/scan/`
Expected: all green.

- [ ] **Step 4: Live verification (the original ask)**

Run: `cd apps/rebate-indexer && pnpm scan --since 48h`
Expected: the report lists the **OP** swap (0.02 WETH -> ~34.21 USDT) and, if still within window, the **mainnet** swap (0.041 ETH -> ~69.93 USDT); coverage shows `optimism OK` and the five hosted chains `OK` (or `DEGRADED` with a reason). Confirm the JSON artifact exists under `~/.ophis/scans/`.

> Note: "mainnet within window" depends on when this runs relative to 2026-06-18 20:43 UTC. If outside 48h, widen with `--since 5d` to reproduce both known swaps as a correctness check.

- [ ] **Step 5: Commit**

```bash
git add apps/rebate-indexer/.gitignore apps/rebate-indexer/README.md
git commit -m "docs(scan): gitignore artifacts + README usage"
```

---

## Self-Review

**1. Spec coverage:**
- Discovery via getLogs(Trade) -> Task 6/7. ✓
- Per-order appData attribution -> Task 2 (parse) + Task 6 (classify). ✓
- Self-hosted OP via local Postgres -> Task 8. ✓
- Hosted majors via Alchemy -> Task 4 (config) + Task 7 (driver) + Task 12 (wiring). ✓
- USD enrichment via pricer -> Task 9. ✓
- Terminal + JSON + Telegram outputs -> Task 10 + Task 12. ✓
- Out-of-repo artifacts + gitignore -> Task 10 (defaultJsonPath) + Task 13. ✓
- Per-chain isolation / coverage honesty -> Task 7, Task 8, Task 12 (runScan). ✓
- Persistent cache -> Task 5, used in Task 6/12. ✓
- Read-only (no rebate DB import) -> dedicated entrypoint, Task 1 + Task 12. ✓
- Secrets from keychain -> Task 11. ✓
- No new deps (viem reuse) -> Tasks 7/12. ✓
- Window->block binary search -> Task 3. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every test shows real assertions. ✓

**3. Type consistency:**
- `Swap` shape identical across Tasks 1, 6, 8, 9, 10, 12. ✓
- `ScanResult.coverage` matches `Coverage` everywhere. ✓
- `classifyFills`/`scanHostedChain` deps (`getOrder`, `cache`) match the real `cow/client.ts` `getOrder(chainId, uid)` signature. ✓
- `priceTrade(row, refPriceCache?)` call in Task 9 matches `pricer.ts` exactly (`{tradeUid, chainId, sellToken, sellAmount}`). ✓
- `notify(text)` call in Task 12 matches `telegram/alerter.ts`. ✓

No gaps found.
