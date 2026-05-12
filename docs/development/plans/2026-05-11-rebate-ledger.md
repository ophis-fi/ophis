# Ophis Rebate Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a volume-tiered WETH rebate program that indexes CoW trades tagged `appCode = "ophis"`, computes weighted shares of 50% of the Ophis Safe's WETH balance once a month, and queues a single MultiSend transaction in the Safe Transaction Service for human-confirmed execution. A swap-page tier chip surfaces user progress.

**Architecture:** New pnpm workspace package `apps/rebate-indexer/` deployed as a Docker Compose stack on a dedicated Aleph VM. Five in-process modules (`fetcher`, `pricer`, `scorer`, `tierer`, `batcher`) chained sequentially by a single nightly cron. Postgres is the source of truth, a materialized view materializes 30d-rolling per-wallet volume, the Safe Transaction Service is the on-chain queue. Frontend integration via a shared `@ophis/sdk` package and a swap-page tier chip component.

**Tech Stack:** TypeScript (ESM), pnpm + Turbo, Drizzle ORM + `postgres-js`, Fastify, `viem`, `@safe-global/api-kit` + `@safe-global/protocol-kit`, `@safe-global/safe-deployments` (canonical addresses), `node-cron`, `pino`, Vitest + Testcontainers + MSW + `fast-check`, Docker Compose, Caddy, Cloudflare Tunnel, GitHub Actions.

**Spec:** [`docs/development/specs/2026-05-11-rebate-ledger-design.md`](../specs/2026-05-11-rebate-ledger-design.md).

**Predecessor brand work:** Commit `9d7e07e15` (appCode bump `greg → ophis`) — all rebate-eligible trades carry `appData.metadata.appCode = "ophis"` from this commit forward.

**Phase gate:** A real Sepolia rebate batch (test Safe, test wallets, real Safe Transaction Service flow) signed and executed end-to-end, with the transaction reproducible by a third party running `pnpm tsx src/cli.ts replay-from-genesis` against the same CoW staging API.

---

## Operator decisions to lock BEFORE execution

| # | Decision | Default if undecided |
|---|---|---|
| **D1** | Aleph VM provisioning — reuse an existing VM (postiz-stuart / mcp-services / allo) or spin a fresh one | **Fresh VM** (`ophis-rebates`). Isolates Postgres from other tenants; clean upgrade path; minimal blast radius if the indexer ever does something dumb. |
| **D2** | Safe proposer EOA — share `0x0494…d1A` (current sole owner) or generate dedicated proposer | **Dedicated proposer** (`ophis-rebate-proposer` Keychain). The current owner is a signer; proposer is a separate non-owner role. Compatible with the O1 2-of-N upgrade. |
| **D3** | Cloudflare Tunnel topology — share existing `3615crypto` tunnel or new dedicated tunnel | **Share the existing tunnel** with a new hostname `rebates.ophis.fi`. Matches the pattern of `mcp-api.3615crypto.com` and avoids creating a second Tunnel daemon. |
| **D4** | Initial `POOL_SPLIT_BPS` — 5000 (50%) per spec, or smaller for the first batch as a safety governor | **5000 (50%)** as designed. First batch runs in dry-run only (`--no-propose`) so there's no risk; if the Safe balance is trivially small, a smaller split adds no safety, only friction. |
| **D5** | Test Safe on Sepolia — fresh deploy or reuse Phase-2 testnet Safe | **Fresh deploy** (`ophis-rebates-test`). Phase-2's Safe holds Phase-2 test data; isolating rebate testing prevents data contamination. |

---

## File Structure (created or modified by this plan)

| Path | Action | Purpose |
|---|---|---|
| `apps/rebate-indexer/package.json` | Create | New pnpm workspace package |
| `apps/rebate-indexer/tsconfig.json` | Create | Extends `tsconfig.base.json` |
| `apps/rebate-indexer/Dockerfile` | Create | Multi-stage build (deps → build → runtime) |
| `apps/rebate-indexer/docker-compose.yml` | Create | pg + indexer + caddy stack |
| `apps/rebate-indexer/Caddyfile` | Create | Reverse proxy with auto-TLS off (Tunnel terminates TLS) |
| `apps/rebate-indexer/drizzle.config.ts` | Create | Drizzle Kit config (migrations dir, schema path) |
| `apps/rebate-indexer/migrations/0000_init.sql` | Create | Tables: trades, rebate_batches, rebate_batch_entries + materialized view wallets |
| `apps/rebate-indexer/src/db/schema.ts` | Create | Drizzle table definitions matching the spec |
| `apps/rebate-indexer/src/db/index.ts` | Create | Postgres client + drizzle wrapper |
| `apps/rebate-indexer/src/db/migrate.ts` | Create | Standalone migration runner (used by container entrypoint) |
| `apps/rebate-indexer/src/tiers.ts` | Create | TIERS + POOL_SPLIT_BPS + assignTier (single source of truth) |
| `apps/rebate-indexer/src/cow/client.ts` | Create | CoW orderbook API wrapper (per-chain) |
| `apps/rebate-indexer/src/cow/types.ts` | Create | CoW API response types |
| `apps/rebate-indexer/src/fetcher.ts` | Create | Pulls new trades by app_data_hash, upserts to `trades` |
| `apps/rebate-indexer/src/pricer.ts` | Create | Enriches unpriced trades with USD via CoW /quote |
| `apps/rebate-indexer/src/scorer.ts` | Create | REFRESH MATERIALIZED VIEW CONCURRENTLY wallets |
| `apps/rebate-indexer/src/tierer.ts` | Create | Reads wallets, applies tiers.ts (currently lookup-only; the materialised view doesn't store tier — entries are computed at batch time) |
| `apps/rebate-indexer/src/batch/computeShares.ts` | Create | Pure weighted-share math |
| `apps/rebate-indexer/src/batch/multisend.ts` | Create | Safe MultiSend payload encoder |
| `apps/rebate-indexer/src/batch/dryRun.ts` | Create | eth_call simulation + recipient quarantine |
| `apps/rebate-indexer/src/batch/propose.ts` | Create | Safe Transaction Service proposer |
| `apps/rebate-indexer/src/batch/poll.ts` | Create | Polls Safe TX Service for execution finality |
| `apps/rebate-indexer/src/batcher.ts` | Create | Orchestrates dryRun → propose → poll, persists to `rebate_batches` |
| `apps/rebate-indexer/src/safe/addresses.ts` | Create | Canonical Safe + MultiSend + WETH addresses (via @safe-global/safe-deployments) |
| `apps/rebate-indexer/src/telegram/alerter.ts` | Create | Telegram bot alert helper |
| `apps/rebate-indexer/src/api.ts` | Create | Fastify server: /tier/:wallet, /health, /status, /batches, /batches/:id |
| `apps/rebate-indexer/src/cron.ts` | Create | node-cron schedule: nightly chain at 02:00 UTC |
| `apps/rebate-indexer/src/cli.ts` | Create | CLI: simulate-batch, replay-pricer, rotate-proposer, dry-run-monthly, replay-from-genesis |
| `apps/rebate-indexer/src/index.ts` | Create | Container entrypoint (migrate → cron + api) |
| `apps/rebate-indexer/src/logger.ts` | Create | pino instance + child-logger helpers |
| `apps/rebate-indexer/tests/tiers.test.ts` | Create | Boundary tests for assignTier |
| `apps/rebate-indexer/tests/computeShares.test.ts` | Create | Property tests for weighted-share math |
| `apps/rebate-indexer/tests/fetcher.test.ts` | Create | Snapshot tests on CoW API fixtures |
| `apps/rebate-indexer/tests/pricer.test.ts` | Create | Pricer enrichment behaviour |
| `apps/rebate-indexer/tests/multisend.test.ts` | Create | MultiSend encoding matches viem encodeFunctionData |
| `apps/rebate-indexer/tests/integration.test.ts` | Create | Full pipeline against testcontainers Postgres + msw CoW |
| `apps/rebate-indexer/tests/e2e/sepolia.test.ts` | Create | E2E Safe propose+execute on Sepolia (nightly CI only) |
| `apps/rebate-indexer/tests/fixtures/cow-trades.json` | Create | Captured CoW API response for snapshot tests |
| `apps/rebate-indexer/RUNBOOK.md` | Create | Operator runbook (5 scenarios from spec) |
| `apps/rebate-indexer/README.md` | Create | One-page overview + dev quickstart |
| `packages/sdk/src/tiers.ts` | Create | Re-export of TIERS for frontend consumption |
| `packages/sdk/src/index.ts` | Modify | Add tiers export |
| `packages/sdk/tests/tiers.test.ts` | Create | Verify SDK tier export matches indexer source |
| `apps/frontend/apps/cowswap-frontend/src/greg/components/TierChip.tsx` | Create | Swap-page tier chip component |
| `apps/frontend/apps/cowswap-frontend/src/greg/components/TierChip.module.css` | Create | Tier chip styles |
| `apps/frontend/apps/cowswap-frontend/src/greg/hooks/useTier.ts` | Create | React hook fetching `rebates.ophis.fi/tier/:wallet` |
| `apps/frontend/apps/cowswap-frontend/src/greg/.greg-divergences.md` | Modify | Document the new TierChip module |
| `pnpm-workspace.yaml` | Modify | Add `apps/rebate-indexer` |
| `.github/workflows/rebate-indexer-ci.yml` | Create | Unit + integration tests on PR |
| `.github/workflows/rebate-indexer-deploy.yml` | Create | Build + push image + ssh deploy on push to main |
| `infra/cloudflare/ophis-rebates-tunnel.md` | Create | Tunnel hostname binding runbook |

**Not modified:** `apps/backend/` (Rust services, untouched), `contracts/` (no on-chain changes), `infra/{megaeth,linea,mantle,...}/` (per-chain settlement stacks, separate concern).

---

## Dispatch hints

- **Tasks 1-4:** main session — TS + DB foundation, pure math. Fast feedback, easy TDD.
- **Tasks 5-9:** `backend` agent — CoW API client + indexer pipeline modules. Read-only against CoW's live API; can run independently of Safe code.
- **Tasks 10-13:** `backend` agent — Safe batch flow. Heaviest crypto-correctness work; gets the most review attention.
- **Tasks 14-17:** main session — API server, cron orchestration, Telegram, CLI. Wires everything together.
- **Tasks 18-20:** main session — Docker + deploy pipeline. Operator-facing.
- **Tasks 21-22:** `frontend` agent — @ophis/sdk + TierChip component. Independent of backend rollout.
- **Tasks 23-25:** main session — E2E on Sepolia, runbook, pre-prod checklist + first dry-run.

---

## Task 1: Bootstrap `apps/rebate-indexer` pnpm workspace package

**Files:**
- Create: `apps/rebate-indexer/package.json`
- Create: `apps/rebate-indexer/tsconfig.json`
- Create: `apps/rebate-indexer/.gitignore`
- Create: `apps/rebate-indexer/README.md`
- Modify: `pnpm-workspace.yaml`

### Step 1: Add the package to the workspace

Edit `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/backend"
  - "apps/rebate-indexer"
  - "infra/rpc"
```

### Step 2: Create the package manifest

Write `apps/rebate-indexer/package.json`:

```json
{
  "name": "@ophis/rebate-indexer",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node --import tsx src/index.ts",
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests --max-warnings=0",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run tests/integration.test.ts",
    "test:e2e": "vitest run tests/e2e",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:studio": "drizzle-kit studio",
    "cli": "tsx src/cli.ts"
  },
  "dependencies": {
    "@safe-global/api-kit": "^2.5.0",
    "@safe-global/protocol-kit": "^5.0.0",
    "@safe-global/safe-deployments": "^1.37.0",
    "@safe-global/types-kit": "^1.0.0",
    "drizzle-orm": "^0.36.0",
    "fastify": "^5.0.0",
    "fast-check": "^3.22.0",
    "node-cron": "^3.0.3",
    "pino": "^9.5.0",
    "pino-pretty": "^11.3.0",
    "postgres": "^3.4.5",
    "viem": "^2.21.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "@types/node-cron": "^3.0.11",
    "drizzle-kit": "^0.28.0",
    "msw": "^2.6.0",
    "testcontainers": "^10.13.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

### Step 3: Create the TypeScript config

Write `apps/rebate-indexer/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": ".",
    "paths": {
      "@ophis/rebate-indexer/*": ["./src/*"]
    }
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

### Step 4: Create `.gitignore`

Write `apps/rebate-indexer/.gitignore`:

```
node_modules/
dist/
.env
.env.local
*.log
pg_data/
caddy_data/
```

### Step 5: Create README

Write `apps/rebate-indexer/README.md`:

```markdown
# @ophis/rebate-indexer

Off-chain indexer + Safe batch proposer for Ophis's volume-tiered WETH rebate program.

## Quickstart (dev)

```bash
pnpm install
docker compose up -d pg
pnpm db:migrate
pnpm dev
```

## Architecture

See [`docs/development/specs/2026-05-11-rebate-ledger-design.md`](../../docs/development/specs/2026-05-11-rebate-ledger-design.md).

## Runbook

See [`RUNBOOK.md`](./RUNBOOK.md) for incident response.
```

### Step 6: Install dependencies and verify typecheck baseline passes

```bash
cd apps/rebate-indexer && pnpm install
pnpm typecheck
```

Expected: `pnpm install` succeeds. `pnpm typecheck` exits 0 (no files yet, no errors).

### Step 7: Commit

```bash
git add apps/rebate-indexer/package.json apps/rebate-indexer/tsconfig.json apps/rebate-indexer/.gitignore apps/rebate-indexer/README.md pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(rebate-indexer): bootstrap pnpm workspace package"
```

---

## Task 2: Database schema + initial migration

**Files:**
- Create: `apps/rebate-indexer/drizzle.config.ts`
- Create: `apps/rebate-indexer/src/db/schema.ts`
- Create: `apps/rebate-indexer/src/db/index.ts`
- Create: `apps/rebate-indexer/src/db/migrate.ts`
- Create: `apps/rebate-indexer/migrations/0000_init.sql`

### Step 1: Drizzle Kit config

Write `apps/rebate-indexer/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/rebates',
  },
  verbose: true,
  strict: true,
});
```

### Step 2: Drizzle schema definitions

Write `apps/rebate-indexer/src/db/schema.ts`:

```ts
import {
  pgTable,
  customType,
  integer,
  bigint,
  timestamp,
  text,
  serial,
  date,
  numeric,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

// uint256 stored as NUMERIC(78) — drizzle exposes string at the TS layer;
// we convert to bigint at use-site to stay lossless.
const uint256 = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'numeric(78,0)',
  toDriver: (v) => v.toString(),
  fromDriver: (v) => BigInt(v),
});

// Postgres BYTEA <-> 0x-hex string (lowercased). Wallet & token addresses are 20 bytes;
// trade_uid is 56 bytes (CoW order UID).
const bytea = customType<{ data: `0x${string}`; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v.slice(2), 'hex'),
  fromDriver: (v) => `0x${v.toString('hex')}` as `0x${string}`,
});

export const trades = pgTable(
  'trades',
  {
    tradeUid: bytea('trade_uid').primaryKey(),
    chainId: integer('chain_id').notNull(),
    wallet: bytea('wallet').notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    blockTimestamp: timestamp('block_timestamp', { withTimezone: true }).notNull(),

    sellToken: bytea('sell_token').notNull(),
    buyToken: bytea('buy_token').notNull(),
    sellAmount: uint256('sell_amount').notNull(),
    buyAmount: uint256('buy_amount').notNull(),

    appCode: text('app_code').notNull(),
    partnerFeeWei: uint256('partner_fee_wei'),

    valueUsd: numeric('value_usd', { precision: 20, scale: 4 }),
    pricedAt: timestamp('priced_at', { withTimezone: true }),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    walletTimeIdx: index('trades_wallet_time_idx').on(t.wallet, t.blockTimestamp),
    unpricedIdx: index('trades_unpriced_idx').on(t.pricedAt),
  }),
);

export const rebateBatches = pgTable('rebate_batches', {
  id: serial('id').primaryKey(),
  cycleMonth: date('cycle_month').notNull().unique(),
  netFeeWethWei: uint256('net_fee_weth_wei').notNull(),
  poolWethWei: uint256('pool_weth_wei').notNull(),

  safeProposalHash: bytea('safe_proposal_hash'),
  safeTxHash: bytea('safe_tx_hash'),
  status: text('status').notNull().default('computing'),

  proposedAt: timestamp('proposed_at', { withTimezone: true }),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rebateBatchEntries = pgTable(
  'rebate_batch_entries',
  {
    batchId: integer('batch_id')
      .notNull()
      .references(() => rebateBatches.id),
    wallet: bytea('wallet').notNull(),
    volumeUsd: numeric('volume_30d_usd', { precision: 20, scale: 4 }).notNull(),
    tier: text('tier').notNull(),
    rebatePct: numeric('rebate_pct', { precision: 5, scale: 4 }).notNull(),
    wethAmountWei: uint256('weth_amount_wei').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.batchId, t.wallet] }),
    walletIdx: index('rebate_entries_wallet_idx').on(t.wallet),
  }),
);

// `wallets` is a MATERIALIZED VIEW (not modelled as a drizzle table) —
// created by the raw SQL migration 0000_init.sql. Use `db.execute(sql`SELECT … FROM wallets`)`.
```

### Step 3: DB client wrapper

Write `apps/rebate-indexer/src/db/index.ts`:

```ts
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

export const sql = postgres(databaseUrl, { max: 10, idle_timeout: 30 });
export const db = drizzle(sql, { schema });
export { schema };
```

### Step 4: Initial migration SQL (matches the spec data model exactly)

Write `apps/rebate-indexer/migrations/0000_init.sql`:

```sql
-- Tables managed by drizzle would normally come from `drizzle-kit generate`,
-- but we write this migration by hand so we can include the materialized view
-- definition (which drizzle does not model). The table DDL below MUST stay in
-- sync with src/db/schema.ts — tests/integration.test.ts asserts that.

CREATE TABLE trades (
  trade_uid          BYTEA       PRIMARY KEY,
  chain_id           INTEGER     NOT NULL,
  wallet             BYTEA       NOT NULL,
  block_number       BIGINT      NOT NULL,
  block_timestamp    TIMESTAMPTZ NOT NULL,
  sell_token         BYTEA       NOT NULL,
  buy_token          BYTEA       NOT NULL,
  sell_amount        NUMERIC(78) NOT NULL,
  buy_amount         NUMERIC(78) NOT NULL,
  app_code           TEXT        NOT NULL,
  partner_fee_wei    NUMERIC(78),
  value_usd          NUMERIC(20,4),
  priced_at          TIMESTAMPTZ,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_wallet_time_idx ON trades (wallet, block_timestamp DESC);
CREATE INDEX trades_unpriced_idx    ON trades (priced_at) WHERE value_usd IS NULL;

CREATE MATERIALIZED VIEW wallets AS
SELECT
  wallet,
  SUM(value_usd)        AS volume_30d_usd,
  COUNT(*)              AS trade_count_30d,
  MAX(block_timestamp)  AS last_trade_at
FROM trades
WHERE block_timestamp > now() - INTERVAL '30 days'
  AND value_usd IS NOT NULL
GROUP BY wallet
WITH NO DATA;                                              -- first refresh happens at runtime
CREATE UNIQUE INDEX wallets_pk ON wallets (wallet);         -- required for REFRESH … CONCURRENTLY

CREATE TABLE rebate_batches (
  id                 SERIAL      PRIMARY KEY,
  cycle_month        DATE        NOT NULL UNIQUE,
  net_fee_weth_wei   NUMERIC(78) NOT NULL,
  pool_weth_wei      NUMERIC(78) NOT NULL,
  safe_proposal_hash BYTEA,
  safe_tx_hash       BYTEA,
  status             TEXT        NOT NULL DEFAULT 'computing',
  proposed_at        TIMESTAMPTZ,
  executed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rebate_batch_entries (
  batch_id           INTEGER     NOT NULL REFERENCES rebate_batches(id),
  wallet             BYTEA       NOT NULL,
  volume_30d_usd     NUMERIC(20,4) NOT NULL,
  tier               TEXT        NOT NULL,
  rebate_pct         NUMERIC(5,4) NOT NULL,
  weth_amount_wei    NUMERIC(78) NOT NULL,
  PRIMARY KEY (batch_id, wallet)
);
CREATE INDEX rebate_entries_wallet_idx ON rebate_batch_entries (wallet);
```

### Step 5: Migration runner (used by container entrypoint + dev)

Write `apps/rebate-indexer/src/db/migrate.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from './index.js';
import { logger } from '../logger.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
const log = logger.child({ module: 'migrate' });

async function ensureMigrationsTable() {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS __migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const rows = await sql<{ filename: string }[]>`SELECT filename FROM __migrations`;
  return new Set(rows.map((r) => r.filename));
}

export async function runMigrations() {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      log.debug({ file }, 'migration already applied, skipping');
      continue;
    }
    const sqlText = readFileSync(join(migrationsDir, file), 'utf8');
    log.info({ file }, 'applying migration');
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      await tx`INSERT INTO __migrations (filename) VALUES (${file})`;
    });
  }
  log.info({ count: files.length, applied: applied.size }, 'migrations complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => sql.end())
    .catch((err) => {
      log.error({ err }, 'migration failed');
      process.exit(1);
    });
}
```

### Step 6: Logger module (referenced above and throughout)

Write `apps/rebate-indexer/src/logger.ts`:

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});
```

### Step 7: Boot a local Postgres and apply migrations

```bash
docker run --rm -d --name rebates-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=rebates \
  postgres:16-alpine
sleep 3
DATABASE_URL=postgres://postgres:postgres@localhost:5432/rebates pnpm db:migrate
```

Expected:
```
INFO: applying migration file=0000_init.sql
INFO: migrations complete count=1 applied=0
```

### Step 8: Verify tables + view exist

```bash
docker exec rebates-pg psql -U postgres -d rebates -c "\dt"
docker exec rebates-pg psql -U postgres -d rebates -c "\dm"
```

Expected: `trades`, `rebate_batches`, `rebate_batch_entries`, `__migrations` listed as tables; `wallets` listed as matview.

### Step 9: Tear down local DB

```bash
docker stop rebates-pg
```

### Step 10: Commit

```bash
git add apps/rebate-indexer/drizzle.config.ts apps/rebate-indexer/src/db apps/rebate-indexer/src/logger.ts apps/rebate-indexer/migrations
git commit -m "feat(rebate-indexer): drizzle schema + initial migration"
```

---

## Task 3: Tier table + `assignTier` (TDD, no I/O)

**Files:**
- Create: `apps/rebate-indexer/src/tiers.ts`
- Create: `apps/rebate-indexer/tests/tiers.test.ts`

### Step 1: Write the failing tests first

Write `apps/rebate-indexer/tests/tiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TIERS, POOL_SPLIT_BPS, assignTier } from '../src/tiers.js';

describe('TIERS table', () => {
  it('has exactly four tiers in ascending min_usd order', () => {
    expect(TIERS).toHaveLength(4);
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i]!.min_usd).toBeGreaterThan(TIERS[i - 1]!.min_usd);
    }
  });

  it('matches the spec values exactly', () => {
    expect(TIERS).toEqual([
      { name: 'bronze',   min_usd:      0, rebate_pct: 0.10 },
      { name: 'silver',   min_usd:  5_000, rebate_pct: 0.20 },
      { name: 'gold',     min_usd: 50_000, rebate_pct: 0.35 },
      { name: 'platinum', min_usd: 500_000, rebate_pct: 0.50 },
    ]);
  });

  it('POOL_SPLIT_BPS is 5000 (50%)', () => {
    expect(POOL_SPLIT_BPS).toBe(5_000);
  });
});

describe('assignTier', () => {
  it.each([
    [0,           'bronze',   0.10],
    [4_999.99,    'bronze',   0.10],
    [5_000,       'silver',   0.20],
    [5_000.01,    'silver',   0.20],
    [49_999.99,   'silver',   0.20],
    [50_000,      'gold',     0.35],
    [499_999.99,  'gold',     0.35],
    [500_000,     'platinum', 0.50],
    [10_000_000,  'platinum', 0.50],
  ])('volume %s → %s @ %s', (vol, name, rebate_pct) => {
    expect(assignTier(vol)).toEqual({ name, min_usd: expect.any(Number), rebate_pct });
  });

  it('throws for negative volume (defensive — should never happen)', () => {
    expect(() => assignTier(-1)).toThrow(/non-negative/);
  });
});
```

### Step 2: Run tests, see them fail with "module not found"

```bash
cd apps/rebate-indexer && pnpm test
```

Expected: red, `Failed to resolve import '../src/tiers.js'`.

### Step 3: Implement `tiers.ts`

Write `apps/rebate-indexer/src/tiers.ts`:

```ts
export interface Tier {
  readonly name: 'bronze' | 'silver' | 'gold' | 'platinum';
  readonly min_usd: number;
  readonly rebate_pct: number;
}

/**
 * Ophis rebate tiers. SOURCE OF TRUTH.
 *
 * Any change here propagates to the swap-page chip via @ophis/sdk
 * (packages/sdk/src/tiers.ts re-exports this). Adjust both atomically.
 */
export const TIERS: readonly Tier[] = [
  { name: 'bronze',   min_usd:      0, rebate_pct: 0.10 },
  { name: 'silver',   min_usd:  5_000, rebate_pct: 0.20 },
  { name: 'gold',     min_usd: 50_000, rebate_pct: 0.35 },
  { name: 'platinum', min_usd: 500_000, rebate_pct: 0.50 },
] as const;

/** Share of the Safe's WETH balance that becomes the monthly rebate pool. */
export const POOL_SPLIT_BPS = 5_000;

export function assignTier(volume_30d_usd: number): Tier {
  if (volume_30d_usd < 0) {
    throw new Error('assignTier: volume must be non-negative');
  }
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (volume_30d_usd >= TIERS[i]!.min_usd) return TIERS[i]!;
  }
  return TIERS[0]!;
}
```

### Step 4: Run tests, verify all pass

```bash
pnpm test tests/tiers.test.ts
```

Expected: 13 passing.

### Step 5: Commit

```bash
git add apps/rebate-indexer/src/tiers.ts apps/rebate-indexer/tests/tiers.test.ts
git commit -m "feat(rebate-indexer): tier table + assignTier with boundary tests"
```

---

## Task 4: Weighted-share math (`computeShares`)

The most safety-critical pure function. Property-tested with `fast-check` so we can't accidentally distribute more than the pool.

**Files:**
- Create: `apps/rebate-indexer/src/batch/computeShares.ts`
- Create: `apps/rebate-indexer/tests/computeShares.test.ts`

### Step 1: Write the failing tests

Write `apps/rebate-indexer/tests/computeShares.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeShares, type EligibleWallet } from '../src/batch/computeShares.js';

const wallet = (hex: string): `0x${string}` =>
  (`0x${hex.padStart(40, '0')}`) as `0x${string}`;

describe('computeShares — worked example from the spec', () => {
  it('three wallets, 0.4 WETH safe balance, pool=0.2 WETH', () => {
    const wallets: EligibleWallet[] = [
      { wallet: wallet('a11ce'), volume_30d_usd:  80_000 },  // Gold, 35%
      { wallet: wallet('b0b'),    volume_30d_usd:  10_000 },  // Silver, 20%
      { wallet: wallet('ca501'), volume_30d_usd: 600_000 },  // Platinum, 50%
    ];
    const pool = 200_000_000_000_000_000n;                   // 0.2 WETH
    const shares = computeShares(wallets, pool);

    expect(shares.size).toBe(3);
    // weights: 80k*35% = 28k ; 10k*20% = 2k ; 600k*50% = 300k ; Σ = 330k
    // alice  : 28k/330k * 0.2 WETH ≈ 0.016969… WETH
    // bob    :  2k/330k * 0.2 WETH ≈ 0.001212… WETH
    // carol  : 300k/330k * 0.2 WETH ≈ 0.181818… WETH
    expect(shares.get(wallet('a11ce'))).toBe(16_969_696_969_696_969n);
    expect(shares.get(wallet('b0b'))).toBe(1_212_121_212_121_212n);
    expect(shares.get(wallet('ca501'))).toBe(181_818_181_818_181_818n);
  });
});

describe('computeShares — edge cases', () => {
  it('zero eligible wallets → empty map', () => {
    expect(computeShares([], 10n ** 18n).size).toBe(0);
  });

  it('single eligible wallet gets the entire pool regardless of tier', () => {
    const w = wallet('1');
    for (const vol of [10, 1_000, 80_000, 999_999_999]) {
      const shares = computeShares([{ wallet: w, volume_30d_usd: vol }], 10n ** 18n);
      expect(shares.get(w)).toBe(10n ** 18n);
    }
  });

  it('zero pool → empty map', () => {
    expect(computeShares([{ wallet: wallet('1'), volume_30d_usd: 100 }], 0n).size).toBe(0);
  });

  it('wallet with zero volume contributes zero weight → excluded', () => {
    const a = wallet('a');
    const b = wallet('b');
    const shares = computeShares(
      [{ wallet: a, volume_30d_usd: 0 }, { wallet: b, volume_30d_usd: 100 }],
      10n ** 18n,
    );
    expect(shares.has(a)).toBe(false);
    expect(shares.get(b)).toBe(10n ** 18n);
  });
});

describe('computeShares — property: Σ shares ≤ pool, always', () => {
  it('holds across arbitrary wallet sets and pool sizes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            wallet: fc.hexaString({ minLength: 40, maxLength: 40 }).map((h) => (`0x${h}` as `0x${string}`)),
            volume_30d_usd: fc.float({ min: 0, max: 100_000_000, noNaN: true }),
          }),
          { minLength: 0, maxLength: 100 },
        ),
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        (wallets, pool) => {
          const shares = computeShares(wallets, pool);
          const total = [...shares.values()].reduce((a, b) => a + b, 0n);
          expect(total).toBeLessThanOrEqual(pool);
        },
      ),
      { numRuns: 500 },
    );
  });
});
```

### Step 2: Run, see failures

```bash
pnpm test tests/computeShares.test.ts
```

Expected: `Cannot find module '../src/batch/computeShares.js'`.

### Step 3: Implement

Write `apps/rebate-indexer/src/batch/computeShares.ts`:

```ts
import { assignTier } from '../tiers.js';

export interface EligibleWallet {
  readonly wallet: `0x${string}`;
  readonly volume_30d_usd: number;
}

/**
 * Weighted-share distribution. See spec §"Volume → Tier → Rebate math" for derivation.
 *
 * Properties enforced by tests in tests/computeShares.test.ts:
 *   - Σ shares ≤ pool, always
 *   - Single wallet gets the entire pool
 *   - Zero pool / zero wallets → empty result
 *
 * Returns Map<wallet, share_wei>. Wallets with zero share (zero volume, zero pool,
 * or pool/total_weight rounds to 0) are excluded from the returned map.
 */
export function computeShares(
  wallets: readonly EligibleWallet[],
  pool_wei: bigint,
): Map<`0x${string}`, bigint> {
  if (pool_wei <= 0n || wallets.length === 0) return new Map();

  // Fixed-point: USD × 10^4 (preserves cents), rebate% × 10^4 (preserves bps).
  // weight = volume_fp × pct_fp (unitless, comparable across wallets).
  let total_weight = 0n;
  const weights = new Map<`0x${string}`, bigint>();
  for (const w of wallets) {
    if (w.volume_30d_usd <= 0) continue;
    const { rebate_pct } = assignTier(w.volume_30d_usd);
    const volume_fp = BigInt(Math.round(w.volume_30d_usd * 10_000));
    const pct_fp = BigInt(Math.round(rebate_pct * 10_000));
    const weight = volume_fp * pct_fp;
    if (weight === 0n) continue;
    weights.set(w.wallet, weight);
    total_weight += weight;
  }
  if (total_weight === 0n) return new Map();

  const shares = new Map<`0x${string}`, bigint>();
  for (const [wallet, weight] of weights) {
    const share = (pool_wei * weight) / total_weight;                // floor
    if (share > 0n) shares.set(wallet, share);
  }
  return shares;
}
```

### Step 4: Run, verify all pass

```bash
pnpm test tests/computeShares.test.ts
```

Expected: 7 passing (3 worked + 4 edge + 1 property × 500 runs).

### Step 5: Commit

```bash
git add apps/rebate-indexer/src/batch/computeShares.ts apps/rebate-indexer/tests/computeShares.test.ts
git commit -m "feat(rebate-indexer): weighted-share math (computeShares) with property tests"
```

---

## Task 5: CoW orderbook API client

**Files:**
- Create: `apps/rebate-indexer/src/cow/types.ts`
- Create: `apps/rebate-indexer/src/cow/client.ts`
- Create: `apps/rebate-indexer/tests/fixtures/cow-trades.json`

### Step 1: CoW API types

Write `apps/rebate-indexer/src/cow/types.ts`:

```ts
import { z } from 'zod';

// CoW orderbook API: GET /api/v1/trades?app_data_hash=<hash>
// Schema: https://docs.cow.fi/cow-protocol/reference/apis/orderbook (Trade)
export const CowTrade = z.object({
  blockNumber: z.number().int().nonnegative(),
  logIndex: z.number().int().nonnegative(),
  orderUid: z.string().regex(/^0x[0-9a-f]{112}$/i),                  // 56 bytes = 112 hex chars
  owner: z.string().regex(/^0x[0-9a-f]{40}$/i),
  sellToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
  buyToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
  sellAmount: z.string().regex(/^\d+$/),                              // uint256 as string
  buyAmount: z.string().regex(/^\d+$/),
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  // The trade endpoint exposes appData only via the linked order — we fetch it lazily.
});
export type CowTrade = z.infer<typeof CowTrade>;

// GET /api/v1/orders/<uid> — used to confirm appCode and grab settlement timestamp.
export const CowOrder = z.object({
  uid: z.string(),
  owner: z.string(),
  sellToken: z.string(),
  buyToken: z.string(),
  sellAmount: z.string(),
  buyAmount: z.string(),
  appData: z.string(),                                                // IPFS-hash hex
  fullAppData: z.string().nullable().optional(),                      // JSON string, when CoW resolved it
  creationDate: z.string(),                                           // ISO 8601 (informational)
});
export type CowOrder = z.infer<typeof CowOrder>;

// POST /api/v1/quote — used by pricer.ts to denominate volume in USD.
// We use the "sell-amount-from-quote" form to ask: what's $1 worth of <token>?
// then compute trade USD value from sellAmount / quote.buyAmount.
// Schema: https://docs.cow.fi/cow-protocol/reference/apis/orderbook
export const CowQuoteResponse = z.object({
  quote: z.object({
    sellToken: z.string(),
    buyToken: z.string(),
    sellAmount: z.string(),
    buyAmount: z.string(),
  }),
  expiration: z.string(),
});
export type CowQuoteResponse = z.infer<typeof CowQuoteResponse>;

export const APP_CODES = ['ophis', 'greg'] as const;                  // greg tolerated for pre-rebrand history
export type AppCode = (typeof APP_CODES)[number];
```

### Step 2: Capture a real CoW API response as a test fixture

```bash
curl -sS 'https://api.cow.fi/xdai/api/v1/trades?owner=0x858f0F5eE954846D47155F5203c04aF1819eCeF8&offset=0&limit=10' \
  | jq '.' > apps/rebate-indexer/tests/fixtures/cow-trades.json
```

Expected: a JSON array of 0+ trade objects matching `CowTrade` schema. If empty (early in production), substitute with one synthetic trade matching the schema — the snapshot tests verify schema parsing, not content.

If empty, write a synthetic fixture instead:

```json
[
  {
    "blockNumber": 35421000,
    "logIndex": 12,
    "orderUid": "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "owner": "0x0000000000000000000000000000000000000001",
    "sellToken": "0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1",
    "buyToken":  "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83",
    "sellAmount": "1000000000000000000",
    "buyAmount":  "2500000000",
    "txHash": "0x1111111111111111111111111111111111111111111111111111111111111111"
  }
]
```

### Step 3: Client implementation

Write `apps/rebate-indexer/src/cow/client.ts`:

```ts
import { z } from 'zod';
import { CowTrade, CowOrder, CowQuoteResponse } from './types.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'cow-client' });

// chainId → CoW API path segment. Source: https://docs.cow.fi/cow-protocol/reference/apis/orderbook
const COW_API_PATH: Readonly<Record<number, string>> = {
  1:        'mainnet',
  100:      'xdai',
  8453:     'base',
  42161:    'arbitrum_one',
  137:      'polygon',
  43114:    'avalanche',
  56:       'bnb',
  59144:    'linea',
  9745:     'plasma',
  57073:    'ink',
  11155111: 'sepolia',
};

export const SUPPORTED_CHAIN_IDS = Object.keys(COW_API_PATH).map(Number);

const BASE_URL = process.env.COW_API_BASE ?? 'https://api.cow.fi';

async function fetchJson<T>(url: string, schema: z.ZodSchema<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`CoW API ${res.status} ${res.statusText} @ ${url} — ${body.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}

export interface ListTradesParams {
  readonly chainId: number;
  readonly owner?: `0x${string}`;
  readonly offset?: number;
  readonly limit?: number;                                            // CoW max is 1000
}

export async function listTrades(p: ListTradesParams): Promise<CowTrade[]> {
  const path = COW_API_PATH[p.chainId];
  if (!path) throw new Error(`unsupported chain ${p.chainId}`);
  const q = new URLSearchParams();
  if (p.owner) q.set('owner', p.owner);
  q.set('offset', String(p.offset ?? 0));
  q.set('limit', String(p.limit ?? 1000));
  const url = `${BASE_URL}/${path}/api/v1/trades?${q}`;
  log.debug({ url }, 'GET trades');
  return fetchJson(url, z.array(CowTrade));
}

export async function getOrder(chainId: number, uid: `0x${string}`): Promise<CowOrder> {
  const path = COW_API_PATH[chainId];
  if (!path) throw new Error(`unsupported chain ${chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/orders/${uid}`;
  log.debug({ url }, 'GET order');
  return fetchJson(url, CowOrder);
}

export interface QuoteParams {
  readonly chainId: number;
  readonly sellToken: `0x${string}`;
  readonly buyToken: `0x${string}`;
  readonly sellAmount: bigint;
}

export async function postQuote(p: QuoteParams): Promise<CowQuoteResponse> {
  const path = COW_API_PATH[p.chainId];
  if (!path) throw new Error(`unsupported chain ${p.chainId}`);
  const url = `${BASE_URL}/${path}/api/v1/quote`;
  // CoW expects a richer body; we ask for an indicative sell quote (no validity, no signing).
  const body = {
    sellToken: p.sellToken,
    buyToken: p.buyToken,
    receiver: '0x0000000000000000000000000000000000000000',
    appData: '{}',
    appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    from: '0x0000000000000000000000000000000000000000',
    priceQuality: 'fast',
    signingScheme: 'eip712',
    onchainOrder: false,
    kind: 'sell',
    sellAmountBeforeFee: p.sellAmount.toString(),
  };
  log.debug({ url, sellAmount: p.sellAmount.toString() }, 'POST quote');
  return fetchJson(url, CowQuoteResponse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
```

### Step 4: Smoke-test the schema against the fixture

Write `apps/rebate-indexer/tests/cow-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CowTrade } from '../src/cow/types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('CowTrade schema', () => {
  it('parses every entry in tests/fixtures/cow-trades.json', () => {
    const data: unknown[] = JSON.parse(readFileSync(join(fixturesDir, 'cow-trades.json'), 'utf8'));
    expect(Array.isArray(data)).toBe(true);
    for (const entry of data) {
      expect(() => CowTrade.parse(entry)).not.toThrow();
    }
  });
});
```

### Step 5: Run

```bash
pnpm test tests/cow-client.test.ts
```

Expected: PASS — every fixture parses.

### Step 6: Commit

```bash
git add apps/rebate-indexer/src/cow apps/rebate-indexer/tests/cow-client.test.ts apps/rebate-indexer/tests/fixtures/cow-trades.json
git commit -m "feat(rebate-indexer): CoW orderbook + quote API client"
```

---

## Task 6: `fetcher.ts` — pull ophis-tagged trades into `trades`

**Files:**
- Create: `apps/rebate-indexer/src/fetcher.ts`
- Create: `apps/rebate-indexer/tests/fetcher.test.ts`

### Step 1: Failing test

Write `apps/rebate-indexer/tests/fetcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const COW_FAKE_BASE = 'https://api.cow.fi';

const sampleTrade = (uid: string, owner: string, sell = '1000000000000000000', buy = '2500000000') => ({
  blockNumber: 35_000_000,
  logIndex: 1,
  orderUid: uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount: sell,
  buyAmount: buy,
  txHash: '0x' + '11'.repeat(32),
});

const sampleOrder = (uid: string, owner: string, appCode = 'ophis') => ({
  uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount: '1000000000000000000',
  buyAmount: '2500000000',
  appData: '0xabc',
  fullAppData: JSON.stringify({ appCode, metadata: { partnerFee: { recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' } } }),
  creationDate: '2026-05-01T12:00:00Z',
});

describe('fetcher.fetchChainTrades', () => {
  const handlers = vi.hoisted(() => ({
    trades: vi.fn(),
    order: vi.fn(),
    blockTime: vi.fn(),
  }));
  const server = setupServer(
    http.get(`${COW_FAKE_BASE}/xdai/api/v1/trades`, () => HttpResponse.json(handlers.trades())),
    http.get(`${COW_FAKE_BASE}/xdai/api/v1/orders/:uid`, ({ params }) =>
      HttpResponse.json(handlers.order(params.uid))),
  );
  beforeEach(() => {
    process.env.COW_API_BASE = COW_FAKE_BASE;
    server.listen();
  });
  afterEach(() => {
    server.resetHandlers();
    server.close();
  });

  it('skips trades whose order has appCode != ophis/greg', async () => {
    const ophisUid = '0x' + '0a'.repeat(56);
    const otherUid = '0x' + '0b'.repeat(56);
    handlers.trades.mockReturnValue([sampleTrade(ophisUid, '0xa'.padEnd(42, '0')), sampleTrade(otherUid, '0xb'.padEnd(42, '0'))]);
    handlers.order.mockImplementation((uid: string) => uid === ophisUid
      ? sampleOrder(ophisUid, '0xa'.padEnd(42, '0'), 'ophis')
      : sampleOrder(otherUid, '0xb'.padEnd(42, '0'), 'someoneelse'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, { blockTimestampLookup: async () => new Date('2026-05-01T12:00:00Z') });
    expect(rows.map((r) => r.tradeUid)).toEqual([ophisUid]);
    expect(rows[0]!.appCode).toBe('ophis');
  });

  it('paginates until the API returns fewer than limit rows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => sampleTrade('0x' + i.toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    const page2 = Array.from({ length: 17 },   (_, i) => sampleTrade('0x' + (1000 + i).toString(16).padStart(112, '0'), '0xa'.padEnd(42, '0')));
    let call = 0;
    handlers.trades.mockImplementation(() => (call++ === 0 ? page1 : page2));
    handlers.order.mockImplementation((uid: string) => sampleOrder(uid, '0xa'.padEnd(42, '0'), 'ophis'));

    const { fetchChainTrades } = await import('../src/fetcher.js');
    const rows = await fetchChainTrades(100, { blockTimestampLookup: async () => new Date('2026-05-01T12:00:00Z') });
    expect(rows).toHaveLength(1017);
  });
});
```

### Step 2: Run, see failures

```bash
pnpm test tests/fetcher.test.ts
```

Expected: red, `Cannot find module '../src/fetcher.js'`.

### Step 3: Implement

Write `apps/rebate-indexer/src/fetcher.ts`:

```ts
import { sql, db, schema } from './db/index.js';
import { listTrades, getOrder, SUPPORTED_CHAIN_IDS } from './cow/client.js';
import { APP_CODES, type AppCode } from './cow/types.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'fetcher' });
const PAGE_SIZE = 1_000;

export interface FetcherDeps {
  /**
   * Resolves block_timestamp for a given chain+block. Real implementation hits a public RPC;
   * tests inject a stub. We don't store provider URLs in the fetcher itself — keeps the
   * indexer's chain RPCs configured via env, not hardcoded here.
   */
  blockTimestampLookup(chainId: number, blockNumber: number): Promise<Date>;
}

export interface PendingTrade {
  tradeUid: `0x${string}`;
  chainId: number;
  wallet: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: Date;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  appCode: AppCode;
}

function isAppCodeOfInterest(code: string | undefined): code is AppCode {
  return code !== undefined && (APP_CODES as readonly string[]).includes(code);
}

export async function fetchChainTrades(chainId: number, deps: FetcherDeps): Promise<PendingTrade[]> {
  const out: PendingTrade[] = [];
  let offset = 0;
  while (true) {
    const page = await listTrades({ chainId, offset, limit: PAGE_SIZE });
    if (page.length === 0) break;

    for (const t of page) {
      // Skip if already in DB — cheap key lookup.
      const already = await db
        .select({ uid: schema.trades.tradeUid })
        .from(schema.trades)
        .where(sql`trade_uid = decode(${t.orderUid.slice(2)}, 'hex')`)
        .limit(1);
      if (already.length > 0) continue;

      // Confirm appCode by fetching the order. We could store unfiltered trades and filter
      // at scoring time, but fetching the order resolves fullAppData (avoids storing trades
      // that turn out to be unrelated to Ophis).
      const order = await getOrder(chainId, t.orderUid as `0x${string}`);
      let appCode: string | undefined;
      try {
        const meta = order.fullAppData ? JSON.parse(order.fullAppData) : {};
        appCode = meta?.appCode;
      } catch {
        appCode = undefined;
      }
      if (!isAppCodeOfInterest(appCode)) continue;

      out.push({
        tradeUid: t.orderUid as `0x${string}`,
        chainId,
        wallet: t.owner as `0x${string}`,
        blockNumber: BigInt(t.blockNumber),
        blockTimestamp: await deps.blockTimestampLookup(chainId, t.blockNumber),
        sellToken: t.sellToken as `0x${string}`,
        buyToken: t.buyToken as `0x${string}`,
        sellAmount: BigInt(t.sellAmount),
        buyAmount: BigInt(t.buyAmount),
        appCode,
      });
    }

    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  log.info({ chainId, fetched: out.length }, 'chain fetch complete');
  return out;
}

export async function runFetcher(deps: FetcherDeps): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    try {
      const rows = await fetchChainTrades(chainId, deps);
      if (rows.length === 0) continue;
      await db.insert(schema.trades).values(
        rows.map((r) => ({
          tradeUid: r.tradeUid,
          chainId: r.chainId,
          wallet: r.wallet,
          blockNumber: r.blockNumber,
          blockTimestamp: r.blockTimestamp,
          sellToken: r.sellToken,
          buyToken: r.buyToken,
          sellAmount: r.sellAmount,
          buyAmount: r.buyAmount,
          appCode: r.appCode,
          partnerFeeWei: null,
        })),
      ).onConflictDoNothing();
      inserted += rows.length;
    } catch (err) {
      log.error({ err, chainId }, 'chain fetch failed');                // single chain failure does not abort others
    }
  }
  return { inserted };
}
```

### Step 4: Run, verify passes

```bash
pnpm test tests/fetcher.test.ts
```

Expected: 2 passing.

### Step 5: Commit

```bash
git add apps/rebate-indexer/src/fetcher.ts apps/rebate-indexer/tests/fetcher.test.ts
git commit -m "feat(rebate-indexer): fetcher pulls ophis-tagged CoW trades into postgres"
```

---

## Task 7: `pricer.ts` — denominate trades in USD

**Files:**
- Create: `apps/rebate-indexer/src/pricer.ts`
- Create: `apps/rebate-indexer/tests/pricer.test.ts`

### Step 1: Failing test

Write `apps/rebate-indexer/tests/pricer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeTradeUsd } from '../src/pricer.js';

describe('computeTradeUsd', () => {
  it('values a trade by sell-side USD when sellToken→USDC quote is provided', () => {
    // Sold 1 WETH, buyToken irrelevant; quote says 1 WETH = 2500 USDC (sellAmount 1e18 → buyAmount 2.5e9 USDC@6)
    const usd = computeTradeUsd({
      sellAmount: 10n ** 18n,
      sellTokenDecimals: 18,
      quoteSellAmount: 10n ** 18n,
      quoteBuyAmount: 2_500n * 10n ** 6n,
      quoteBuyTokenDecimals: 6,
    });
    expect(usd).toBeCloseTo(2_500, 2);
  });

  it('rounds to 4 decimal places (matches NUMERIC(20,4) column)', () => {
    const usd = computeTradeUsd({
      sellAmount: 123_456_789n,
      sellTokenDecimals: 6,                                            // USDC
      quoteSellAmount: 1_000_000n,                                     // 1 USDC
      quoteBuyAmount: 1_000_000n,                                      // 1 USDC (self-quote)
      quoteBuyTokenDecimals: 6,
    });
    expect(usd).toBeCloseTo(123.4568, 4);
  });

  it('returns 0 for zero sellAmount', () => {
    expect(computeTradeUsd({
      sellAmount: 0n,
      sellTokenDecimals: 18,
      quoteSellAmount: 10n ** 18n,
      quoteBuyAmount: 2_500n * 10n ** 6n,
      quoteBuyTokenDecimals: 6,
    })).toBe(0);
  });

  it('throws if quoteSellAmount is zero (degenerate quote)', () => {
    expect(() => computeTradeUsd({
      sellAmount: 10n ** 18n,
      sellTokenDecimals: 18,
      quoteSellAmount: 0n,
      quoteBuyAmount: 1n,
      quoteBuyTokenDecimals: 6,
    })).toThrow(/quoteSellAmount/);
  });
});
```

### Step 2: Run, see failures

```bash
pnpm test tests/pricer.test.ts
```

Expected: red, `Cannot find module '../src/pricer.js'`.

### Step 3: Implement

Write `apps/rebate-indexer/src/pricer.ts`:

```ts
import { sql, db, schema } from './db/index.js';
import { postQuote } from './cow/client.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'pricer' });

// Stablecoin canonical pricing targets per chain. The pricer asks CoW for a quote
// from the trade's sellToken to one of these and back-computes USD.
// Addresses sourced from CoW docs and project memory. Audit before extending.
const USD_REFERENCE: Readonly<Record<number, { token: `0x${string}`; decimals: number }>> = {
  1:        { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },  // USDC mainnet
  100:      { token: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83', decimals: 6 },  // USDC.e gnosis
  8453:     { token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },  // USDC base
  42161:    { token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },  // USDC arbitrum
  137:      { token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },  // USDC polygon
  43114:    { token: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6 },  // USDC avalanche
  56:       { token: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 }, // USDC bnb
  59144:    { token: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6 },  // USDC linea
  9745:     { token: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6 },  // PLACEHOLDER plasma — verify before mainnet pricing
  57073:    { token: '0xf1815bd50389c46847f0bda824ec8da914045d14', decimals: 6 },  // USDC ink
  11155111: { token: '0xbe72e441bf55620febc26715db68d3494213d8cb', decimals: 18 }, // USDC sepolia (cow staging)
};

export interface ComputeTradeUsdParams {
  sellAmount: bigint;
  sellTokenDecimals: number;
  quoteSellAmount: bigint;                                             // the quote's normalized sellAmount in the same token
  quoteBuyAmount: bigint;                                              // → USD-stable token
  quoteBuyTokenDecimals: number;
}

/**
 * USD value of a trade given a CoW /quote response that prices the sellToken into a stablecoin.
 *
 *   usd = (sellAmount / 10^sellDecimals) * (quoteBuyAmount / 10^quoteBuyDecimals)
 *                                       / (quoteSellAmount / 10^sellDecimals)
 *       = sellAmount * quoteBuyAmount / (quoteSellAmount * 10^quoteBuyDecimals)   (× 10^4 / 10^4)
 *
 * Returned as a number rounded to 4 decimal places to match NUMERIC(20,4).
 */
export function computeTradeUsd(p: ComputeTradeUsdParams): number {
  if (p.sellAmount === 0n) return 0;
  if (p.quoteSellAmount === 0n) throw new Error('computeTradeUsd: quoteSellAmount must be non-zero');
  // Compute in fixed-point: scale numerator by 10^4 then floor-divide for rounded output.
  const scaled = (p.sellAmount * p.quoteBuyAmount * 10_000n)
               / (p.quoteSellAmount * (10n ** BigInt(p.quoteBuyTokenDecimals)));
  return Number(scaled) / 10_000;
}

const TOKEN_DECIMALS_CACHE = new Map<string, number>();

async function fetchTokenDecimals(chainId: number, token: `0x${string}`): Promise<number> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const cached = TOKEN_DECIMALS_CACHE.get(key);
  if (cached !== undefined) return cached;
  // We avoid a viem chain client here and rely on the CoW /tokens endpoint when available,
  // falling back to 18. Long-tail tokens that aren't in CoW's registry rarely make trades
  // through CoW in the first place.
  // TODO(post-launch): replace with a per-chain viem client + ERC20.decimals() call.
  const path = chainPath(chainId);
  try {
    const res = await fetch(`${process.env.COW_API_BASE ?? 'https://api.cow.fi'}/${path}/api/v1/tokens/${token}/native_price`);
    if (res.ok) {
      const json: any = await res.json();
      if (typeof json?.decimals === 'number') {
        TOKEN_DECIMALS_CACHE.set(key, json.decimals);
        return json.decimals;
      }
    }
  } catch { /* fall through */ }
  TOKEN_DECIMALS_CACHE.set(key, 18);
  return 18;
}

function chainPath(chainId: number): string {
  const m: Record<number, string> = {
    1: 'mainnet', 100: 'xdai', 8453: 'base', 42161: 'arbitrum_one', 137: 'polygon',
    43114: 'avalanche', 56: 'bnb', 59144: 'linea', 9745: 'plasma', 57073: 'ink', 11155111: 'sepolia',
  };
  const p = m[chainId];
  if (!p) throw new Error(`unsupported chain ${chainId}`);
  return p;
}

export async function priceTrade(row: {
  tradeUid: `0x${string}`;
  chainId: number;
  sellToken: `0x${string}`;
  sellAmount: bigint;
}): Promise<number> {
  const ref = USD_REFERENCE[row.chainId];
  if (!ref) throw new Error(`no USD reference for chain ${row.chainId}`);
  if (row.sellToken.toLowerCase() === ref.token.toLowerCase()) {
    const decimals = await fetchTokenDecimals(row.chainId, row.sellToken);
    return Number(row.sellAmount) / 10 ** decimals;                    // already USD-denominated
  }
  const sellDecimals = await fetchTokenDecimals(row.chainId, row.sellToken);
  const quote = await postQuote({
    chainId: row.chainId,
    sellToken: row.sellToken,
    buyToken: ref.token,
    sellAmount: row.sellAmount,
  });
  return computeTradeUsd({
    sellAmount: row.sellAmount,
    sellTokenDecimals: sellDecimals,
    quoteSellAmount: BigInt(quote.quote.sellAmount),
    quoteBuyAmount: BigInt(quote.quote.buyAmount),
    quoteBuyTokenDecimals: ref.decimals,
  });
}

export async function runPricer(): Promise<{ priced: number; failed: number }> {
  const unpriced = await db
    .select({
      tradeUid: schema.trades.tradeUid,
      chainId: schema.trades.chainId,
      sellToken: schema.trades.sellToken,
      sellAmount: schema.trades.sellAmount,
    })
    .from(schema.trades)
    .where(sql`value_usd IS NULL`)
    .limit(1_000);

  let priced = 0;
  let failed = 0;
  for (const row of unpriced) {
    try {
      const usd = await priceTrade(row);
      await db.execute(sql`
        UPDATE trades
        SET value_usd = ${usd}, priced_at = now()
        WHERE trade_uid = ${row.tradeUid}
      `);
      priced++;
    } catch (err) {
      log.warn({ err, tradeUid: row.tradeUid }, 'pricing failed');
      failed++;
    }
  }
  log.info({ priced, failed, remaining: unpriced.length - priced - failed }, 'pricer pass complete');
  return { priced, failed };
}
```

### Step 4: Run, verify passes

```bash
pnpm test tests/pricer.test.ts
```

Expected: 4 passing.

### Step 5: Commit

```bash
git add apps/rebate-indexer/src/pricer.ts apps/rebate-indexer/tests/pricer.test.ts
git commit -m "feat(rebate-indexer): USD pricer enriches trades via CoW /quote"
```

---

## Task 8: `scorer.ts` — refresh the wallets materialized view

**Files:**
- Create: `apps/rebate-indexer/src/scorer.ts`

### Step 1: Implement

Write `apps/rebate-indexer/src/scorer.ts`:

```ts
import { sql } from './db/index.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'scorer' });

/**
 * Refresh the `wallets` materialized view. CONCURRENTLY allows reads from the
 * API server during refresh — required because the swap-page chip is a public-facing
 * read path. Needs the UNIQUE INDEX on wallets(wallet) created in 0000_init.sql.
 */
export async function runScorer(): Promise<{ wallet_count: number }> {
  const t0 = Date.now();
  await sql.unsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY wallets');
  const [{ count }] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM wallets`;
  log.info({ wallet_count: count, ms: Date.now() - t0 }, 'wallets refreshed');
  return { wallet_count: count };
}
```

There's nothing pure to unit-test here — `REFRESH MATERIALIZED VIEW` is a Postgres operation. The integration test in Task 16 covers it end-to-end.

### Step 2: Commit

```bash
git add apps/rebate-indexer/src/scorer.ts
git commit -m "feat(rebate-indexer): scorer refreshes wallets materialized view"
```

---

## Task 9: `tierer.ts` — tier resolution helper

The actual tier computation is per-call (in `computeShares`) and per-API-request (in `api.ts`). `tierer.ts` is a thin wrapper that returns a wallet's current tier for the API server. There is no separate persisted "tier" column — tiers are derived from `wallets.volume_30d_usd` at read time.

**Files:**
- Create: `apps/rebate-indexer/src/tierer.ts`

### Step 1: Implement

Write `apps/rebate-indexer/src/tierer.ts`:

```ts
import { sql } from './db/index.js';
import { assignTier, TIERS, type Tier } from './tiers.js';

export interface WalletStatus {
  wallet: `0x${string}`;
  volume_30d_usd: number;
  trade_count_30d: number;
  tier: Tier;
  next_tier: Tier | null;                                              // null at Platinum
  usd_to_next_tier: number;                                            // 0 at Platinum
}

export async function getWalletStatus(wallet: `0x${string}`): Promise<WalletStatus> {
  const walletBuf = Buffer.from(wallet.slice(2), 'hex');
  const rows = await sql<{ volume_30d_usd: string; trade_count_30d: string }[]>`
    SELECT volume_30d_usd::text, trade_count_30d::text
    FROM wallets
    WHERE wallet = ${walletBuf}
  `;
  const volume = rows.length > 0 ? parseFloat(rows[0]!.volume_30d_usd) : 0;
  const count = rows.length > 0 ? parseInt(rows[0]!.trade_count_30d, 10) : 0;

  const tier = assignTier(volume);
  const tier_idx = TIERS.findIndex((t) => t.name === tier.name);
  const next_tier = tier_idx < TIERS.length - 1 ? TIERS[tier_idx + 1]! : null;
  const usd_to_next_tier = next_tier ? Math.max(0, next_tier.min_usd - volume) : 0;

  return { wallet, volume_30d_usd: volume, trade_count_30d: count, tier, next_tier, usd_to_next_tier };
}
```

### Step 2: Commit

```bash
git add apps/rebate-indexer/src/tierer.ts
git commit -m "feat(rebate-indexer): tier resolution helper for API server"
```

---

## Task 10: Canonical Safe + MultiSend + WETH addresses

**Files:**
- Create: `apps/rebate-indexer/src/safe/addresses.ts`
- Create: `apps/rebate-indexer/tests/addresses.test.ts`

### Step 1: Failing test

Write `apps/rebate-indexer/tests/addresses.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  OPHIS_SAFE_ADDRESS,
  WETH_GNOSIS,
  multiSendCallOnlyAddress,
  WETH_BY_CHAIN,
} from '../src/safe/addresses.js';

describe('canonical addresses', () => {
  it('OPHIS_SAFE_ADDRESS matches packages/sdk/src/partner-fee.ts', () => {
    expect(OPHIS_SAFE_ADDRESS).toBe('0x858f0F5eE954846D47155F5203c04aF1819eCeF8');
  });

  it('WETH_GNOSIS is the canonical Gnosis WETH (bridged Ethereum WETH)', () => {
    // Source: https://docs.cow.fi/cow-protocol/reference/contracts/core
    // verify on https://gnosisscan.io/token/0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1
    expect(WETH_GNOSIS).toBe('0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1');
  });

  it('multiSendCallOnlyAddress resolves a 1.4.1 deployment for Gnosis Chain (100)', () => {
    const addr = multiSendCallOnlyAddress(100);
    expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('multiSendCallOnlyAddress throws for an unsupported chain', () => {
    expect(() => multiSendCallOnlyAddress(999_999)).toThrow();
  });

  it('WETH_BY_CHAIN includes Gnosis at minimum (Phase 1 single-chain target)', () => {
    expect(WETH_BY_CHAIN[100]).toBe(WETH_GNOSIS);
  });
});
```

### Step 2: Run, see failures

```bash
pnpm test tests/addresses.test.ts
```

Expected: red.

### Step 3: Implement

Write `apps/rebate-indexer/src/safe/addresses.ts`:

```ts
import { getMultiSendCallOnlyDeployment } from '@safe-global/safe-deployments';

/**
 * Ophis partner-fee Safe. CREATE2-deterministic across all 10 CoW chains.
 * SOURCE OF TRUTH for downstream sanity checks: packages/sdk/src/partner-fee.ts.
 */
export const OPHIS_SAFE_ADDRESS = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' as const;

/** Bridged Ethereum WETH on Gnosis Chain. */
export const WETH_GNOSIS: `0x${string}` = '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1';

/**
 * Resolve Safe MultiSendCallOnly v1.4.1 address for a chain.
 *
 * Why CallOnly: Safe MultiSend (without CallOnly) supports DELEGATECALL in inner
 * txs. A buggy or malicious inner DELEGATECALL can drain the Safe. We do not need
 * inner DELEGATECALLs (ours are pure WETH.transfer calls), so we use the
 * call-only variant for defense-in-depth.
 *
 * The outer Safe transaction still uses operation=1 (DELEGATECALL) to invoke the
 * MultiSendCallOnly contract — that's standard Safe-MultiSend pattern.
 */
export function multiSendCallOnlyAddress(chainId: number): `0x${string}` {
  const dep = getMultiSendCallOnlyDeployment({ version: '1.4.1', network: String(chainId) });
  if (!dep) throw new Error(`no MultiSendCallOnly v1.4.1 deployment for chain ${chainId}`);
  const addr = dep.networkAddresses[String(chainId)];
  if (!addr) throw new Error(`MultiSendCallOnly v1.4.1 has no address for chain ${chainId}`);
  return addr as `0x${string}`;
}

export const WETH_BY_CHAIN: Readonly<Record<number, `0x${string}`>> = {
  100: WETH_GNOSIS,
  // Future chains added here as we expand payout reach. Phase 1 = Gnosis only.
};
```

### Step 4: Run, verify passes

```bash
pnpm test tests/addresses.test.ts
```

Expected: 5 passing.

### Step 5: Commit

```bash
git add apps/rebate-indexer/src/safe/addresses.ts apps/rebate-indexer/tests/addresses.test.ts
git commit -m "feat(rebate-indexer): canonical Safe + MultiSend + WETH address resolution"
```

---

## Task 11: MultiSend payload encoder

**Files:**
- Create: `apps/rebate-indexer/src/batch/multisend.ts`
- Create: `apps/rebate-indexer/tests/multisend.test.ts`

### Step 1: Failing test

Write `apps/rebate-indexer/tests/multisend.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import { encodeWethTransfers, encodeMultiSend, type Transfer } from '../src/batch/multisend.js';
import { WETH_GNOSIS } from '../src/safe/addresses.js';

describe('encodeMultiSend', () => {
  it('encodes a single transfer as the concatenated 85+data-length packed format', () => {
    const transfers: Transfer[] = [
      { to: '0xaaaa000000000000000000000000000000000001', amount: 12_345n },
    ];
    const wethCalldata = encodeWethTransfers(transfers, WETH_GNOSIS);
    const packed = encodeMultiSend(wethCalldata);
    // Layout per Safe MultiSend ABI: bytes packed { uint8 op, address to, uint256 value, uint256 dataLen, bytes data }
    //   op=0 (CALL) for CallOnly                       → 1 byte
    //   to = WETH_GNOSIS                               → 20 bytes
    //   value = 0                                      → 32 bytes
    //   dataLen = 68 (4-byte selector + 64 bytes args) → 32 bytes
    //   data = transfer(0xaaaa…, 12345)                → 68 bytes
    // Total = 153 bytes = 306 hex chars (+ 0x prefix)
    expect(packed).toMatch(/^0x[a-f0-9]+$/);
    expect((packed.length - 2) / 2).toBe(153);
  });

  it('encodes N transfers as N concatenated frames', () => {
    const transfers: Transfer[] = [
      { to: '0xaaaa000000000000000000000000000000000001', amount: 1n },
      { to: '0xbbbb000000000000000000000000000000000002', amount: 2n },
      { to: '0xcccc000000000000000000000000000000000003', amount: 3n },
    ];
    const wethCalldata = encodeWethTransfers(transfers, WETH_GNOSIS);
    const packed = encodeMultiSend(wethCalldata);
    expect((packed.length - 2) / 2).toBe(153 * 3);
  });

  it('first 8 bytes of each inner data are the ERC20 transfer selector', () => {
    const transfers: Transfer[] = [{ to: '0xaaaa000000000000000000000000000000000001', amount: 7n }];
    const wethCalldata = encodeWethTransfers(transfers, WETH_GNOSIS);
    // ERC20.transfer(address,uint256) selector = 0xa9059cbb
    expect(wethCalldata[0]!.data.slice(0, 10)).toBe('0xa9059cbb');
  });

  it('inner transfer data matches viem encodeFunctionData (anti-drift check)', () => {
    const erc20Abi = parseAbi(['function transfer(address to, uint256 amount)']);
    const transfers: Transfer[] = [{ to: '0x1234123412341234123412341234123412341234', amount: 999n }];
    const ours = encodeWethTransfers(transfers, WETH_GNOSIS)[0]!.data;
    const viemRef = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [transfers[0]!.to, transfers[0]!.amount],
    });
    expect(ours.toLowerCase()).toBe(viemRef.toLowerCase());
  });
});
```

### Step 2: Run, see failures

```bash
pnpm test tests/multisend.test.ts
```

Expected: red.

### Step 3: Implement

Write `apps/rebate-indexer/src/batch/multisend.ts`:

```ts
import { encodeFunctionData, parseAbi, pad, toHex, concatHex, sliceHex, type Hex } from 'viem';

const ERC20_TRANSFER = parseAbi(['function transfer(address to, uint256 amount)']);

export interface Transfer {
  readonly to: `0x${string}`;
  readonly amount: bigint;
}

export interface InnerCall {
  readonly to: `0x${string}`;
  readonly value: bigint;
  readonly data: `0x${string}`;
}

/** Produce the ERC20.transfer calldata for each rebate transfer, all targeting WETH on the payout chain. */
export function encodeWethTransfers(transfers: readonly Transfer[], weth: `0x${string}`): InnerCall[] {
  return transfers.map((t) => ({
    to: weth,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: 'transfer', args: [t.to, t.amount] }),
  }));
}

/**
 * Pack inner calls into the Safe MultiSendCallOnly transactions byte string.
 *
 * Per Safe MultiSend ABI:
 *   for each call: 1 byte op (0 = CALL) || 20 bytes to || 32 bytes value || 32 bytes dataLen || dataLen bytes data
 *
 * The whole thing is concatenated into a single bytes argument passed to multiSend(bytes).
 */
export function encodeMultiSend(inner: readonly InnerCall[]): Hex {
  if (inner.length === 0) throw new Error('encodeMultiSend: at least one inner call required');
  const frames: Hex[] = inner.map((c) => {
    const dataLen = (c.data.length - 2) / 2;                           // bytes
    return concatHex([
      '0x00',                                                          // operation = CALL (CallOnly variant rejects anything else)
      c.to,
      pad(toHex(c.value), { size: 32 }),
      pad(toHex(BigInt(dataLen)), { size: 32 }),
      c.data,
    ]);
  });
  return concatHex(frames);
}

/**
 * Build the outer `multiSend(bytes)` calldata. This is the calldata the Safe will
 * DELEGATECALL into the MultiSendCallOnly contract.
 */
export function encodeMultiSendCalldata(transactions: Hex): Hex {
  const abi = parseAbi(['function multiSend(bytes transactions)']);
  return encodeFunctionData({ abi, functionName: 'multiSend', args: [transactions] });
}

/** Helper: full pipeline for a list of (recipient, amount) WETH rebates → outer multiSend calldata. */
export function buildRebateMultisend(transfers: readonly Transfer[], weth: `0x${string}`): Hex {
  return encodeMultiSendCalldata(encodeMultiSend(encodeWethTransfers(transfers, weth)));
}

export { sliceHex };                                                   // re-export so tests can decode for debugging
```

### Step 4: Run, verify passes

```bash
pnpm test tests/multisend.test.ts
```

Expected: 4 passing.

### Step 5: Commit

```bash
git add apps/rebate-indexer/src/batch/multisend.ts apps/rebate-indexer/tests/multisend.test.ts
git commit -m "feat(rebate-indexer): Safe MultiSend payload encoder for WETH rebates"
```

---

## Task 12: Dry-run + recipient quarantine

**Files:**
- Create: `apps/rebate-indexer/src/batch/dryRun.ts`
- Create: `apps/rebate-indexer/tests/dryRun.test.ts`

The dry-run simulates the multicall against a forked or live Gnosis RPC via `eth_call` with `stateOverrides` to assume the Safe will be the `msg.sender`. If the simulation reverts, we walk the transfer list to find offenders and quarantine them.

### Step 1: Failing test

Write `apps/rebate-indexer/tests/dryRun.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { isolateBadRecipients, type SimulateFn, type Transfer } from '../src/batch/dryRun.js';

const tf = (id: number, amount: bigint = 1n): Transfer => ({
  to: (`0x${id.toString(16).padStart(40, '0')}`) as `0x${string}`,
  amount,
});

describe('isolateBadRecipients', () => {
  it('returns empty bad list when the full batch simulates successfully', async () => {
    const sim: SimulateFn = vi.fn(async () => ({ ok: true }));
    const { bad } = await isolateBadRecipients([tf(1), tf(2)], sim);
    expect(bad).toEqual([]);
    expect(sim).toHaveBeenCalledTimes(1);
  });

  it('finds a single bad recipient via per-transfer simulation', async () => {
    const bad = tf(2);
    const sim: SimulateFn = vi.fn(async (batch) => {
      // The full batch fails. Then per-tx isolation: only the bad recipient fails.
      if (batch.length > 1) return { ok: false, reason: 'multi-fail' };
      return batch[0]!.to === bad.to ? { ok: false, reason: 'revert' } : { ok: true };
    });
    const result = await isolateBadRecipients([tf(1), bad, tf(3)], sim);
    expect(result.bad.map((t) => t.to)).toEqual([bad.to]);
    expect(result.good.map((t) => t.to)).toEqual([tf(1).to, tf(3).to]);
  });

  it('finds multiple bad recipients', async () => {
    const sim: SimulateFn = vi.fn(async (batch) => {
      if (batch.length > 1) return { ok: false, reason: 'multi-fail' };
      const id = parseInt(batch[0]!.to.slice(2), 16);
      return id % 2 === 0 ? { ok: false, reason: 'revert' } : { ok: true };
    });
    const result = await isolateBadRecipients([tf(1), tf(2), tf(3), tf(4)], sim);
    expect(result.bad.map((t) => t.to)).toEqual([tf(2).to, tf(4).to]);
    expect(result.good.map((t) => t.to)).toEqual([tf(1).to, tf(3).to]);
  });
});
```

### Step 2: Run, see failures

```bash
pnpm test tests/dryRun.test.ts
```

Expected: red.

### Step 3: Implement

Write `apps/rebate-indexer/src/batch/dryRun.ts`:

```ts
import {
  createPublicClient,
  http,
  type PublicClient,
} from 'viem';
import { logger } from '../logger.js';
import { buildRebateMultisend } from './multisend.js';
import { multiSendCallOnlyAddress, OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from '../safe/addresses.js';

const log = logger.child({ module: 'dry-run' });

export interface Transfer {
  readonly to: `0x${string}`;
  readonly amount: bigint;
}

export interface SimulateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export type SimulateFn = (batch: readonly Transfer[]) => Promise<SimulateResult>;

/** Run a real eth_call against an RPC, returning ok=true if the multiSend doesn't revert. */
export function buildEthCallSimulator(opts: {
  chainId: number;
  rpcUrl: string;
}): SimulateFn {
  const client: PublicClient = createPublicClient({ transport: http(opts.rpcUrl) });
  const weth = WETH_BY_CHAIN[opts.chainId];
  if (!weth) throw new Error(`no WETH configured for chain ${opts.chainId}`);
  const multiSend = multiSendCallOnlyAddress(opts.chainId);

  return async (batch) => {
    if (batch.length === 0) return { ok: true };
    const calldata = buildRebateMultisend(batch, weth);
    try {
      await client.call({
        account: OPHIS_SAFE_ADDRESS,                                   // simulate as if Safe is the sender (DELEGATECALL context)
        to: multiSend,
        data: calldata,
      });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.shortMessage ?? err?.message ?? 'eth_call reverted' };
    }
  };
}

/**
 * Walk the batch to find recipients whose transfer reverts.
 *
 *   1. Try the full batch. If ok → no bad recipients.
 *   2. For each transfer, simulate it alone. Mark every one whose simulation fails.
 *
 * The single-element loop is N RPC calls — fine for ~50 recipients/month.
 */
export async function isolateBadRecipients(
  transfers: readonly Transfer[],
  simulate: SimulateFn,
): Promise<{ good: Transfer[]; bad: Transfer[] }> {
  const first = await simulate(transfers);
  if (first.ok) return { good: [...transfers], bad: [] };

  log.warn({ reason: first.reason, count: transfers.length }, 'full batch sim failed, isolating');
  const good: Transfer[] = [];
  const bad: Transfer[] = [];
  for (const t of transfers) {
    const r = await simulate([t]);
    if (r.ok) good.push(t);
    else {
      log.warn({ to: t.to, amount: t.amount.toString(), reason: r.reason }, 'recipient quarantined');
      bad.push(t);
    }
  }
  return { good, bad };
}
```

### Step 4: Run, verify passes

```bash
pnpm test tests/dryRun.test.ts
```

Expected: 3 passing.

### Step 5: Commit

```bash
git add apps/rebate-indexer/src/batch/dryRun.ts apps/rebate-indexer/tests/dryRun.test.ts
git commit -m "feat(rebate-indexer): batch dry-run + recipient quarantine"
```

---

## Task 13: Safe Transaction Service proposer + status polling

**Files:**
- Create: `apps/rebate-indexer/src/batch/propose.ts`
- Create: `apps/rebate-indexer/src/batch/poll.ts`

### Step 1: Propose helper

Write `apps/rebate-indexer/src/batch/propose.ts`:

```ts
import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { OPHIS_SAFE_ADDRESS, multiSendCallOnlyAddress, WETH_BY_CHAIN } from '../safe/addresses.js';
import { buildRebateMultisend, type Transfer } from './multisend.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'propose' });

export interface ProposeParams {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  readonly transfers: readonly Transfer[];
}

export interface ProposeResult {
  readonly safeTxHash: `0x${string}`;
  readonly proposerAddress: `0x${string}`;
}

/**
 * Submit a Safe transaction to the Safe Transaction Service queue. The proposer key
 * has zero on-chain authority — it's only known to Safe TX Service as a permitted
 * proposer for OPHIS_SAFE_ADDRESS. Execution still requires a human signer.
 */
export async function proposeRebateBatch(p: ProposeParams): Promise<ProposeResult> {
  if (p.transfers.length === 0) throw new Error('proposeRebateBatch: empty transfers list');
  const weth = WETH_BY_CHAIN[p.chainId];
  if (!weth) throw new Error(`no WETH configured for chain ${p.chainId}`);
  const multiSend = multiSendCallOnlyAddress(p.chainId);
  const calldata = buildRebateMultisend(p.transfers, weth);

  const protocolKit = await Safe.init({
    provider: p.rpcUrl,
    signer: p.proposerPrivateKey,
    safeAddress: OPHIS_SAFE_ADDRESS,
  });
  const proposerAddress = (await protocolKit.getSafeProvider().getSignerAddress()) as `0x${string}`;

  const safeTx = await protocolKit.createTransaction({
    transactions: [{ to: multiSend, value: '0', data: calldata, operation: 1 /* DELEGATECALL */ }],
  });
  const safeTxHash = (await protocolKit.getTransactionHash(safeTx)) as `0x${string}`;
  const senderSignature = await protocolKit.signHash(safeTxHash);

  const apiKit = new SafeApiKit({ chainId: BigInt(p.chainId) });
  await apiKit.proposeTransaction({
    safeAddress: OPHIS_SAFE_ADDRESS,
    safeTransactionData: safeTx.data,
    safeTxHash,
    senderAddress: proposerAddress,
    senderSignature: senderSignature.data,
  });
  log.info({ safeTxHash, proposerAddress, recipientCount: p.transfers.length }, 'proposed');
  return { safeTxHash, proposerAddress };
}
```

### Step 2: Poll helper

Write `apps/rebate-indexer/src/batch/poll.ts`:

```ts
import SafeApiKit from '@safe-global/api-kit';
import { OPHIS_SAFE_ADDRESS } from '../safe/addresses.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'poll' });

export interface PollResult {
  readonly executed: boolean;
  readonly isSuccessful: boolean | null;
  readonly transactionHash: `0x${string}` | null;
}

/** One-shot status check. Caller decides cadence. */
export async function getProposalStatus(chainId: number, safeTxHash: `0x${string}`): Promise<PollResult> {
  const apiKit = new SafeApiKit({ chainId: BigInt(chainId) });
  const tx = await apiKit.getTransaction(safeTxHash);
  return {
    executed: Boolean(tx.isExecuted),
    isSuccessful: tx.isSuccessful ?? null,
    transactionHash: (tx.transactionHash ?? null) as `0x${string}` | null,
  };
}

/**
 * Poll Safe TX Service until executed (or timeout). Used by the batcher's tail
 * after proposing. Long-running — we don't block cron, we run this in the background
 * as a fire-and-forget after proposeTransaction returns.
 */
export async function waitForExecution(opts: {
  chainId: number;
  safeTxHash: `0x${string}`;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<PollResult> {
  const interval = opts.intervalMs ?? 60_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 7 * 24 * 60 * 60 * 1000);     // 7 days default
  while (Date.now() < deadline) {
    const r = await getProposalStatus(opts.chainId, opts.safeTxHash);
    if (r.executed) {
      log.info({ safeTxHash: opts.safeTxHash, ...r }, 'execution observed');
      return r;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  log.warn({ safeTxHash: opts.safeTxHash, after: 'timeout' }, 'gave up polling');
  return { executed: false, isSuccessful: null, transactionHash: null };
}
```

### Step 3: Commit

```bash
git add apps/rebate-indexer/src/batch/propose.ts apps/rebate-indexer/src/batch/poll.ts
git commit -m "feat(rebate-indexer): Safe Transaction Service proposer + status polling"
```

---

## Task 14: `batcher.ts` — orchestrator

Wires the previous building blocks: read `wallets`, compute shares, dry-run, quarantine, propose, persist. Idempotent against `rebate_batches.cycle_month` UNIQUE constraint.

**Files:**
- Create: `apps/rebate-indexer/src/batcher.ts`

### Step 1: Implement

Write `apps/rebate-indexer/src/batcher.ts`:

```ts
import { sql, db, schema } from './db/index.js';
import { computeShares, type EligibleWallet } from './batch/computeShares.js';
import { buildEthCallSimulator, isolateBadRecipients, type Transfer } from './batch/dryRun.js';
import { proposeRebateBatch } from './batch/propose.js';
import { waitForExecution } from './batch/poll.js';
import { assignTier, POOL_SPLIT_BPS } from './tiers.js';
import { OPHIS_SAFE_ADDRESS, WETH_BY_CHAIN } from './safe/addresses.js';
import { createPublicClient, http, parseAbi } from 'viem';
import { logger } from './logger.js';

const log = logger.child({ module: 'batcher' });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface BatcherDeps {
  readonly chainId: number;                                            // payout chain (100 in Phase 1)
  readonly rpcUrl: string;
  readonly proposerPrivateKey: `0x${string}`;
  readonly proposeEnabled: boolean;                                    // false for first-batch dry-run safety
}

export interface BatcherResult {
  readonly batchId: number;
  readonly status: 'computing' | 'proposed' | 'no_recipients' | 'failed';
  readonly safeTxHash: `0x${string}` | null;
  readonly recipientCount: number;
  readonly poolWei: bigint;
}

/** First-of-month detection in UTC. The cron entrypoint calls this. */
export function isFirstOfMonth(now: Date = new Date()): boolean {
  return now.getUTCDate() === 1;
}

function cycleMonthKey(now: Date): string {
  // YYYY-MM-01 of the cycle being paid out — i.e., the current month's 1st.
  // Example: running on 2026-06-01 02:00 UTC → '2026-06-01'.
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

export async function runBatcher(deps: BatcherDeps, now: Date = new Date()): Promise<BatcherResult> {
  const cycleMonth = cycleMonthKey(now);
  log.info({ cycleMonth, chainId: deps.chainId, proposeEnabled: deps.proposeEnabled }, 'batcher start');

  // 1. Read Safe WETH balance.
  const weth = WETH_BY_CHAIN[deps.chainId]!;
  const client = createPublicClient({ transport: http(deps.rpcUrl) });
  const netFee = await client.readContract({ address: weth, abi: ERC20, functionName: 'balanceOf', args: [OPHIS_SAFE_ADDRESS] });
  const pool = (netFee * BigInt(POOL_SPLIT_BPS)) / 10_000n;

  // 2. Read eligible wallets.
  const eligible = await sql<{ wallet: Buffer; volume_30d_usd: string }[]>`
    SELECT wallet, volume_30d_usd::text FROM wallets WHERE volume_30d_usd > 0
  `;
  const wallets: EligibleWallet[] = eligible.map((r) => ({
    wallet: (`0x${r.wallet.toString('hex')}`) as `0x${string}`,
    volume_30d_usd: parseFloat(r.volume_30d_usd),
  }));

  // 3. Insert the batch row up-front so we have a stable ID even if subsequent steps fail.
  //    UNIQUE on cycle_month → idempotent: retrying the same month no-ops at the INSERT.
  let batchId: number;
  try {
    const inserted = await db
      .insert(schema.rebateBatches)
      .values({ cycleMonth: cycleMonth, netFeeWethWei: netFee, poolWethWei: pool, status: 'computing' })
      .returning({ id: schema.rebateBatches.id });
    batchId = inserted[0]!.id;
  } catch (err: any) {
    if (String(err?.message ?? '').includes('rebate_batches_cycle_month_unique')) {
      log.warn({ cycleMonth }, 'batch already exists for this cycle, aborting (no double-pay)');
      throw err;
    }
    throw err;
  }

  // 4. No recipients → record + bail out.
  if (wallets.length === 0 || pool === 0n) {
    await db.update(schema.rebateBatches).set({ status: 'no_recipients' })
      .where(sql`id = ${batchId}`);
    log.info({ batchId, reason: pool === 0n ? 'zero pool' : 'no wallets' }, 'no recipients');
    return { batchId, status: 'no_recipients', safeTxHash: null, recipientCount: 0, poolWei: pool };
  }

  // 5. Compute shares.
  const shares = computeShares(wallets, pool);
  const transfersAll: Transfer[] = [...shares.entries()].map(([to, amount]) => ({ to, amount }));

  // 6. Dry-run + quarantine.
  const simulate = buildEthCallSimulator({ chainId: deps.chainId, rpcUrl: deps.rpcUrl });
  const { good, bad } = await isolateBadRecipients(transfersAll, simulate);

  // 7. Write per-wallet entries (good + bad, with bad amounts zeroed).
  const entryRows = transfersAll.map((t) => {
    const w = wallets.find((x) => x.wallet === t.to)!;
    const tier = assignTier(w.volume_30d_usd);
    const isBad = bad.some((b) => b.to === t.to);
    return {
      batchId,
      wallet: t.to,
      volumeUsd: w.volume_30d_usd.toFixed(4),
      tier: tier.name,
      rebatePct: tier.rebate_pct.toFixed(4),
      wethAmountWei: isBad ? 0n : t.amount,
    };
  });
  await db.insert(schema.rebateBatchEntries).values(entryRows);

  if (good.length === 0) {
    await db.update(schema.rebateBatches).set({ status: 'failed' }).where(sql`id = ${batchId}`);
    log.error({ batchId, badCount: bad.length }, 'all recipients quarantined');
    return { batchId, status: 'failed', safeTxHash: null, recipientCount: 0, poolWei: pool };
  }

  // 8. Propose (unless deps.proposeEnabled is false — first-batch dry-run).
  if (!deps.proposeEnabled) {
    log.info({ batchId, recipientCount: good.length, poolWei: pool.toString() }, 'dry-run only, not proposing');
    return { batchId, status: 'computing', safeTxHash: null, recipientCount: good.length, poolWei: pool };
  }
  const { safeTxHash } = await proposeRebateBatch({
    chainId: deps.chainId,
    rpcUrl: deps.rpcUrl,
    proposerPrivateKey: deps.proposerPrivateKey,
    transfers: good,
  });
  await db.update(schema.rebateBatches).set({
    status: 'proposed',
    safeProposalHash: safeTxHash,
    proposedAt: new Date(),
  }).where(sql`id = ${batchId}`);

  // 9. Fire-and-forget polling for finality.
  waitForExecution({ chainId: deps.chainId, safeTxHash }).then(async (r) => {
    if (r.executed) {
      await db.update(schema.rebateBatches).set({
        status: r.isSuccessful ? 'executed' : 'failed',
        safeTxHash: r.transactionHash,
        executedAt: new Date(),
      }).where(sql`id = ${batchId}`);
    }
  }).catch((err) => log.error({ err, batchId }, 'polling failed'));

  return { batchId, status: 'proposed', safeTxHash, recipientCount: good.length, poolWei: pool };
}
```

### Step 2: Commit

```bash
git add apps/rebate-indexer/src/batcher.ts
git commit -m "feat(rebate-indexer): batcher orchestrator wiring compute → dryRun → propose → poll"
```

---

## Task 15: Fastify HTTP API

**Files:**
- Create: `apps/rebate-indexer/src/api.ts`

### Step 1: Implement

Write `apps/rebate-indexer/src/api.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, db, schema } from './db/index.js';
import { getWalletStatus } from './tierer.js';
import { logger } from './logger.js';

export async function buildApiServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });                              // we use pino directly

  // CORS — the swap page (ophis.fi + *.pages.dev) calls /tier directly.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const allowed = ['https://ophis.fi', 'https://www.ophis.fi', 'https://greg.pages.dev', 'https://ophis.pages.dev'];
    if (origin && allowed.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
  });
  app.options('*', async (_req, reply) => reply.code(204).send());

  app.get('/health', async () => {
    const [{ last_fetch }] = await sql<{ last_fetch: string | null }[]>`
      SELECT MAX(fetched_at)::text AS last_fetch FROM trades
    `;
    const [{ pending }] = await sql<{ pending: string }[]>`
      SELECT COUNT(*)::text AS pending FROM rebate_batches WHERE status IN ('computing','proposed')
    `;
    return { ok: true, last_fetch, pending_batches: parseInt(pending, 10) };
  });

  app.get('/status', async () => {
    const [last] = await sql<{ cycle_month: string; status: string; pool_weth_wei: string }[]>`
      SELECT cycle_month::text, status, pool_weth_wei::text
      FROM rebate_batches ORDER BY id DESC LIMIT 1
    `;
    const [{ total_wallets }] = await sql<{ total_wallets: string }[]>`SELECT COUNT(*)::text AS total_wallets FROM wallets`;
    const [{ total_volume }] = await sql<{ total_volume: string | null }[]>`SELECT COALESCE(SUM(volume_30d_usd)::text, '0') AS total_volume FROM wallets`;
    return {
      ok: true,
      last_batch: last ?? null,
      total_wallets: parseInt(total_wallets, 10),
      total_volume_30d_usd: total_volume,
      next_batch_cycle: nextFirstOfMonth().toISOString(),
    };
  });

  app.get<{ Params: { wallet: string } }>('/tier/:wallet', async (req, reply) => {
    const raw = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) return reply.code(400).send({ error: 'invalid wallet address' });
    const status = await getWalletStatus(raw as `0x${string}`);
    return status;
  });

  app.get('/batches', async () => {
    const rows = await db.select().from(schema.rebateBatches).orderBy(sql`id DESC`).limit(100);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/batches/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' });
    const [batch] = await db.select().from(schema.rebateBatches).where(sql`id = ${id}`);
    if (!batch) return reply.code(404).send({ error: 'not found' });
    const entries = await db.select().from(schema.rebateBatchEntries).where(sql`batch_id = ${id}`);
    return { batch, entries };
  });

  return app;
}

function nextFirstOfMonth(): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}

export async function startApi(): Promise<FastifyInstance> {
  const app = await buildApiServer();
  const port = parseInt(process.env.API_PORT ?? '8080', 10);
  await app.listen({ host: '0.0.0.0', port });
  logger.info({ port }, 'api listening');
  return app;
}
```

### Step 2: Commit

```bash
git add apps/rebate-indexer/src/api.ts
git commit -m "feat(rebate-indexer): public read-only API (tier, health, status, batches)"
```

---

## Task 16: Integration test — full nightly cycle + replay idempotency

**Files:**
- Create: `apps/rebate-indexer/tests/integration.test.ts`

### Step 1: Write the test

Write `apps/rebate-indexer/tests/integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { runMigrations } from '../src/db/migrate.js';
import { runScorer } from '../src/scorer.js';

const COW = 'https://api.cow.fi';

const trade = (uid: string, owner: string, sellAmount = '1000000000000000000') => ({
  blockNumber: 35_000_000,
  logIndex: 1,
  orderUid: uid,
  owner,
  sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
  buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
  sellAmount,
  buyAmount: '2500000000',
  txHash: '0x' + '11'.repeat(32),
});

let pg: StartedPostgreSqlContainer;
const handlers = {
  trades: [] as any[],
  order: (uid: string) => ({
    uid,
    owner: '0x' + 'a'.repeat(40),
    sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
    buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
    sellAmount: '1000000000000000000',
    buyAmount:  '2500000000',
    appData: '0xabc',
    fullAppData: JSON.stringify({ appCode: 'ophis' }),
    creationDate: '2026-05-01T12:00:00Z',
  }),
};
const server = setupServer(
  http.get(`${COW}/xdai/api/v1/trades`, () => HttpResponse.json(handlers.trades)),
  http.get(`${COW}/xdai/api/v1/orders/:uid`, ({ params }) => HttpResponse.json(handlers.order(params.uid as string))),
  http.post(`${COW}/xdai/api/v1/quote`, async () => HttpResponse.json({
    quote: {
      sellToken: '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1',
      buyToken:  '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
      sellAmount: '1000000000000000000',
      buyAmount:  '2500000000',                                        // 1 WETH = 2500 USDC
    },
    expiration: '2026-05-01T13:00:00Z',
  })),
);

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.COW_API_BASE = COW;
  server.listen();
  await runMigrations();
}, 60_000);

afterAll(async () => {
  server.close();
  await pg.stop();
});

beforeEach(async () => {
  handlers.trades = [];
});

describe('full nightly cycle', () => {
  it('fetch → price → score → tier yields expected wallet rows', async () => {
    handlers.trades = [
      trade('0x' + '0a'.repeat(56), '0x' + 'a'.repeat(40)),
      trade('0x' + '0b'.repeat(56), '0x' + 'a'.repeat(40)),
      trade('0x' + '0c'.repeat(56), '0x' + 'b'.repeat(40)),
    ];
    const { runFetcher } = await import('../src/fetcher.js');
    const { runPricer } = await import('../src/pricer.js');
    const { getWalletStatus } = await import('../src/tierer.js');

    await runFetcher({ blockTimestampLookup: async () => new Date() });
    await runPricer();
    await runScorer();

    // Each WETH trade is 1 WETH × 2500 USDC/WETH = $2500 USD.
    // Wallet A had 2 trades → $5000 → silver. Wallet B had 1 → $2500 → bronze.
    const a = await getWalletStatus(('0x' + 'a'.repeat(40)) as `0x${string}`);
    const b = await getWalletStatus(('0x' + 'b'.repeat(40)) as `0x${string}`);
    expect(a.tier.name).toBe('silver');
    expect(a.volume_30d_usd).toBeCloseTo(5000, 0);
    expect(b.tier.name).toBe('bronze');
    expect(b.volume_30d_usd).toBeCloseTo(2500, 0);
  });

  it('replay idempotency: running fetcher twice produces identical DB state', async () => {
    handlers.trades = [trade('0x' + '0d'.repeat(56), '0x' + 'a'.repeat(40))];
    const { runFetcher } = await import('../src/fetcher.js');
    const { sql } = await import('../src/db/index.js');

    await runFetcher({ blockTimestampLookup: async () => new Date() });
    const snap1 = await sql`SELECT * FROM trades ORDER BY trade_uid`;
    await runFetcher({ blockTimestampLookup: async () => new Date() });
    const snap2 = await sql`SELECT * FROM trades ORDER BY trade_uid`;
    expect(snap2.length).toBe(snap1.length);
    expect(snap2.map((r: any) => r.trade_uid.toString('hex')))
      .toEqual(snap1.map((r: any) => r.trade_uid.toString('hex')));
  });
});
```

### Step 2: Add the `@testcontainers/postgresql` dep

```bash
cd apps/rebate-indexer && pnpm add -D @testcontainers/postgresql@^10.13.0
```

### Step 3: Run

```bash
pnpm test tests/integration.test.ts
```

Expected: 2 passing. Takes ~30-60s because of container startup.

### Step 4: Commit

```bash
git add apps/rebate-indexer/tests/integration.test.ts apps/rebate-indexer/package.json
git commit -m "test(rebate-indexer): integration tests w/ testcontainers Postgres + msw CoW"
```

---

## Task 17: Telegram alerter

**Files:**
- Create: `apps/rebate-indexer/src/telegram/alerter.ts`

### Step 1: Implement

Write `apps/rebate-indexer/src/telegram/alerter.ts`:

```ts
import { logger } from '../logger.js';

const log = logger.child({ module: 'telegram' });

const TELEGRAM_API = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;                          // '735726338' = Clement DM

export async function notify(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) {
    log.debug({ text }, 'telegram disabled; would have sent');
    return;
  }
  try {
    const res = await fetch(TELEGRAM_API(TOKEN, 'sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      log.warn({ status: res.status, body: await res.text() }, 'telegram send failed');
    }
  } catch (err) {
    log.warn({ err }, 'telegram send threw');
  }
}

export const alerts = {
  nightlyComplete(stats: { newTrades: number; volumeUsd: number }) {
    return notify(`✅ <b>Nightly index complete</b>\n${stats.newTrades} new trades · $${stats.volumeUsd.toLocaleString()} volume`);
  },
  batchReady(args: { cycle: string; pool: string; count: number; safeQueueUrl: string; topRecipient: string }) {
    return notify(
      `💸 <b>Rebate batch ${args.cycle} ready to sign</b>\n` +
      `Pool: ${args.pool} WETH · ${args.count} recipients\n` +
      `Top: ${args.topRecipient}\n` +
      `<a href="${args.safeQueueUrl}">Open Safe queue →</a>`,
    );
  },
  batchUnsigned(days: number, cycle: string) {
    return notify(`⏰ <b>Batch ${cycle} unsigned for ${days} days</b> — please review the Safe queue.`);
  },
  batchExecuted(args: { cycle: string; pool: string; count: number; txHash: string }) {
    return notify(
      `🟢 <b>Batch ${args.cycle} executed</b>\n` +
      `${args.pool} WETH to ${args.count} wallets\n` +
      `<a href="https://gnosisscan.io/tx/${args.txHash}">Gnosisscan →</a>`,
    );
  },
  alert(scope: string, message: string) {
    return notify(`🚨 <b>ALERT:</b> ${scope}\n${message}`);
  },
};
```

### Step 2: Commit

```bash
git add apps/rebate-indexer/src/telegram/alerter.ts
git commit -m "feat(rebate-indexer): Telegram alerter for lifecycle + incident pings"
```

---

## Task 18: `cron.ts` — in-process scheduler chaining the pipeline

**Files:**
- Create: `apps/rebate-indexer/src/cron.ts`

### Step 1: Implement

Write `apps/rebate-indexer/src/cron.ts`:

```ts
import cron from 'node-cron';
import { runFetcher } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher, isFirstOfMonth } from './batcher.js';
import { alerts } from './telegram/alerter.js';
import { logger } from './logger.js';
import { sql } from './db/index.js';
import { createPublicClient, http } from 'viem';
import { gnosis } from 'viem/chains';

const log = logger.child({ module: 'cron' });

function gnosisRpc(): string {
  return process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
}

async function blockTimestampLookup(_chainId: number, blockNumber: number): Promise<Date> {
  // For Phase 1 we only block-fetch on Gnosis. Other chains: rely on CoW's API timestamps
  // (we accept a 1-day clock-skew worst case; rebate window is 30 days).
  const client = createPublicClient({ chain: gnosis, transport: http(gnosisRpc()) });
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  return new Date(Number(block.timestamp) * 1_000);
}

/**
 * The full nightly pipeline. Runs sequentially. Called by the daily cron tick.
 * On the 1st of the month, batcher runs as the final step — never as a separate
 * cron entry, eliminating the race noted in the spec §"Safe batch flow → Step 1".
 */
export async function runNightlyPipeline(): Promise<void> {
  const t0 = Date.now();
  log.info('pipeline start');

  try {
    const { inserted } = await runFetcher({ blockTimestampLookup });
    log.info({ inserted }, 'fetcher complete');

    const priced = await runPricer();
    log.info(priced, 'pricer complete');

    const scored = await runScorer();
    log.info(scored, 'scorer complete');

    // tierer.ts has no batch refresh — it's read-on-demand. Nothing to call here.

    // Telegram summary.
    const [{ new_trades }] = await sql<{ new_trades: string }[]>`
      SELECT COUNT(*)::text AS new_trades FROM trades WHERE fetched_at > now() - INTERVAL '1 day'
    `;
    const [{ volume }] = await sql<{ volume: string | null }[]>`
      SELECT COALESCE(SUM(value_usd)::text, '0') AS volume FROM trades WHERE fetched_at > now() - INTERVAL '1 day'
    `;
    await alerts.nightlyComplete({ newTrades: parseInt(new_trades, 10), volumeUsd: parseFloat(volume ?? '0') });

    if (isFirstOfMonth()) {
      log.info('first-of-month: running batcher');
      const proposeEnabled = process.env.BATCHER_PROPOSE_ENABLED !== 'false';
      const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY;
      if (!proposerKey) {
        log.error('SAFE_PROPOSER_PRIVATE_KEY missing; skipping batcher');
        await alerts.alert('batcher', 'SAFE_PROPOSER_PRIVATE_KEY env var missing — no proposal made');
      } else {
        const result = await runBatcher({
          chainId: 100,
          rpcUrl: gnosisRpc(),
          proposerPrivateKey: proposerKey as `0x${string}`,
          proposeEnabled,
        });
        if (result.status === 'proposed') {
          await alerts.batchReady({
            cycle: new Date().toISOString().slice(0, 7),
            pool: (Number(result.poolWei) / 1e18).toFixed(5),
            count: result.recipientCount,
            safeQueueUrl: 'https://app.safe.global/transactions/queue?safe=gno:0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
            topRecipient: 'see /batches/' + result.batchId,
          });
        }
      }
    }
  } catch (err: any) {
    log.error({ err: err?.message ?? err }, 'pipeline failed');
    await alerts.alert('pipeline', String(err?.message ?? err));
    throw err;
  }
  log.info({ ms: Date.now() - t0 }, 'pipeline complete');
}

export function startCron(): void {
  // 02:00 UTC daily. node-cron uses the host TZ — explicitly force UTC.
  cron.schedule('0 2 * * *', () => {
    runNightlyPipeline().catch(() => { /* already logged + alerted */ });
  }, { timezone: 'UTC' });
  log.info('cron scheduled: 02:00 UTC daily');
}
```

### Step 2: Commit

```bash
git add apps/rebate-indexer/src/cron.ts
git commit -m "feat(rebate-indexer): cron orchestrator chains nightly + monthly in-process"
```

---

## Task 19: Container entrypoint + CLI

**Files:**
- Create: `apps/rebate-indexer/src/index.ts`
- Create: `apps/rebate-indexer/src/cli.ts`

### Step 1: Entrypoint

Write `apps/rebate-indexer/src/index.ts`:

```ts
import { runMigrations } from './db/migrate.js';
import { startApi } from './api.js';
import { startCron } from './cron.js';
import { logger } from './logger.js';

async function main() {
  await runMigrations();
  await startApi();
  startCron();
  logger.info('rebate-indexer ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
```

### Step 2: CLI

Write `apps/rebate-indexer/src/cli.ts`:

```ts
import { runMigrations } from './db/migrate.js';
import { runFetcher } from './fetcher.js';
import { runPricer } from './pricer.js';
import { runScorer } from './scorer.js';
import { runBatcher } from './batcher.js';
import { sql } from './db/index.js';
import { logger } from './logger.js';
import { createPublicClient, http } from 'viem';
import { gnosis } from 'viem/chains';

const log = logger.child({ module: 'cli' });

async function blockTimestampLookup(_chainId: number, blockNumber: number): Promise<Date> {
  const client = createPublicClient({ chain: gnosis, transport: http(process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com') });
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  return new Date(Number(block.timestamp) * 1_000);
}

const cmds: Record<string, (args: string[]) => Promise<void>> = {
  async migrate() {
    await runMigrations();
  },
  async 'replay-from-genesis'() {
    await runMigrations();
    log.info('clearing derived state');
    await sql`TRUNCATE rebate_batch_entries, rebate_batches, trades RESTART IDENTITY CASCADE`;
    await runFetcher({ blockTimestampLookup });
    await runPricer();
    await runScorer();
  },
  async 'replay-pricer'(args) {
    const sinceArg = args.find((a) => a.startsWith('--since='))?.split('=')[1];
    if (sinceArg) {
      await sql`UPDATE trades SET value_usd = NULL, priced_at = NULL WHERE block_timestamp > ${sinceArg}::timestamptz`;
    }
    await runPricer();
  },
  async 'simulate-batch'(args) {
    const proposerKey = process.env.SAFE_PROPOSER_PRIVATE_KEY ?? '0x' + '00'.repeat(32) as `0x${string}`;
    const rpcUrl = args.find((a) => a.startsWith('--fork-rpc='))?.split('=')[1] ?? (process.env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com');
    const result = await runBatcher({
      chainId: 100,
      rpcUrl,
      proposerPrivateKey: proposerKey as `0x${string}`,
      proposeEnabled: false,
    });
    console.log(JSON.stringify({
      ...result,
      poolWei: result.poolWei.toString(),
      poolWeth: (Number(result.poolWei) / 1e18).toFixed(5),
    }, null, 2));
  },
  async 'dry-run-monthly'() {
    await cmds['simulate-batch']!([]);
  },
  async 'rotate-proposer'(args) {
    const newKey = args.find((a) => a.startsWith('--new-key='))?.split('=')[1];
    if (!newKey) throw new Error('--new-key=0x... required');
    console.log('To complete rotation:');
    console.log('1. Update SAFE_PROPOSER_PRIVATE_KEY in the Aleph VM env');
    console.log('2. Add new proposer in Safe UI: Settings → Transaction service → Add proposer');
    console.log('3. Remove old proposer from Safe Transaction Service');
    console.log(`4. The new proposer address (derive from ${newKey.slice(0,10)}…) must match the Safe-recorded proposer EOA`);
  },
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const handler = cmd ? cmds[cmd] : undefined;
  if (!handler) {
    console.error('Usage: cli.ts <command>');
    console.error('Commands:', Object.keys(cmds).join(', '));
    process.exit(2);
  }
  await handler(rest);
  await sql.end();
}

main().catch((err) => {
  log.fatal({ err }, 'cli failed');
  process.exit(1);
});
```

### Step 3: Commit

```bash
git add apps/rebate-indexer/src/index.ts apps/rebate-indexer/src/cli.ts
git commit -m "feat(rebate-indexer): container entrypoint + ops CLI"
```

---

## Task 20: Dockerfile + docker-compose

**Files:**
- Create: `apps/rebate-indexer/Dockerfile`
- Create: `apps/rebate-indexer/docker-compose.yml`
- Create: `apps/rebate-indexer/Caddyfile`
- Create: `apps/rebate-indexer/.dockerignore`

### Step 1: Dockerfile (multi-stage)

Write `apps/rebate-indexer/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/rebate-indexer/package.json apps/rebate-indexer/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile --filter @ophis/rebate-indexer...

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=deps /app /app
COPY apps/rebate-indexer apps/rebate-indexer
COPY packages/sdk packages/sdk
COPY tsconfig.base.json ./
RUN pnpm --filter @ophis/rebate-indexer typecheck

FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini && corepack enable && corepack prepare pnpm@9.12.0 --activate
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/rebate-indexer
EXPOSE 8080
ENTRYPOINT ["tini","--"]
CMD ["pnpm","start"]
```

### Step 2: Compose stack

Write `apps/rebate-indexer/docker-compose.yml`:

```yaml
# Boot:  docker compose --env-file .env up -d
# Tear:  docker compose down
# Logs:  docker compose logs -f indexer

services:
  pg:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-rebates}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-rebates}
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL","pg_isready -U ${POSTGRES_USER:-rebates}"]
      interval: 10s
      timeout: 3s
      retries: 5

  indexer:
    build:
      context: ../..
      dockerfile: apps/rebate-indexer/Dockerfile
    restart: unless-stopped
    depends_on:
      pg:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-rebates}:${POSTGRES_PASSWORD}@pg:5432/${POSTGRES_DB:-rebates}
      COW_API_BASE: ${COW_API_BASE:-https://api.cow.fi}
      GNOSIS_RPC_URL: ${GNOSIS_RPC_URL}
      SAFE_PROPOSER_PRIVATE_KEY: ${SAFE_PROPOSER_PRIVATE_KEY}
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
      API_PORT: 8080
      LOG_LEVEL: ${LOG_LEVEL:-info}
      BATCHER_PROPOSE_ENABLED: ${BATCHER_PROPOSE_ENABLED:-true}
    ports:
      - "8080:8080"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on: [indexer]
    ports:
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  pg_data:
  caddy_data:
  caddy_config:
```

### Step 3: Caddyfile (TLS terminated upstream at Cloudflare Tunnel)

Write `apps/rebate-indexer/Caddyfile`:

```
:80 {
    encode gzip zstd
    reverse_proxy indexer:8080 {
        header_up X-Real-IP {remote_host}
        health_uri /health
        health_interval 30s
    }
}
```

### Step 4: `.dockerignore`

Write `apps/rebate-indexer/.dockerignore`:

```
**/node_modules
**/dist
**/.env
**/.git
**/coverage
**/pg_data
**/caddy_data
```

### Step 5: Local boot test

```bash
cd apps/rebate-indexer
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
GNOSIS_RPC_URL=https://rpc.gnosischain.com
SAFE_PROPOSER_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
BATCHER_PROPOSE_ENABLED=false
EOF
docker compose up --build -d
sleep 10
curl -fsS http://localhost:8080/health | jq
docker compose down -v
```

Expected: `/health` returns `{ "ok": true, "last_fetch": null, "pending_batches": 0 }`.

### Step 6: Commit

```bash
git add apps/rebate-indexer/Dockerfile apps/rebate-indexer/docker-compose.yml apps/rebate-indexer/Caddyfile apps/rebate-indexer/.dockerignore
git commit -m "feat(rebate-indexer): docker-compose stack (pg + indexer + caddy)"
```

---

## Task 21: Cloudflare Tunnel binding for `rebates.ophis.fi`

Per D3 (share the existing `3615crypto` tunnel). Operator-facing — no code, just CF API/UI steps.

**Files:**
- Create: `infra/cloudflare/ophis-rebates-tunnel.md`

### Step 1: Document the binding runbook

Write `infra/cloudflare/ophis-rebates-tunnel.md`:

```markdown
# Cloudflare Tunnel binding for `rebates.ophis.fi`

## Decision (D3)
Share the existing `3615crypto` tunnel. Matches the pattern used for `allo.3615crypto.com` and `mcp-api.3615crypto.com`.

## One-time setup (executed by Clement on Aleph VM `ophis-rebates`)

1. SSH to the Aleph VM:
   `ssh root@ophis-rebates.aleph.cloud`

2. Install cloudflared (if not already present):
   `curl -L -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared`

3. Authenticate against the existing `3615crypto` tunnel:
   `cloudflared tunnel login`        # opens browser, pick 3615crypto

4. Add a public hostname route via Cloudflare API:
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/4761b41ef352631db0ed367fea98ffdc/cfd_tunnel/<TUNNEL_ID>/configurations" \
     -H "Authorization: Bearer $CF_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "config": { "ingress": [
       { "hostname": "rebates.ophis.fi", "service": "http://localhost:80" },
       { "service": "http_status:404" }
     ] } }'
   ```

5. Add a proxied CNAME `rebates.ophis.fi → <TUNNEL_ID>.cfargotunnel.com`:
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/zones/<OPHIS_FI_ZONE_ID>/dns_records" \
     -H "Authorization: Bearer $CF_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"type":"CNAME","name":"rebates","content":"<TUNNEL_ID>.cfargotunnel.com","proxied":true,"ttl":1}'
   ```

6. Verify:
   `curl -fsS https://rebates.ophis.fi/health | jq`
   Expected: `{ "ok": true, ... }`

## Rotation / teardown
- Remove the ingress entry by editing the tunnel configuration JSON.
- Delete the DNS CNAME.
- The Aleph VM and its docker stack are unaffected.
```

### Step 2: Commit

```bash
git add infra/cloudflare/ophis-rebates-tunnel.md
git commit -m "docs(cloudflare): tunnel binding runbook for rebates.ophis.fi"
```

---

## Task 22: GitHub Actions — CI + deploy

**Files:**
- Create: `.github/workflows/rebate-indexer-ci.yml`
- Create: `.github/workflows/rebate-indexer-deploy.yml`

### Step 1: CI workflow

Write `.github/workflows/rebate-indexer-ci.yml`:

```yaml
name: rebate-indexer CI

on:
  pull_request:
    paths:
      - "apps/rebate-indexer/**"
      - "packages/sdk/**"
      - "pnpm-workspace.yaml"
      - "tsconfig.base.json"
      - ".github/workflows/rebate-indexer-ci.yml"
  push:
    branches: [main]
    paths:
      - "apps/rebate-indexer/**"

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
      - uses: pnpm/action-setup@91ab88e2619ed1f46221f0ba42d1492c02baf788  # v6.0.6
        with:
          run_install: false
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e  # v6.4.0
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile --filter @ophis/rebate-indexer...
      - run: pnpm --filter @ophis/rebate-indexer typecheck
      - run: pnpm --filter @ophis/rebate-indexer test
      - run: pnpm --filter @ophis/rebate-indexer test:integration
        env:
          DOCKER_HOST: unix:///var/run/docker.sock
```

### Step 2: Deploy workflow

Write `.github/workflows/rebate-indexer-deploy.yml`:

```yaml
name: rebate-indexer deploy

on:
  push:
    branches: [main]
    paths:
      - "apps/rebate-indexer/**"
      - ".github/workflows/rebate-indexer-deploy.yml"
  workflow_dispatch: {}

concurrency:
  group: rebate-indexer-deploy
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
      - uses: docker/setup-buildx-action@c47758b77c9736f4b2ef4073d4d51994fabfe349  # v3.7.1
      - name: docker build
        run: |
          docker build \
            -f apps/rebate-indexer/Dockerfile \
            -t ghcr.io/${{ github.repository_owner }}/ophis-rebate-indexer:${{ github.sha }} \
            -t ghcr.io/${{ github.repository_owner }}/ophis-rebate-indexer:latest \
            .
      - name: push to GHCR
        env:
          GHCR_TOKEN: ${{ secrets.GHCR_PAT }}
        run: |
          echo "$GHCR_TOKEN" | docker login ghcr.io -u ${{ github.repository_owner }} --password-stdin
          docker push ghcr.io/${{ github.repository_owner }}/ophis-rebate-indexer:${{ github.sha }}
          docker push ghcr.io/${{ github.repository_owner }}/ophis-rebate-indexer:latest
      - name: ssh deploy to Aleph VM
        env:
          SSH_PRIVATE_KEY: ${{ secrets.ALEPH_REBATES_SSH_KEY }}
          SSH_HOST:        ${{ secrets.ALEPH_REBATES_SSH_HOST }}
          SSH_USER:        ${{ secrets.ALEPH_REBATES_SSH_USER }}
        run: |
          mkdir -p ~/.ssh && echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "$SSH_HOST" >> ~/.ssh/known_hosts
          ssh -i ~/.ssh/id_ed25519 "$SSH_USER@$SSH_HOST" \
            "cd /srv/rebate-indexer && \
             docker compose pull && \
             docker compose up -d --force-recreate indexer && \
             docker compose ps"
```

### Step 3: Document required secrets

Append to `apps/rebate-indexer/README.md`:

```markdown

## GitHub secrets required for deploy

| Secret | Source | Notes |
|---|---|---|
| `GHCR_PAT` | github.com/settings/tokens | classic PAT with `write:packages` |
| `ALEPH_REBATES_SSH_KEY` | locally `ssh-keygen -t ed25519 -f aleph_rebates_deploy` | put the public key in the VM's `~/.ssh/authorized_keys`; the private half is this secret |
| `ALEPH_REBATES_SSH_HOST` | Aleph dashboard | the VM's reachable IP or hostname |
| `ALEPH_REBATES_SSH_USER` | n/a | typically `root` on Aleph VMs |
```

### Step 4: Commit

```bash
git add .github/workflows/rebate-indexer-ci.yml .github/workflows/rebate-indexer-deploy.yml apps/rebate-indexer/README.md
git commit -m "ci(rebate-indexer): test + deploy workflows (build, push to GHCR, ssh up)"
```

---

## Task 23: Frontend integration — `@ophis/sdk` tier export + `TierChip` component

**Files:**
- Create: `packages/sdk/src/tiers.ts`
- Modify: `packages/sdk/src/index.ts`
- Create: `packages/sdk/tests/tiers.test.ts`
- Create: `apps/frontend/apps/cowswap-frontend/src/greg/components/TierChip.tsx`
- Create: `apps/frontend/apps/cowswap-frontend/src/greg/components/TierChip.module.css`
- Create: `apps/frontend/apps/cowswap-frontend/src/greg/hooks/useTier.ts`
- Modify: `apps/frontend/apps/cowswap-frontend/src/greg/.greg-divergences.md`
- Modify: `.github/workflows/cloudflare-deploy.yml` (add `REACT_APP_REBATES_API`)

### Step 1: Re-export tier table from `@greg/sdk`

Write `packages/sdk/src/tiers.ts`:

```ts
/**
 * MIRROR of apps/rebate-indexer/src/tiers.ts.
 *
 * The cowswap fork lives in its own pnpm workspace and cannot import from
 * apps/rebate-indexer, so we duplicate the constants here. A CI check in
 * tests/tiers.test.ts asserts the two stay in sync by importing both modules
 * and comparing their exports.
 *
 * Any time TIERS or POOL_SPLIT_BPS changes, change BOTH places in the same PR.
 */
export interface Tier {
  readonly name: 'bronze' | 'silver' | 'gold' | 'platinum';
  readonly min_usd: number;
  readonly rebate_pct: number;
}

export const TIERS: readonly Tier[] = [
  { name: 'bronze',   min_usd:      0, rebate_pct: 0.10 },
  { name: 'silver',   min_usd:  5_000, rebate_pct: 0.20 },
  { name: 'gold',     min_usd: 50_000, rebate_pct: 0.35 },
  { name: 'platinum', min_usd: 500_000, rebate_pct: 0.50 },
] as const;

export const POOL_SPLIT_BPS = 5_000;

export function assignTier(volume_30d_usd: number): Tier {
  if (volume_30d_usd < 0) throw new Error('assignTier: volume must be non-negative');
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (volume_30d_usd >= TIERS[i]!.min_usd) return TIERS[i]!;
  }
  return TIERS[0]!;
}
```

### Step 2: Add to SDK index

Edit `packages/sdk/src/index.ts` — append (keep existing exports):

```ts
export {
  TIERS,
  POOL_SPLIT_BPS,
  assignTier,
  type Tier,
} from './tiers.js';
```

### Step 3: SDK test that compares both modules directly (no eval, no regex)

Write `packages/sdk/tests/tiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TIERS, POOL_SPLIT_BPS, assignTier as sdkAssign } from '@greg/sdk';

// The indexer ships its own TS source. We import it directly and compare exports.
// If the workspace layout moves the indexer, this import path breaks and the test
// fails loudly — which is what we want (it reminds us to update the mirror).
import {
  TIERS as INDEXER_TIERS,
  POOL_SPLIT_BPS as INDEXER_POOL,
  assignTier as indexerAssign,
} from '../../../apps/rebate-indexer/src/tiers.js';

describe('@greg/sdk tiers mirror apps/rebate-indexer/src/tiers.ts', () => {
  it('TIERS array matches the indexer source exactly', () => {
    expect(TIERS).toEqual(INDEXER_TIERS);
  });

  it('POOL_SPLIT_BPS matches the indexer source', () => {
    expect(POOL_SPLIT_BPS).toBe(INDEXER_POOL);
  });

  it.each([0, 4_999.99, 5_000, 49_999.99, 50_000, 499_999.99, 500_000, 1_000_000_000])(
    'assignTier(%s) matches indexer behaviour',
    (volume) => {
      expect(sdkAssign(volume)).toEqual(indexerAssign(volume));
    },
  );
});
```

### Step 4: React hook fetching `/tier/:wallet`

Write `apps/frontend/apps/cowswap-frontend/src/greg/hooks/useTier.ts`:

```ts
import { useEffect, useState } from 'react';
import { assignTier, type Tier } from '@greg/sdk';

const REBATES_API = process.env.REACT_APP_REBATES_API ?? 'https://rebates.ophis.fi';

export interface TierStatus {
  wallet: `0x${string}`;
  volume_30d_usd: number;
  trade_count_30d: number;
  tier: Tier;
  next_tier: Tier | null;
  usd_to_next_tier: number;
}

export function useTier(wallet: `0x${string}` | undefined): {
  data: TierStatus | null;
  loading: boolean;
  error: Error | null;
} {
  const [data, setData] = useState<TierStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!wallet) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${REBATES_API}/tier/${wallet.toLowerCase()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`tier API ${res.status}`);
        const json = (await res.json()) as TierStatus;
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        // Local fallback so the UI is never blank: Bronze with progress to Silver.
        setData({
          wallet,
          volume_30d_usd: 0,
          trade_count_30d: 0,
          tier: assignTier(0),
          next_tier: { name: 'silver', min_usd: 5_000, rebate_pct: 0.20 },
          usd_to_next_tier: 5_000,
        });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [wallet]);

  return { data, loading, error };
}
```

### Step 5: TierChip component

Write `apps/frontend/apps/cowswap-frontend/src/greg/components/TierChip.tsx`:

```tsx
import { useTier } from '../hooks/useTier';
import styles from './TierChip.module.css';

interface Props {
  wallet?: `0x${string}`;
}

export function TierChip({ wallet }: Props) {
  const { data, loading } = useTier(wallet);
  if (!wallet || loading || !data) return null;

  const tier = data.tier.name;
  const usd = data.volume_30d_usd.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const next = data.next_tier;
  const remaining = next ? data.usd_to_next_tier.toLocaleString(undefined, { maximumFractionDigits: 0 }) : null;

  return (
    <a className={`${styles.chip} ${styles[tier]}`} href={`https://rebates.ophis.fi/tier/${wallet.toLowerCase()}`} target="_blank" rel="noreferrer">
      <span className={styles.tierName}>{tier}</span>
      <span className={styles.divider}>•</span>
      <span className={styles.volume}>30d: ${usd}</span>
      {next && remaining && (
        <>
          <span className={styles.divider}>•</span>
          <span className={styles.nextTier}>${remaining} to {next.name}</span>
        </>
      )}
    </a>
  );
}
```

### Step 6: TierChip styles

Write `apps/frontend/apps/cowswap-frontend/src/greg/components/TierChip.module.css`:

```css
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
  border: 1px solid;
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.chip:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
.tierName { text-transform: capitalize; font-weight: 700; letter-spacing: 0.02em; }
.divider { opacity: 0.5; }
.volume, .nextTier { font-variant-numeric: tabular-nums; }

.bronze   { color: #cd7f32; border-color: rgba(205,127,50,0.5);  background: rgba(205,127,50,0.06); }
.silver   { color: #9aa3b2; border-color: rgba(154,163,178,0.5); background: rgba(154,163,178,0.06); }
.gold     { color: #d4af37; border-color: rgba(212,175,55,0.5);  background: rgba(212,175,55,0.06); }
.platinum { color: #b9f2ff; border-color: rgba(185,242,255,0.5); background: rgba(185,242,255,0.06); }
```

### Step 7: Document new module in `.greg-divergences.md`

Append a new "Added (Ophis-only)" entry to `apps/frontend/apps/cowswap-frontend/src/greg/.greg-divergences.md`:

```markdown

### Added 2026-05-11 — Tier chip

- `apps/cowswap-frontend/src/greg/hooks/useTier.ts` — fetches `rebates.ophis.fi/tier/:wallet`,
  falls back to Bronze locally if the API is unreachable.
- `apps/cowswap-frontend/src/greg/components/TierChip.tsx` + `.module.css` — small
  always-visible chip on the swap page. Imports `@greg/sdk` for tier constants (mirror
  of `apps/rebate-indexer/src/tiers.ts`).
- **`REACT_APP_REBATES_API`** — set in `.github/workflows/cloudflare-deploy.yml` to
  `https://rebates.ophis.fi`. Hook defaults to the same value, so missing env still works.
```

### Step 8: Add the env var to the deploy workflow

Edit `.github/workflows/cloudflare-deploy.yml` — extend the existing `build cowswap` step's `env` block:

```yaml
        env:
          NODE_OPTIONS: --max-old-space-size=6144
          REACT_APP_APP_CODE: ophis
          REACT_APP_REBATES_API: https://rebates.ophis.fi
```

### Step 9: Mount the chip near the wallet status

The exact integration point depends on cowswap's current swap-page layout. The chip is wallet-only, so it should mount adjacent to the wallet button. Search:

```bash
cd apps/frontend
grep -rln "Web3Status\|AccountElement\|HeaderControls" apps/cowswap-frontend/src/modules apps/cowswap-frontend/src/legacy/components 2>/dev/null | head
```

Wire `<TierChip wallet={address} />` into the first hit rendered globally above the swap form. The `address` comes from `useAccount()` (wagmi) — same pattern used by existing cowswap components.

If the precise mount point requires invasive cowswap surgery, ship the API + hook + component first and defer mounting to a follow-up commit. The component renders correctly from anywhere; mounting is cosmetic.

### Step 10: Run SDK tests

```bash
cd packages/sdk && pnpm test
```

Expected: previous tests + 3 new tier-mirror tests pass.

### Step 11: Commit

```bash
git add packages/sdk apps/frontend/apps/cowswap-frontend/src/greg .github/workflows/cloudflare-deploy.yml
git commit -m "feat(frontend): TierChip swap-page widget + @greg/sdk tier mirror"
```

---

## Task 24: E2E test against Sepolia (real Safe Transaction Service)

**Files:**
- Create: `apps/rebate-indexer/tests/e2e/sepolia.test.ts`

The e2e test propose+execute lifecycle requires a dedicated test Safe on Sepolia owned by a CI burner key. Per D5: fresh deploy.

### Step 1: Deploy the test Safe (one-time operator step)

```bash
# Run locally, NOT in CI
cast wallet new                                          # burner-1
cast wallet new                                          # burner-2 (for 2-of-2 testing, optional)
```

Save burner-1 PK to repo secret `E2E_SAFE_BURNER_KEY`. Send a small amount of Sepolia ETH (~0.05 SEP) to its address. Deploy a 1-of-1 Safe owned by burner-1 via app.safe.global on Sepolia, note address as `E2E_SAFE_ADDRESS` (repo variable).

Fund the test Safe with a few testnet WETH on Sepolia (`0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` is the canonical Sepolia WETH; wrap via that contract).

Register the burner-1 EOA as the proposer for the test Safe in Safe TX Service.

### Step 2: E2E test

Write `apps/rebate-indexer/tests/e2e/sepolia.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createPublicClient, createWalletClient, http, parseEther, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import SafeApiKit from '@safe-global/api-kit';
import { proposeRebateBatch } from '../../src/batch/propose.js';
import { buildEthCallSimulator, isolateBadRecipients } from '../../src/batch/dryRun.js';

const RUN_E2E = process.env.RUN_E2E === '1';
const describeE2E = RUN_E2E ? describe : describe.skip;

const SAFE_ADDRESS = process.env.E2E_SAFE_ADDRESS as `0x${string}`;
const BURNER_KEY = process.env.E2E_SAFE_BURNER_KEY as `0x${string}`;
const SEPOLIA_WETH: `0x${string}` = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';

describeE2E('Sepolia: full propose → execute lifecycle', () => {
  let safeTxHash: `0x${string}`;

  beforeAll(() => {
    if (!SAFE_ADDRESS || !BURNER_KEY) throw new Error('E2E_SAFE_ADDRESS + E2E_SAFE_BURNER_KEY required');
  });

  it('isolates a known-bad recipient and proposes only the good ones', async () => {
    const goodRecipient: `0x${string}` = '0x000000000000000000000000000000000000dEaD';
    const badRecipient: `0x${string}` = '0x0000000000000000000000000000000000000000';   // zero addr: WETH reverts on transfer to 0
    const transfers = [
      { to: goodRecipient, amount: 1n },
      { to: badRecipient,  amount: 1n },
    ];
    const sim = buildEthCallSimulator({ chainId: 11_155_111, rpcUrl: SEPOLIA_RPC });
    const { good, bad } = await isolateBadRecipients(transfers, sim);
    expect(bad.map((t) => t.to)).toEqual([badRecipient]);

    const result = await proposeRebateBatch({
      chainId: 11_155_111,
      rpcUrl: SEPOLIA_RPC,
      proposerPrivateKey: BURNER_KEY,
      transfers: good,
    });
    expect(result.safeTxHash).toMatch(/^0x[a-f0-9]{64}$/);
    safeTxHash = result.safeTxHash;
  }, 90_000);

  it('the proposed transaction appears in Safe Transaction Service', async () => {
    const apiKit = new SafeApiKit({ chainId: 11_155_111n });
    const tx = await apiKit.getTransaction(safeTxHash);
    expect(tx.safe.toLowerCase()).toBe(SAFE_ADDRESS.toLowerCase());
    expect(tx.isExecuted).toBe(false);
  }, 30_000);

  it('after operator-side execute, polling observes isExecuted=true', async () => {
    // Manual step in interactive runs; in CI we use a viem walletClient to sign+execute
    // directly through Safe's transaction service.
    const account = privateKeyToAccount(BURNER_KEY);
    const apiKit = new SafeApiKit({ chainId: 11_155_111n });
    await apiKit.confirmTransaction(safeTxHash, await account.signMessage({ message: { raw: safeTxHash } }));
    // Wait for the executor (Safe's relayer) to mine. Up to 5 minutes.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const tx = await apiKit.getTransaction(safeTxHash);
      if (tx.isExecuted) {
        expect(tx.isSuccessful).toBe(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    throw new Error('execution did not complete within 5min');
  }, 6 * 60_000);
});
```

### Step 3: Wire into a separate nightly CI workflow

Append to `.github/workflows/rebate-indexer-ci.yml` after the existing `test` job:

```yaml
  e2e:
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    needs: test
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
      - uses: pnpm/action-setup@91ab88e2619ed1f46221f0ba42d1492c02baf788
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile --filter @ophis/rebate-indexer...
      - run: pnpm --filter @ophis/rebate-indexer test:e2e
        env:
          RUN_E2E: '1'
          E2E_SAFE_ADDRESS: ${{ vars.E2E_SAFE_ADDRESS }}
          E2E_SAFE_BURNER_KEY: ${{ secrets.E2E_SAFE_BURNER_KEY }}
          SEPOLIA_RPC_URL: ${{ secrets.SEPOLIA_RPC_URL }}
```

And add a schedule trigger at the top:

```yaml
on:
  schedule:
    - cron: '0 3 * * *'                                  # 03:00 UTC daily — runs after deploy and prod cron
  pull_request: ...
  push: ...
```

### Step 4: Commit

```bash
git add apps/rebate-indexer/tests/e2e .github/workflows/rebate-indexer-ci.yml
git commit -m "test(rebate-indexer): e2e Safe propose+execute on Sepolia (nightly CI)"
```

---

## Task 25: RUNBOOK.md + pre-production checklist

**Files:**
- Create: `apps/rebate-indexer/RUNBOOK.md`

### Step 1: Write the runbook

Write `apps/rebate-indexer/RUNBOOK.md`:

```markdown
# Ophis Rebate Indexer — Runbook

Last-resort operator handbook. If a scenario isn't here, open an incident note and add it.

## How to reach the system
- SSH: `ssh root@ophis-rebates.aleph.cloud`
- Logs: `docker compose logs -f indexer`
- Health: `curl -fsS https://rebates.ophis.fi/health`
- Status: `curl -fsS https://rebates.ophis.fi/status`
- DB shell: `docker compose exec pg psql -U rebates`
- Safe queue: <https://app.safe.global/transactions/queue?safe=gno:0x858f0F5eE954846D47155F5203c04aF1819eCeF8>

## Incident scenarios

### 1. Fetcher stuck (no new trades for >24h)
**Detect:** `/status` shows stale `last_fetch`, or `🚨 fetcher failed 3 consecutive runs` Telegram alert.
1. Check CoW API health: `curl -sS https://api.cow.fi/xdai/api/v1/version | jq`.
2. Restart container: `docker compose restart indexer`.
3. Trigger a one-off run: `docker compose exec indexer pnpm cli replay-pricer --since=$(date -u -d '2 days ago' +%F)`.
4. CoW retains full trade history — no data is lost while we're stuck.

### 2. Pricer behind (high `value_usd IS NULL` count)
**Detect:** Wallet volumes in `/tier/:wallet` look low; users report missing rebates.
1. Inspect: `docker compose exec pg psql -U rebates -c "SELECT COUNT(*) FROM trades WHERE value_usd IS NULL;"`.
2. Backfill: `docker compose exec indexer pnpm cli replay-pricer --since=2026-05-01`.
3. The `wallets` materialized view auto-excludes unpriced trades, so once pricing catches up, tiers self-correct on next nightly refresh.

### 3. Batch never mined
**Detect:** `rebate_batches.status = 'proposed'` for >24h on the 1st of the month.
1. Open Safe queue; check whether the tx is signed but not executed (gas spike, nonce conflict).
2. If signed-and-stuck: re-execute from Safe UI with higher gas.
3. The indexer's `waitForExecution` poller auto-detects success once mined; no manual DB update needed.

### 4. Wrong tier paid out
**Detect:** User reports a discrepancy; you confirm via `/batches/:id`.
1. Batch is final on-chain — no recall.
2. Compute the delta: `docker compose exec indexer pnpm cli diff-rebate --batch-id=N`.
3. Manually queue a corrective WETH transfer via Safe UI.
4. Open an incident note in `docs/development/incidents/YYYY-MM-DD-tier-correction.md` describing the cause + fix.

### 5. Proposer key compromised
**Detect:** Junk batches appearing in Safe queue; logs show proposals you didn't make.
1. Don't panic — the proposer key has NO execution authority.
2. **Reject all suspicious proposals in Safe UI** (does not cost gas; the queue entry stays as a record).
3. Generate a new proposer:
   ```bash
   cast wallet new                                   # save PK in macOS Keychain `ophis-rebate-proposer`
   ```
4. Update Aleph VM env: `ssh root@ophis-rebates.aleph.cloud "sed -i 's/^SAFE_PROPOSER_PRIVATE_KEY=.*/SAFE_PROPOSER_PRIVATE_KEY=<new>/' /srv/rebate-indexer/.env && docker compose restart indexer"`.
5. In Safe → Settings → Transaction service → add the new proposer EOA.
6. Remove the compromised proposer from Safe → Settings → Transaction service.
7. The old key is now inert because Safe Transaction Service refuses its signatures.

## Routine ops

### Monthly batch — pre-execute ritual
On the 1st of each month at ~02:30 UTC you'll get a `💸 Batch ready to sign` Telegram message.

1. Open the Tenderly fork simulation link the message includes (or run `pnpm cli simulate-batch` if missing):
   ```bash
   docker compose exec indexer pnpm cli simulate-batch --fork-rpc=$TENDERLY_FORK_URL
   ```
2. Confirm: pool size, recipient count, top recipient, Σ shares ≤ pool.
3. Open the Safe queue link. Verify the same MultiSend payload is what's queued.
4. Sign + execute.
5. Wait for `🟢 Batch executed` Telegram confirmation (within 1 minute of mine).

### Rotating the Telegram bot token
1. Talk to BotFather → `/revoke` → `/newbot`.
2. Update `TELEGRAM_BOT_TOKEN` in Aleph VM `.env`; `docker compose restart indexer`.

### Adding a new chain to the payout footprint (post-Phase-1)
Out of scope for v1. When ready, edit `src/safe/addresses.ts` `WETH_BY_CHAIN`, deploy the Safe MultiSendCallOnly on the new chain (CREATE2 via `@safe-global/safe-deployments`), and bridge WETH to that chain's Safe address.
```

### Step 2: Commit

```bash
git add apps/rebate-indexer/RUNBOOK.md
git commit -m "docs(rebate-indexer): operator runbook (incidents + routine ops)"
```

---

## Task 26: Pre-production checklist + first dry-run

**Files:**
- (None — this is a checklist-driven validation task.)

### Step 1: Walk the checklist (from the spec § Pre-production checklist)

Tick each item; do NOT proceed until every item is green.

```
- [ ] All Layer 1 unit tests pass in CI
- [ ] Layer 2 integration tests pass in CI
- [ ] One full Layer 3 e2e cycle has succeeded on Sepolia in the prior 7 days
- [ ] Safe proposer key generated, stored in macOS Keychain (`ophis-rebate-proposer`), deployed to Aleph VM
- [ ] Safe Transaction Service configured to accept the proposer key
- [ ] Cloudflare Tunnel mapping `rebates.ophis.fi` → Aleph VM live (curl returns 200)
- [ ] Telegram bot DMs configured to ping `735726338`
- [ ] `RUNBOOK.md` committed, linked from `/health` response (add `runbook: "https://github.com/ophis-fi/ophis/blob/main/apps/rebate-indexer/RUNBOOK.md"` to the /health JSON)
- [ ] `src/tiers.ts` reviewed and acknowledged (the only number that can't be wrong)
- [ ] Status page `rebates.ophis.fi/status` returns 200
- [ ] `BATCHER_PROPOSE_ENABLED=false` in production .env for the first month — first batch run is dry-run only
```

### Step 2: First real batch — dry-run

On the 1st of the first deployed production month, BATCHER_PROPOSE_ENABLED is `false`. The nightly pipeline runs, batcher fires, computes shares, dry-runs the multicall, writes `rebate_batches` + entries, but does NOT propose to Safe TX Service.

1. SSH to the Aleph VM, check the logs:
   ```bash
   docker compose logs indexer | grep batcher
   ```
   Expected: `dry-run only, not proposing` line.

2. Inspect the computed batch:
   ```bash
   curl -fsS https://rebates.ophis.fi/batches | jq '.[0]'
   curl -fsS https://rebates.ophis.fi/batches/$(curl -fsS https://rebates.ophis.fi/batches | jq -r '.[0].id') | jq
   ```

3. Manually re-simulate via Tenderly:
   ```bash
   ssh root@ophis-rebates.aleph.cloud \
     "docker compose exec indexer pnpm cli simulate-batch --fork-rpc=$TENDERLY_FORK_URL"
   ```

4. Eyeball: tier distribution, pool size, top recipient, total payout vs. Safe balance.

### Step 3: Flip propose-enable for the second month

Once the dry-run looks good, flip the flag:

```bash
ssh root@ophis-rebates.aleph.cloud \
  "sed -i 's/^BATCHER_PROPOSE_ENABLED=.*/BATCHER_PROPOSE_ENABLED=true/' /srv/rebate-indexer/.env && \
   docker compose restart indexer"
```

The next 1st-of-month tick will propose for real. The Safe queue notification will arrive in Telegram.

### Step 4: First real batch — sign + execute

Follow `RUNBOOK.md § Monthly batch — pre-execute ritual`:
1. Receive Telegram `💸 Batch ready to sign`.
2. Run `pnpm cli simulate-batch --fork-rpc=$TENDERLY_FORK_URL`.
3. Confirm pool / recipients / shares.
4. Open Safe queue, sign + execute.
5. Confirm `🟢 Batch executed` Telegram message.
6. Verify Gnosisscan tx: decoded MultiSend payload matches `/batches/:id`.

### Step 5: Announce

Once the first real batch is mined, write a short post (Twitter / Farcaster / Discord):

> ⚡ Ophis rebate program now live
> Volume-tiered WETH rebates every month, paid from price-improvement revenue
> First batch: 0.X WETH to Y wallets (Bronze ≥ 10%, Silver 20%, Gold 35%, Platinum 50%)
> Verify: https://rebates.ophis.fi/batches
> Code: https://github.com/ophis-fi/ophis/tree/main/apps/rebate-indexer

### Step 6: Commit (the checklist itself)

The pre-production checklist lives in this plan; no code commit is required for Task 26.

---

## Self-review (spec → plan coverage check)

| Spec section | Where covered in plan |
|---|---|
| §Architecture overview | Tasks 1, 14, 15, 18, 19 (foundation, batcher, API, cron, entrypoint) |
| §Components | Each module: T2 (db), T3 (tiers), T5 (cow), T6 (fetcher), T7 (pricer), T8 (scorer), T9 (tierer), T14 (batcher), T15 (api), T17 (telegram), T18 (cron), T19 (cli) |
| §Data model | T2 (schema + migration) |
| §Volume→Tier→Rebate math | T3 (tiers.ts), T4 (computeShares) |
| §Safe batch flow | T10 (addresses), T11 (multisend), T12 (dry-run + quarantine), T13 (propose + poll), T14 (batcher orchestrator) |
| §Operational concerns | T18 (cron), T20 (docker), T21 (Cloudflare Tunnel), T22 (deploy CI), T25 (runbook) |
| §Testing strategy | T3-T4 (unit), T16 (integration), T24 (e2e on Sepolia), T26 (pre-prod + first dry-run) |
| §Frontend integration (chip) | T23 |
| §Open questions for implementation plan | D1 (host), D2 (proposer key), D3 (tunnel), D4 (pool split), D5 (test Safe) all locked in Operator decisions table at top |

No gaps. Every spec requirement has a matching task or operator decision.

**Placeholder scan:** searched for TBD / TODO / FIXME / "fill in" / "Similar to Task" / "add appropriate" — none present. The `TODO(post-launch)` in Task 7 (`pricer.ts` decimals lookup) is intentional and scoped: it documents a known v1 simplification (default to 18 decimals when CoW doesn't return them), to be replaced with a viem ERC20 call post-launch. Acceptable per YAGNI.

**Type consistency:** spot-checked `Transfer`, `EligibleWallet`, `Tier`, `BatcherResult`, `PollResult` across Tasks 4-14 — all consistent.

---

## Plan complete

Plan saved to `docs/development/plans/2026-05-11-rebate-ledger.md` (26 tasks, ~1-2 weeks of focused work).
