import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg, stopPg } from './fixtures/pgContainer.js';

// WHY THIS FILE EXISTS.
//
// On 2026-08-31 the nightly scheduler shipped a bug that broke the very thing it
// was written to fix, and NINE rounds of review did not catch it:
//
//   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string
//     ... Received an instance of Date
//     at Buffer.byteLength -> postgres/src/bytes.js -> Bind
//     at nightlyTick (src/cron.ts:554)
//
// A raw JS Date was interpolated into a postgres.js tagged template. PG resolved the
// parameter as text, postgres.js tried to serialise a Date as a string, and every
// tick threw. nightlyTick's own .catch swallowed it, so the pipeline silently never
// ran for 3h20m in production.
//
// It survived review because NOTHING EXECUTED THE SQL: the unit tests are pure
// source/shape assertions, and no integration test covered the scheduler. Static
// analysis -- human or model -- structurally cannot catch a driver-level parameter
// binding fault. Only running the query can.
//
// So these tests execute the REAL queries against a REAL Postgres. If someone
// reintroduces a raw Date binding, this file fails where the unit tests cannot.

let container: StartedPostgreSqlContainer;
let sql: any;
let isNightlyDue: typeof import('../src/cron.js')['isNightlyDue'];
let recordPipelineRun: typeof import('../src/cron.js')['recordPipelineRun'];
let batcherRanThisMonth: typeof import('../src/cron.js')['batcherRanThisMonth'];
let lastNightlyBoundary: typeof import('../src/cron.js')['lastNightlyBoundary'];

const AT = (iso: string) => new Date(Date.parse(iso));

beforeAll(async () => {
  const { container: c, connectionUri } = await startPg();
  container = c;
  process.env.DATABASE_URL = connectionUri;
  ({ sql } = await import('../src/db/index.js'));
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations();
  ({ isNightlyDue, recordPipelineRun, batcherRanThisMonth, lastNightlyBoundary } =
    await import('../src/cron.js'));
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await stopPg(container);
});

beforeEach(async () => {
  await sql`DELETE FROM pipeline_runs`;
});

describe('nightly scheduler SQL executes against a real Postgres', () => {
  it('migration 0043 actually applied serviced_boundary', async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'pipeline_runs'`;
    expect(cols.map((c: any) => c.column_name)).toContain('serviced_boundary');
  });

  it('an EMPTY pipeline_runs is DUE — the real production state at rollout', async () => {
    // This exact query threw ERR_INVALID_ARG_TYPE in production. Executing it is the point.
    await expect(isNightlyDue(AT('2026-09-01T02:00:00Z'))).resolves.toBe(true);
  });

  it('recording a run makes that boundary not due, and the NEXT one due', async () => {
    const sept = AT('2026-09-01T02:00:00Z');
    await recordPipelineRun(false, sept);
    await expect(isNightlyDue(sept)).resolves.toBe(false);
    await expect(isNightlyDue(AT('2026-09-02T02:00:00Z'))).resolves.toBe(true);
  });

  it('stores the boundary as the exact UTC instant under a NON-UTC session timezone', async () => {
    // Deliberately non-UTC. Under Postgres's default UTC, a `::timestamp` cast would
    // pass this just as well as `::timestamptz`, so the assertion would not actually
    // pin the type (Codex review of this file). Asia/Tokyo is +09:00 with no DST, so
    // a timezone-naive write lands 9h off and is unmissable.
    await sql`SET TIME ZONE 'Asia/Tokyo'`;
    try {
      await recordPipelineRun(true, AT('2026-09-01T02:00:00Z'));
      const [row] = await sql<{ b: string }[]>`
        SELECT to_char(serviced_boundary AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS b
        FROM pipeline_runs`;
      expect(row.b).toBe('2026-09-01T02:00:00');
      // and the comparison must still work from the same non-UTC session
      await expect(isNightlyDue(AT('2026-09-01T02:00:00Z'))).resolves.toBe(false);
      await expect(isNightlyDue(AT('2026-09-02T02:00:00Z'))).resolves.toBe(true);
    } finally {
      await sql`SET TIME ZONE 'UTC'`;
    }
  });

  it('the due-check reads the LATEST serviced boundary, not the earliest', async () => {
    // With a single row MAX and MIN are indistinguishable; two rows pin it.
    await recordPipelineRun(false, AT('2026-09-01T02:00:00Z'));
    await recordPipelineRun(false, AT('2026-09-03T02:00:00Z'));
    await expect(isNightlyDue(AT('2026-09-03T02:00:00Z'))).resolves.toBe(false);
    await expect(isNightlyDue(AT('2026-09-04T02:00:00Z'))).resolves.toBe(true);
  });

  it('serviced_boundary is timezone-AWARE in the schema, not a naive timestamp', async () => {
    const [col] = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
       WHERE table_name = 'pipeline_runs' AND column_name = 'serviced_boundary'`;
    expect(col.data_type).toBe('timestamp with time zone');
  });

  it('batcherRanThisMonth is bounded to the serviced month at BOTH ends', async () => {
    // A September run completing in October: ran_at is October, serviced_boundary is
    // September. An unbounded ran_at filter would read this as "October's batcher ran"
    // and skip the monthly section for the rest of October.
    await sql`INSERT INTO pipeline_runs (first_of_month, ran_at, serviced_boundary)
              VALUES (true, '2026-10-01T01:50:00Z'::timestamptz, '2026-09-30T02:00:00Z'::timestamptz)`;
    await expect(batcherRanThisMonth(AT('2026-09-15T02:00:00Z'))).resolves.toBe(true);
    await expect(batcherRanThisMonth(AT('2026-10-02T02:00:00Z'))).resolves.toBe(false);
  });

  it('a LATER month\'s run does not satisfy an EARLIER month — the upper bound', async () => {
    // This is what the upper bound actually protects, and the case the first version
    // of this test missed: mutation-testing it by deleting the `<` clause left the
    // suite green. The lower bound alone already handles "September row, asked about
    // October". The upper bound handles the reverse: an OCTOBER row must not be read
    // as proof that SEPTEMBER's batcher ran, or a missed September cycle is skipped
    // for good.
    await sql`INSERT INTO pipeline_runs (first_of_month, ran_at, serviced_boundary)
              VALUES (true, '2026-10-01T02:05:00Z'::timestamptz, '2026-10-01T02:00:00Z'::timestamptz)`;
    await expect(batcherRanThisMonth(AT('2026-10-05T02:00:00Z'))).resolves.toBe(true);
    await expect(batcherRanThisMonth(AT('2026-09-15T02:00:00Z'))).resolves.toBe(false);
  });

  it('the month window is UTC-pinned, not session-timezone dependent', async () => {
    // date_trunc('month', <timestamptz>) uses the SESSION timezone. Our boundaries are
    // 02:00 UTC, which under a negative offset is the previous day locally, so an
    // unpinned truncation puts a 1st-of-September boundary in AUGUST's window:
    //   SET TIME ZONE 'America/New_York';
    //   date_trunc('month','2026-09-01T02:00:00Z'::timestamptz) -> 2026-08-01
    // That would evaluate September's monthly money gate against August.
    await sql`INSERT INTO pipeline_runs (first_of_month, ran_at, serviced_boundary)
              VALUES (true, '2026-09-01T02:05:00Z'::timestamptz, '2026-09-01T02:00:00Z'::timestamptz)`;
    await sql`SET TIME ZONE 'America/New_York'`;
    try {
      // September's batcher DID run; August's did not. Neither answer may move with tz.
      await expect(batcherRanThisMonth(AT('2026-09-01T02:00:00Z'))).resolves.toBe(true);
      await expect(batcherRanThisMonth(AT('2026-08-15T02:00:00Z'))).resolves.toBe(false);
    } finally {
      await sql`SET TIME ZONE 'UTC'`;
    }
  });

  it('only first_of_month rows count as a completed batcher step', async () => {
    await recordPipelineRun(false, AT('2026-09-01T02:00:00Z'));
    await expect(batcherRanThisMonth(AT('2026-09-01T02:00:00Z'))).resolves.toBe(false);
    await recordPipelineRun(true, AT('2026-09-02T02:00:00Z'));
    await expect(batcherRanThisMonth(AT('2026-09-02T02:00:00Z'))).resolves.toBe(true);
  });

  it('a run crossing 02:00 cannot satisfy two boundaries', async () => {
    // Started 01:50 servicing Aug 31, finished 02:30 (ran_at past Sept 1's boundary).
    // Inferring from ran_at would mark Sept 1 done; serviced_boundary must not.
    await sql`INSERT INTO pipeline_runs (first_of_month, ran_at, serviced_boundary)
              VALUES (false, '2026-09-01T02:30:00Z'::timestamptz, '2026-08-31T02:00:00Z'::timestamptz)`;
    await expect(isNightlyDue(AT('2026-09-01T02:00:00Z'))).resolves.toBe(true);
  });

  it('the boundary the scheduler computes round-trips through the real queries', async () => {
    const b = lastNightlyBoundary(Date.parse('2026-09-01T09:05:00Z'));
    expect(b.toISOString()).toBe('2026-09-01T02:00:00.000Z');
    await expect(isNightlyDue(b)).resolves.toBe(true);
    await recordPipelineRun(false, b);
    await expect(isNightlyDue(b)).resolves.toBe(false);
  });
});
