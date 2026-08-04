import { test, expect, afterEach, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';

// Captured INSERT bindings so a test can assert what would be persisted without a DB.
let lastInsert: readonly unknown[] | undefined;
// Rows the mocked SELECT on reward_claims returns (drives the export tests).
let exportRows: Record<string, string>[] = [];
// Lifetime fee-bearing volume the mocked XP query reports, in USD.
let volumeUsd = '0';

vi.mock('../src/db/index.js', () => ({
  sql: Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('AS accepted')) return [{ accepted: true }];
    if (text.includes('COALESCE(SUM(value_usd), 0)::text')) return [{ vol: volumeUsd }];
    if (text.includes('INSERT INTO reward_claims')) {
      lastInsert = values;
      return [{ first_claim: true }];
    }
    if (text.includes('FROM reward_claims')) return exportRows;
    return [];
  }, {
    unsafe: async () => [],
  }),
  db: { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => [] }), where: async () => [] }) }) },
  schema: { rebateBatches: 'rebateBatches', rebateBatchEntries: 'rebateBatchEntries' },
}));

vi.mock('../src/tierer.js', () => ({
  getWalletStatus: async () => ({ tier: { name: 'none' }, volume_30d_usd: 0 }),
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  lastInsert = undefined;
  exportRows = [];
  volumeUsd = '0';
  delete process.env.REBATE_INDEXER_ADMIN_TOKEN;
});

const { buildApiServer } = await import('../src/api.js');

// A throwaway key: the claim endpoint verifies a real EIP-191 signature, so the
// tests have to produce one rather than stub the recovery out.
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const WALLET = account.address.toLowerCase();

// The signed message BINDS the destination email, so the helper takes it too.
async function signClaim(
  rewardId: string,
  issued: number,
  email = 'trader@example.com',
  wallet = WALLET,
): Promise<string> {
  return account.signMessage({
    message: `Ophis claim reward ${rewardId} for ${email}\nAddress: ${wallet}\nIssued: ${issued}`,
  });
}

async function claim(body: Record<string, unknown>): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  app ??= await buildApiServer();
  const res = await app.inject({ method: 'POST', url: '/rewards/claim', payload: body });
  return { statusCode: res.statusCode, json: JSON.parse(res.body) };
}

function validBody(issued: number, signature: string): Record<string, unknown> {
  return {
    wallet: WALLET,
    rewardId: 'octav-20',
    email: 'trader@example.com',
    issued,
    signature,
  };
}

test('a valid claim above the threshold is recorded with the server-computed XP', async () => {
  volumeUsd = '51234.75'; // above octav-20's 50k threshold
  const issued = Math.floor(Date.now() / 1000);
  const res = await claim(validBody(issued, await signClaim('octav-20', issued)));

  expect(res.statusCode).toBe(200);
  expect(res.json).toMatchObject({ claimed: true, rewardId: 'octav-20', xp: 51234, alreadyClaimed: false });
  // The email and the FLOORED server-side XP are what get persisted, never a
  // client-supplied balance.
  expect(lastInsert).toContain('trader@example.com');
  expect(lastInsert).toContain(51234);
});

test('a wallet below the XP threshold cannot claim, even with a valid signature', async () => {
  volumeUsd = '49999';
  const issued = Math.floor(Date.now() / 1000);
  const res = await claim(validBody(issued, await signClaim('octav-20', issued)));

  expect(res.statusCode).toBe(403);
  expect(lastInsert).toBeUndefined();
});

test('a signature for a different action does not authorize a claim', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  // Signed for the partner dashboard, replayed at the claim endpoint.
  const signature = await account.signMessage({
    message: `Ophis Partner Dashboard access\nAddress: ${WALLET}\nIssued: ${issued}`,
  });
  const res = await claim(validBody(issued, signature));

  expect(res.statusCode).toBe(401);
  expect(lastInsert).toBeUndefined();
});

test('a claim cannot be filed on behalf of another wallet', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  const victim = '0x000000000000000000000000000000000000dead';
  // Correctly signed for the victim's address, but by the attacker's key, so
  // recovery yields the attacker and the claimed address does not match.
  const res = await claim({
    ...validBody(issued, await signClaim('octav-20', issued, 'trader@example.com', victim)),
    wallet: victim,
  });

  expect(res.statusCode).toBe(401);
  expect(lastInsert).toBeUndefined();
});

test('an expired signature is rejected', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000) - 3600; // outside the 5-minute window
  const res = await claim(validBody(issued, await signClaim('octav-20', issued)));

  expect(res.statusCode).toBe(401);
  expect(res.json.error).toBe('signature expired');
});

test('a malformed email is rejected before any signature work', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  const res = await claim({
    ...validBody(issued, await signClaim('octav-20', issued, 'not-an-email')),
    email: 'not-an-email',
  });

  expect(res.statusCode).toBe(400);
  expect(res.json.error).toBe('invalid email address');
});

test('a self-service reward collects nothing (Keystone ships its code in the app)', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  const res = await claim({
    ...validBody(issued, await signClaim('keystone-5', issued)),
    rewardId: 'keystone-5',
  });

  expect(res.statusCode).toBe(400);
  expect(lastInsert).toBeUndefined();
});

test('an unknown reward id is a 404', async () => {
  const issued = Math.floor(Date.now() / 1000);
  const res = await claim({ ...validBody(issued, await signClaim('made-up', issued)), rewardId: 'made-up' });

  expect(res.statusCode).toBe(404);
});

test('a signature that does not cover an email is rejected outright', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  // The pre-binding message shape: wallet + reward + timestamp, no email. This
  // is the one an attacker most wants, because it authorizes the claim without
  // saying where the code should go. Accepting it would mean the destination is
  // attacker-chosen, so it must not verify at all.
  const unboundSignature = await account.signMessage({
    message: `Ophis claim reward octav-20\nAddress: ${WALLET}\nIssued: ${issued}`,
  });
  const res = await claim(validBody(issued, unboundSignature));

  expect(res.statusCode).toBe(401);
  expect(lastInsert).toBeUndefined();
});

test('a signature bound to one email cannot redirect the code to another', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  // The victim signed for their own address. An attacker who captures that
  // signature inside the replay window swaps in their own email; without the
  // email in the signed message this would succeed and the partner would post
  // the victim's code to the attacker.
  const victimSignature = await signClaim('octav-20', issued, 'victim@example.com');
  const res = await claim({
    ...validBody(issued, victimSignature),
    email: 'attacker@example.com',
  });

  expect(res.statusCode).toBe(401);
  expect(lastInsert).toBeUndefined();
});

test('a claim for the signed email still succeeds (the binding is not over-tight)', async () => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  const res = await claim({
    ...validBody(issued, await signClaim('octav-20', issued, 'victim@example.com')),
    email: 'victim@example.com',
  });

  expect(res.statusCode).toBe(200);
  expect(lastInsert).toContain('victim@example.com');
});

// Regression: the domain class once excluded dots, which rejected not just
// subdomained addresses but the entire .co.uk / .com.au / .co.jp family.
test.each([
  'alice@example.co.uk',
  'alice@mail.example.co.uk',
  'bob@sub.domain.example.org',
  'carol@example.com',
])('accepts the real-world address %s', async (email) => {
  volumeUsd = '100000';
  const issued = Math.floor(Date.now() / 1000);
  const res = await claim({ ...validBody(issued, await signClaim('octav-20', issued, email)), email });

  expect(res.statusCode).toBe(200);
  expect(lastInsert).toContain(email);
});

test.each(['not-an-email', 'a@.com', 'a@example.', 'a b@example.com', ''])(
  'still rejects the unmailable address %s',
  async (email) => {
    volumeUsd = '100000';
    const issued = Math.floor(Date.now() / 1000);
    const res = await claim({ ...validBody(issued, await signClaim('octav-20', issued, email)), email });

    expect(res.statusCode).toBe(400);
    expect(lastInsert).toBeUndefined();
  },
);

test('the claim export refuses to serve the wallet/email join without admin auth', async () => {
  process.env.REBATE_INDEXER_ADMIN_TOKEN = 'secret-token';
  app = await buildApiServer();

  const anon = await app.inject({ method: 'GET', url: '/rewards/claims' });
  expect(anon.statusCode).toBe(401);

  const wrong = await app.inject({
    method: 'GET',
    url: '/rewards/claims',
    headers: { authorization: 'Bearer wrong-token-xx' },
  });
  expect(wrong.statusCode).toBe(401);
});

test('the claim export fails closed when no admin token is configured', async () => {
  app = await buildApiServer();
  const res = await app.inject({
    method: 'GET',
    url: '/rewards/claims',
    headers: { authorization: 'Bearer anything' },
  });
  expect(res.statusCode).toBe(503);
});

test('the CSV export neutralizes spreadsheet formulas in claimer-controlled fields', async () => {
  process.env.REBATE_INDEXER_ADMIN_TOKEN = 'secret-token';
  exportRows = [
    {
      wallet_hex: 'dead'.repeat(10),
      reward_id: 'octav-20',
      // An address that would otherwise execute in the partner's spreadsheet.
      email: '=HYPERLINK("http://evil","click")@example.com',
      xp_at_claim: '50000',
      claimed_at: '2026-08-04 10:00:00+00',
      updated_at: '2026-08-04 10:00:00+00',
    },
  ];
  app = await buildApiServer();

  const res = await app.inject({
    method: 'GET',
    url: '/rewards/claims?reward=octav-20&format=csv',
    headers: { authorization: 'Bearer secret-token' },
  });

  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/csv');
  // Never cached: this response is the PII join.
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.split('\n')[0]).toBe('wallet,reward_id,email,xp_at_claim,claimed_at,updated_at');
  // Leading '=' defanged with a quote prefix, inner quotes doubled.
  expect(res.body).toContain(`"'=HYPERLINK(""http://evil"",""click"")@example.com"`);
});

test('the JSON export returns claims with 0x-prefixed addresses', async () => {
  process.env.REBATE_INDEXER_ADMIN_TOKEN = 'secret-token';
  exportRows = [
    {
      wallet_hex: 'ab'.repeat(20),
      reward_id: 'octav-20',
      email: 'trader@example.com',
      xp_at_claim: '77000',
      claimed_at: '2026-08-04 10:00:00+00',
      updated_at: '2026-08-04 10:00:00+00',
    },
  ];
  app = await buildApiServer();

  const res = await app.inject({
    method: 'GET',
    url: '/rewards/claims',
    headers: { authorization: 'Bearer secret-token' },
  });

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.total).toBe(1);
  expect(body.claims[0]).toMatchObject({
    wallet: `0x${'ab'.repeat(20)}`,
    email: 'trader@example.com',
    xpAtClaim: 77000,
  });
});

test('an invalid since filter is rejected rather than silently ignored', async () => {
  process.env.REBATE_INDEXER_ADMIN_TOKEN = 'secret-token';
  app = await buildApiServer();
  const res = await app.inject({
    method: 'GET',
    url: '/rewards/claims?since=not-a-date',
    headers: { authorization: 'Bearer secret-token' },
  });
  expect(res.statusCode).toBe(400);
});
