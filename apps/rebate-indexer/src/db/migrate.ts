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
