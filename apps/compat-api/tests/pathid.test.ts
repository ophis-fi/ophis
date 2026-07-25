import { describe, expect, it } from 'vitest';

import { mintPathId, verifyPathId } from '../src/pathid.js';
import { CompatError, type PathIdPayload } from '../src/types.js';

const KEY = 'test-key-current';
const OLD_KEY = 'test-key-previous';
const NOW = 1_800_000_000;

const payload = (overrides: Partial<PathIdPayload> = {}): PathIdPayload => ({
  v: 1,
  cid: 10,
  usr: '0x931e9f531cdd4835Def0dEDE1452BA8aFbe5ff9b',
  st: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  bt: '0x4200000000000000000000000000000000000006',
  ssa: '1000000000',
  sba: '536512439786768500',
  qba: '538126832449298940',
  fee: '2260',
  slp: 30,
  ref: 'odos123',
  pf: null,
  qid: 9858,
  iat: NOW,
  exp: NOW + 60,
  ...overrides,
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof CompatError) return err.code;
    throw err;
  }
  throw new Error('expected a CompatError');
};

describe('pathId', () => {
  it('round-trips a payload', async () => {
    const token = await mintPathId(payload(), KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const back = await verifyPathId(token, [KEY], NOW);
    expect(back).toEqual(payload());
  });

  it('round-trips a mapped partner-fee entry', async () => {
    const pf = { volumeBps: 10, recipient: '0x000000000000000000000000000000000000dEaD' } as const;
    const token = await mintPathId(payload({ pf }), KEY);
    const back = await verifyPathId(token, [KEY], NOW);
    expect(back.pf).toEqual(pf);
  });

  it('normalizes a token minted without pf (older token) to pf: null', async () => {
    // Simulate a pre-mapping token: mint a payload with pf omitted from the JSON.
    const legacy = payload();
    delete (legacy as unknown as Record<string, unknown>).pf;
    const token = await mintPathId(legacy, KEY);
    const back = await verifyPathId(token, [KEY], NOW);
    expect(back.pf).toBeNull();
  });

  it('rejects tampered payloads', async () => {
    const token = await mintPathId(payload(), KEY);
    const [body, mac] = token.split('.');
    // Flip the amount inside the payload but keep the original MAC.
    const decoded = JSON.parse(
      Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString(),
    ) as PathIdPayload;
    decoded.sba = '999999999999999999999';
    const forgedBody = Buffer.from(JSON.stringify(decoded))
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    expect(await codeOf(verifyPathId(`${forgedBody}.${mac}`, [KEY], NOW))).toBe('PATH_ID_INVALID');
  });

  it('rejects tokens signed with an unknown key', async () => {
    const token = await mintPathId(payload(), 'some-other-key');
    expect(await codeOf(verifyPathId(token, [KEY, OLD_KEY], NOW))).toBe('PATH_ID_INVALID');
  });

  it('honors the two-key rotation window', async () => {
    const token = await mintPathId(payload(), OLD_KEY);
    const back = await verifyPathId(token, [KEY, OLD_KEY], NOW);
    expect(back.qid).toBe(9858);
  });

  it('expires', async () => {
    const token = await mintPathId(payload({ exp: NOW + 10 }), KEY);
    expect(await codeOf(verifyPathId(token, [KEY], NOW + 11))).toBe('PATH_ID_EXPIRED');
    // still valid at the boundary
    const back = await verifyPathId(token, [KEY], NOW + 10);
    expect(back.exp).toBe(NOW + 10);
  });

  it('rejects garbage tokens', async () => {
    for (const bad of ['', 'a', 'a.b.c', '!!.??', `${'A'.repeat(9000)}.AAAA`]) {
      expect(await codeOf(verifyPathId(bad, [KEY], NOW))).toBe('PATH_ID_INVALID');
    }
  });

  it('rejects a structurally wrong payload even when correctly signed', async () => {
    const bogus = { v: 2, nonsense: true } as unknown as PathIdPayload;
    const token = await mintPathId(bogus, KEY);
    expect(await codeOf(verifyPathId(token, [KEY], NOW))).toBe('PATH_ID_INVALID');
  });
});
