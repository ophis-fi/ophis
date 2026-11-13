import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayRateLimiter } from '../../infra/relay-rate-limit/worker.ts';

test('persistent rolling admission survives object restart and expires after a minute', async () => {
  const values = new Map<string, unknown>();
  const clock = { now: 1_000_000, alarm: 0 };
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    setAlarm: async (time: number) => { clock.alarm = time; },
    deleteAll: async () => { values.clear(); },
    transaction: async <T>(run: (store: unknown) => Promise<T>) => run(storage),
  };
  const state = { storage } as unknown as ConstructorParameters<typeof RelayRateLimiter>[0];
  const previous = Date.now;
  Date.now = () => clock.now;
  const admit = async (limiter: RelayRateLimiter) => (await (await limiter.fetch(new Request('https://internal/', { method: 'POST' }))).json()) as { success: boolean };
  try {
    const limiter = new RelayRateLimiter(state);
    for (const _ of Array.from({ length: 40 })) assert.equal((await admit(limiter)).success, true);
    assert.equal((await admit(limiter)).success, false);
    assert.equal((await admit(new RelayRateLimiter(state))).success, false);
    clock.now += 60_001;
    assert.equal((await admit(limiter)).success, true);
    assert.equal(clock.alarm, clock.now + 60_000);
    // A delayed old alarm must not erase a newly admitted request.
    await limiter.alarm();
    assert.equal(values.size, 1);
    clock.now += 60_001;
    await limiter.alarm();
    assert.equal(values.size, 0);
  } finally { Date.now = previous; }
});

test('limiter is reachable only through a binding and refuses non-POST methods', async () => {
  const limiter = new RelayRateLimiter({} as ConstructorParameters<typeof RelayRateLimiter>[0]);
  assert.equal((await limiter.fetch(new Request('https://internal/'))).status, 405);
});
