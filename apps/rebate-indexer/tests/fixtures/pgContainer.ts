import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

/**
 * Start a Postgres testcontainer hardened against the two flake modes seen in CI:
 *   1. ECONNREFUSED on the published port. getConnectionUri() returns
 *      '...@localhost:PORT', and Node resolves 'localhost' to ::1 (IPv6) first,
 *      but testcontainers publishes the port on 127.0.0.1 only -> the IPv6 attempt
 *      is refused. Under CI load the port can also briefly refuse even after the
 *      'ready to accept connections' log fires. We pin 127.0.0.1 and then probe a
 *      real 'select 1' with backoff before returning, so callers only ever see a
 *      connectable DB.
 *   2. Teardown race. RYUK is disabled (TESTCONTAINERS_RYUK_DISABLED=true), so
 *      vitest teardown and testcontainers can both try to remove the container ->
 *      'HTTP 409 removal already in progress' / 'no such container'. stopPg()
 *      swallows that so a cleanup race never reds an otherwise-green suite.
 */
export async function startPg(): Promise<{ container: StartedPostgreSqlContainer; connectionUri: string }> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').withStartupTimeout(120_000).start();
  const connectionUri = container.getConnectionUri().replace('//localhost:', '//127.0.0.1:');
  const probe = postgres(connectionUri, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  try {
    let lastErr: unknown;
    for (let i = 0; i < 40; i++) {
      try { await probe`select 1`; lastErr = undefined; break; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500)); }
    }
    if (lastErr) throw lastErr;
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
  return { container, connectionUri };
}

/** Best-effort, idempotent teardown: swallow the RYUK-disabled double-removal 409 / already-gone. */
export async function stopPg(container?: StartedPostgreSqlContainer): Promise<void> {
  try {
    await container?.stop({ timeout: 10_000 });
  } catch {
    /* container already being removed / gone -- cleanup race, not a test failure */
  }
}
