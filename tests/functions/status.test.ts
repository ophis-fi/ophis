import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BEATS,
  DAYS,
  SERVICES,
  apply,
  check,
  due,
  type Result,
  type Service,
} from '../../apps/status/core.ts';

const T0 = Date.UTC(2026, 10, 26, 12, 0) / 1000;
const DAY = 86_400;
const a: Service = { id: 'a', name: 'A', group: 0, url: 'https://a.example/', every: 1 };
const b: Service = { id: 'b', name: 'B', group: 1, url: 'https://b.example/', every: 5 };
const up = (id: string): Result => [id, 'up', 100, ''];
const down = (id: string): Result => [id, 'down', 8000, 'timeout'];

test('the list: unique ids, https only, a known group and cadence', () => {
  assert.equal(new Set(SERVICES.map((s) => s.id)).size, SERVICES.length);
  for (const s of SERVICES) {
    assert.match(s.url, /^https:\/\//, s.id);
    assert.ok(s.group >= 0 && s.group < 5, s.id);
    assert.ok([1, 5, 10].includes(s.every), s.id);
  }
});

test('due: each service once per cycle, and a round fits the Free plan', () => {
  const runs = Array.from({ length: 1440 }, (_, minute) => due(minute));
  for (const s of SERVICES) {
    const count = runs.filter((run) => run.includes(s)).length;
    assert.equal(count, 1440 / s.every, s.id);
  }
  // 50 subrequests a run on Workers Free, and every check may be attempted twice.
  const largest = Math.max(...runs.map((run) => run.length));
  assert.ok(largest * 2 <= 50, `largest round: ${largest}`);
  // Checks that run this account's own Worker code, counted in its 100,000 daily requests.
  const metered = SERVICES.filter((s) => s.every === 10).length * 144;
  assert.ok(1440 + metered <= 2500, `daily requests: ${1440 + metered}`);
});

test('apply: counts the day, keeps the last checks, opens and closes an outage', () => {
  let state = apply(undefined, T0, [up('a')], [a, b]);
  assert.deepEqual(
    state.svc.map((e) => [e.id, e.st, e.h, e.d]),
    [
      ['a', 'up', 'u', [[1, 0]]],
      ['b', '', '', [[0, 0]]],
    ],
  );
  assert.equal(state.day, '2026-11-26');

  const before = structuredClone(state);
  const failed = apply(state, T0 + 60, [down('a'), up('b')], [a, b]);
  assert.deepEqual(state, before, 'the previous state is never changed');
  assert.deepEqual(failed.svc[0]?.d, [[2, 1]]);
  assert.equal(failed.svc[0]?.since, T0 + 60);
  assert.deepEqual(failed.ev, [{ id: 'a', name: 'A', from: T0 + 60, to: null, why: 'timeout' }]);

  state = apply(failed, T0 + 120, [down('a')], [a, b]);
  assert.equal(state.ev.length, 1, 'a second failure is the same outage');
  assert.equal(state.svc[0]?.since, T0 + 60);
  assert.equal(state.svc[1]?.st, 'up', 'a service with no result this round keeps its state');

  state = apply(state, T0 + 180, [up('a')], [a, b]);
  assert.equal(state.ev[0]?.to, T0 + 180);
  assert.equal(state.svc[0]?.h, 'uddu');
  assert.deepEqual(state.svc[0]?.d, [[4, 2]]);

  assert.equal(
    apply(state, T0 + 180, [down('a')], [a, b]),
    state,
    'a repeated run changes nothing',
  );
});

test('apply: a new day shifts the history, capped at DAYS and BEATS', () => {
  let state = apply(undefined, T0, [up('a')], [a]);
  state = apply(state, T0 + DAY, [up('a')], [a]);
  assert.deepEqual(state.svc[0]?.d, [
    [1, 0],
    [1, 0],
  ]);

  state = apply(state, T0 + 4 * DAY, [down('a')], [a]);
  assert.deepEqual(state.svc[0]?.d, [
    [1, 1],
    [0, 0],
    [0, 0],
    [1, 0],
    [1, 0],
  ]);

  state = apply(state, T0 + 400 * DAY, [up('a')], [a]);
  assert.equal(state.svc[0]?.d.length, DAYS);
  assert.deepEqual(state.svc[0]?.d[0], [1, 0]);
  assert.deepEqual(state.svc[0]?.d[1], [0, 0]);

  for (let i = 1; i <= 2 * BEATS; i++)
    state = apply(state, T0 + 400 * DAY + i * 60, [up('a')], [a]);
  assert.equal(state.svc[0]?.h.length, BEATS);
});

test('apply: a service that leaves the list goes, and its open outage ends', () => {
  let state = apply(undefined, T0, [down('a'), up('b')], [a, b]);
  state = apply(state, T0 + 60, [up('b')], [b]);
  assert.deepEqual(
    state.svc.map((e) => e.id),
    ['b'],
  );
  assert.equal(state.ev[0]?.to, T0 + 60);
});

/** Runs one check against scripted answers, and reports how many requests it took. */
// Each answer is built when asked for: a cloned Response would never settle its body's cancel().
async function probe(service: Service, ...answers: (() => Response)[]) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => answers[Math.min(calls++, answers.length - 1)]!();
  try {
    const [, st, , why] = await check(service, 0);
    return { st, why, calls };
  } finally {
    globalThis.fetch = original;
  }
}
const status = (code: number) => () => new Response(code === 200 ? 'ok' : null, { status: code });
const fails = (name: string) => () => {
  throw Object.assign(new Error(name), { name });
};
const health = (body: unknown) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body));
const indexer: Service = { ...a, indexer: true };

test('check: the expected status is up, anything else is down only after a second attempt', async () => {
  assert.deepEqual(await probe(a, status(200)), { st: 'up', why: '', calls: 1 });
  assert.deepEqual(await probe(a, status(530)), { st: 'down', why: 'http 530', calls: 2 });
  assert.deepEqual(await probe(a, status(530), status(200)), { st: 'up', why: '', calls: 2 });
  assert.deepEqual(await probe(a, status(302)), { st: 'down', why: 'http 302', calls: 2 });
  const post: Service = { ...a, expect: 405 };
  assert.equal((await probe(post, status(405))).st, 'up');
  assert.deepEqual(await probe(post, status(200)), { st: 'down', why: 'http 200', calls: 2 });
});

test('check: a failure is named with a fixed word, never with what the origin sent', async () => {
  assert.equal((await probe(a, fails('TimeoutError'))).why, 'timeout');
  assert.equal((await probe(a, fails('TypeError'))).why, 'unreachable');
  assert.equal((await probe(indexer, health('<html>secret</html>'))).why, 'bad response');
  assert.equal((await probe(indexer, health('x'.repeat(70_000)))).why, 'bad response');
});

test('check: the indexer is judged on its own health report', async () => {
  assert.equal((await probe(indexer, health({ ok: true, data_fresh: true }))).st, 'up');
  assert.deepEqual(await probe(indexer, health({ ok: true, data_fresh: false })), {
    st: 'warn',
    why: 'data is stale',
    calls: 1,
  });
  assert.deepEqual(await probe(indexer, health({ ok: false, data_fresh: true })), {
    st: 'down',
    why: 'unhealthy',
    calls: 2,
  });
  assert.equal((await probe(indexer, health({ ok: 'true' }))).why, 'unhealthy');
});

test('incidents.json: every hand-written note is one the page will show', () => {
  // The page drops a malformed note without a word (clean() in public/app.js), and a broken
  // file hides them all: during an incident that is the worst moment to find out.
  const file = new URL('../../apps/status/public/incidents.json', import.meta.url);
  const notes: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(notes), 'incidents.json holds a list');
  for (const note of notes as { title?: unknown; status?: unknown; updates?: unknown }[]) {
    assert.equal(typeof note.title, 'string');
    assert.ok(note.status === undefined || typeof note.status === 'string', String(note.title));
    assert.ok(Array.isArray(note.updates) && note.updates.length > 0, String(note.title));
    for (const update of note.updates as { at?: unknown; text?: unknown }[]) {
      assert.equal(typeof update.text, 'string', String(note.title));
      assert.ok(!Number.isNaN(Date.parse(String(update.at))), `${note.title}: ${update.at}`);
    }
  }
});
