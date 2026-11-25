import { test, expect, afterEach, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { base58 } from '@scure/base';
import { type FastifyInstance } from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSignedActionMessage } from '../../src/affiliate/partnerAuth.js';

// ─── Programmable SQL mock ───────────────────────────────────────────────────
// The /ref/bind and /ref/codes handlers run real SQL against a `postgres`
// tagged-template instance. We mock it: every tagged-template call (and every
// `tx` call inside sql.begin) is routed through `route()`, which inspects the
// joined query text and returns canned rows configured per-test via `state`.
// This keeps the crypto + control-flow path under test without a real Postgres.

type Rows = Record<string, unknown>[];
type State = {
  // Existing ref_code for the bind `code` (referrer_hex + active), or null.
  refCode: { referrer_hex: string; active: boolean } | null;
  // Rows returned for the "already bound?" referrals lookup.
  existingReferral: Rows;
  // Rows returned by the WITH RECURSIVE cycle probe (non-empty => cycle).
  cycle: Rows;
  // Rows returned for the "prior trade history?" net-new check.
  priorTrades: Rows;
  // /ref/codes: existing active regular code lookup (null => none, mint new).
  existingRegularCode: { code: string; payout_hex?: string } | null;
  // /ref/codes: how many of the next INSERT...RETURNING attempts return [] (conflict)
  // before one succeeds. 0 => first insert succeeds.
  insertConflicts: number;
  // Captures every routed query text (joined template strings) for assertions.
  queries: string[];
  values: unknown[][];
};

let state: State;

function freshState(): State {
  return {
    refCode: null,
    existingReferral: [],
    cycle: [],
    priorTrades: [],
    existingRegularCode: null,
    insertConflicts: 0,
    queries: [],
    values: [],
  };
}

// One router shared by the top-level `sql` template and the `tx` template.
function route(strings: readonly string[], _values: unknown[]): Rows {
  const text = strings.join('?');
  state.queries.push(text);
  state.values.push(_values);

  // /ref/bind — code lookup
  if (text.includes('encode(referrer_wallet') && text.includes('FROM ref_codes WHERE code')) {
    return state.refCode ? [state.refCode as unknown as Record<string, unknown>] : [];
  }
  // /ref/bind — recursive cycle probe (checked BEFORE the plain existing-referral
  // branch: the recursive query also contains "FROM referrals WHERE referred_wallet"
  // + "LIMIT 1" in its body, so it must be matched on its distinctive CTE first).
  if (text.includes('WITH RECURSIVE ancestors')) {
    return state.cycle;
  }
  // /ref/bind — already-bound check
  if (text.includes('FROM referrals WHERE referred_wallet') && text.includes('LIMIT 1')) {
    return state.existingReferral;
  }
  // /ref/bind — net-new (prior trades) check
  if (text.includes('FROM trades WHERE wallet') || text.includes('FROM solana_settled_fills WHERE wallet')) {
    return state.priorTrades;
  }
  // /ref/bind — referrals insert + tracked_wallets insert (no return needed)
  if (text.includes('INSERT INTO referrals') || text.includes('INSERT INTO tracked_wallets')) {
    return [];
  }
  // /ref/codes — existing active regular code
  if (text.includes('FROM ref_codes WHERE referrer_wallet') && text.includes("kind = 'regular'")) {
    return state.existingRegularCode ? [state.existingRegularCode] : [];
  }
  // /ref/codes — INSERT ... RETURNING code (random mint with retry)
  if (text.includes('INSERT INTO ref_codes') && text.includes('RETURNING code')) {
    if (state.insertConflicts > 0) {
      state.insertConflicts -= 1;
      return []; // simulate ON CONFLICT DO NOTHING (no row returned)
    }
    // Echo the bound candidate code back as the returned row.
    const candidate = _values[0] as string;
    return [{ code: candidate }];
  }
  return [];
}

const sqlMock = Object.assign(
  async (strings: TemplateStringsArray, ...values: unknown[]) => route(strings, values),
  {
    unsafe: async () => [] as Rows,
    // sql.begin(cb) — invoke cb with a `tx` that routes through the same mock.
    begin: async (cb: (tx: unknown) => unknown) => {
      const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => route(strings, values);
      return cb(tx);
    },
  },
);

vi.mock('../../src/db/index.js', () => ({
  sql: sqlMock,
  db: { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => [] }), where: async () => [] }) }) },
  schema: {},
}));
vi.mock('../../src/tierer.js', () => ({
  getWalletStatus: async () => ({ tier: { name: 'none' }, volume_30d_usd: 0 }),
}));

const { buildApiServer } = await import('../../src/api.js');

// Deterministic well-known TEST keys (anvil accounts) — NOT real secrets.
const PK_REFERRED = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const; // anvil #1
const referredAccount = privateKeyToAccount(PK_REFERRED);
const REFERRED = referredAccount.address.toLowerCase();

const PK_OTHER = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const; // anvil #2
const otherAccount = privateKeyToAccount(PK_OTHER);

// A referrer address (Y) — arbitrary 0x40hex; lowercased, no 0x for the hex form.
const REFERRER_HEX = 'a11ce00000000000000000000000000000000001';

let app: FastifyInstance | undefined;

beforeEach(() => {
  state = freshState();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function signBind(signer: typeof referredAccount, addr: string, code: string, issued: number): Promise<`0x${string}`> {
  return signer.signMessage({ message: buildSignedActionMessage('bind referral code ' + code, addr, issued) });
}

async function signCreate(signer: typeof referredAccount, addr: string, issued: number): Promise<`0x${string}`> {
  return signer.signMessage({ message: buildSignedActionMessage('create referral code', addr, issued) });
}

function post(url: string, body: unknown) {
  return app!.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
}

// ─── /ref/bind ───────────────────────────────────────────────────────────────

test('/ref/bind accepts a valid signature from the referred wallet and binds', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signBind(referredAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued, signature });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ bound: true, alreadyBound: false });
});

test('/ref/bind rejects an UNSIGNED bind with 400 (missing/invalid signature)', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  app = await buildApiServer();
  const issued = nowSec();
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued });
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid signature' });
});

test('/ref/bind rejects a WRONG-SIGNER bind with 401', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  app = await buildApiServer();
  const issued = nowSec();
  // `other` signs a message claiming to be REFERRED -> recovery mismatch -> 401.
  const signature = await signBind(otherAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued, signature });
  expect(res.statusCode).toBe(401);
});

test('/ref/bind rejects a circular bind (A->B then B->A) with 400', async () => {
  // The recursive ancestors probe finds REFERRED (X) upstream of the referrer (Y),
  // i.e. binding X under Y's code would close a loop. Mock returns a non-empty cycle.
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  state.cycle = [{ '?column?': 1 }];
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signBind(referredAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued, signature });
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body)).toMatchObject({ error: 'circular referral not allowed' });
});

test('/ref/bind blocks direct self-referral (referrer == referred) with 400', async () => {
  // Code is owned by REFERRED itself.
  state.refCode = { referrer_hex: REFERRED.slice(2), active: true };
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signBind(referredAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued, signature });
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body)).toMatchObject({ error: 'cannot refer your own wallet' });
});

test('/ref/bind rejects a non-net-new wallet (prior trades) with 409', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  state.priorTrades = [{ '?column?': 1 }];
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signBind(referredAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued, signature });
  expect(res.statusCode).toBe(409);
});

test('/ref/bind lowercases the code so a display-uppercased code still binds (#526 casing)', async () => {
  // Codes are canonical lowercase; the frontend signs the lowercased code but the
  // body may arrive upper-cased (display layer). Sign lowercase, send UPPERCASE:
  // the backend must lowercase both the verify-message code and the PK lookup.
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signBind(referredAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'OPHABC123', issued, signature });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ bound: true, alreadyBound: false });
});

test('/ref/bind returns alreadyBound for an existing referral WITHOUT running the cycle probe', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  state.existingReferral = [{ '?column?': 1 }];
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signBind(referredAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued, signature });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ bound: true, alreadyBound: true });
  expect(state.queries.some((q) => q.includes('WITH RECURSIVE ancestors'))).toBe(false);
});

test('/ref/bind rejects an expired signature (issued beyond the replay window) with 401', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  app = await buildApiServer();
  const issued = nowSec() - 310; // > PARTNER_SIG_MAX_AGE_SEC (300)
  const signature = await signBind(referredAccount, REFERRED, 'ophabc123', issued);
  const res = await post('/ref/bind', { referredWallet: REFERRED, code: 'ophabc123', issued, signature });
  expect(res.statusCode).toBe(401);
});

// ─── /ref/codes ────────────────────────────────────────────────────────────────

test('/ref/codes mints a RANDOM code matching /^oph[0-9a-f]{12}$/', async () => {
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signCreate(referredAccount, REFERRED, issued);
  const res = await post('/ref/codes', { wallet: REFERRED, issued, signature });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.created).toBe(true);
  expect(body.kind).toBe('regular'); // fresh mints carry kind, like the idempotent branch
  expect(body.code).toMatch(/^oph[0-9a-f]{12}$/);
});

test('/ref/codes gives DIFFERENT codes to different wallets', async () => {
  app = await buildApiServer();
  const issued1 = nowSec();
  const sig1 = await signCreate(referredAccount, REFERRED, issued1);
  const res1 = await post('/ref/codes', { wallet: REFERRED, issued: issued1, signature: sig1 });
  expect(res1.statusCode).toBe(200);
  const code1 = JSON.parse(res1.body).code;

  // Second wallet (anvil #2) — fresh state, no existing code.
  state = freshState();
  const other = otherAccount.address.toLowerCase();
  const issued2 = nowSec();
  const sig2 = await signCreate(otherAccount, other, issued2);
  const res2 = await post('/ref/codes', { wallet: other, issued: issued2, signature: sig2 });
  expect(res2.statusCode).toBe(200);
  const code2 = JSON.parse(res2.body).code;

  expect(code1).not.toBe(code2);
  expect(code1).toMatch(/^oph[0-9a-f]{12}$/);
  expect(code2).toMatch(/^oph[0-9a-f]{12}$/);
});

test('/ref/codes is idempotent — same wallet returns its existing active code', async () => {
  state.existingRegularCode = { code: 'ophfeedface0001' };
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signCreate(referredAccount, REFERRED, issued);
  const res = await post('/ref/codes', { wallet: REFERRED, issued, signature });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ code: 'ophfeedface0001', kind: 'regular', created: false });
});

test('/ref/codes retries on a code collision then succeeds', async () => {
  state.insertConflicts = 2; // first two inserts conflict, third wins
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signCreate(referredAccount, REFERRED, issued);
  const res = await post('/ref/codes', { wallet: REFERRED, issued, signature });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).code).toMatch(/^oph[0-9a-f]{12}$/);
});

test('/ref/codes returns 500 when all 5 insert attempts collide', async () => {
  state.insertConflicts = 5;
  app = await buildApiServer();
  const issued = nowSec();
  const signature = await signCreate(referredAccount, REFERRED, issued);
  const res = await post('/ref/codes', { wallet: REFERRED, issued, signature });
  expect(res.statusCode).toBe(500);
  expect(JSON.parse(res.body)).toMatchObject({ error: 'could not allocate a referral code, please retry' });
});


const solanaKey = generateKeyPairSync('ed25519');
const solanaPublicKey = Buffer.from(solanaKey.publicKey.export({ format: 'jwk' }).x!, 'base64url');
const solanaWallet = base58.encode(solanaPublicKey);

function signSolana(action: string, issued: number, namespace = 'solana:mainnet') {
  const text = `Ophis ${action}\nAddress: ${solanaWallet}\nIssued: ${issued}\nChain: ${namespace}`;
  return '0x' + sign(null, Buffer.from(text), solanaKey.privateKey).toString('hex');
}

test('Solana users bind case-sensitive keys, including to an EVM referrer, without enrolling in EVM polling', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  app = await buildApiServer();
  const issued = nowSec();
  const body = { referredWallet: solanaWallet, code: 'OPHCODE', issued, signature: signSolana('bind referral code ophcode', issued) };
  expect((await post('/ref/bind', body)).json()).toMatchObject({ bound: true, alreadyBound: false });
  expect(state.values[state.queries.findIndex(q => q.includes('INSERT INTO referrals'))]?.[0]).toEqual(solanaPublicKey);
  expect(state.queries.some(q => q.includes('FROM solana_settled_fills'))).toBe(true);
  state.existingReferral = [{}];
  expect((await post('/ref/bind', body)).json()).toMatchObject({ bound: true, alreadyBound: true });
  expect(state.queries.some(q => q.includes('tracked_wallets'))).toBe(false);
  state.existingReferral = [];
  state.priorTrades = [{}];
  expect((await post('/ref/bind', body)).statusCode).toBe(409);
  state.refCode.referrer_hex = solanaPublicKey.toString('hex');
  expect((await post('/ref/bind', body)).json().error).toMatch(/own wallet/);
});

test('Solana binds reject other chains, address changes, stale signatures and other signed actions', async () => {
  state.refCode = { referrer_hex: REFERRER_HEX, active: true };
  app = await buildApiServer();
  const issued = nowSec();
  const action = 'bind referral code ophcode';
  const body = { referredWallet: solanaWallet, code: 'ophcode', issued, signature: signSolana(action, issued) };
  for (const overrides of [
    { chainId: 1 }, { signature: signSolana(action, issued, 'solana:devnet') },
    { referredWallet: base58.encode(Buffer.alloc(32, 7)) }, { signature: signSolana('Partner Dashboard access', issued) },
    { issued: issued - 310, signature: signSolana(action, issued - 310) },
  ]) expect((await post('/ref/bind', { ...body, ...overrides })).statusCode).toBe(401);
  expect(state.queries).toEqual([]);
});

test('new Solana codes bind the Gnosis WETH recipient into the signature, and retries preserve it', async () => {
  app = await buildApiServer();
  const issued = nowSec();
  const payoutWallet = REFERRED;
  const body = { wallet: solanaWallet, issued, signature: signSolana('create referral code', issued) };
  expect((await post('/ref/codes', body)).statusCode).toBe(400);
  const signed = { ...body, payoutWallet, signature: signSolana('create referral code\nWETH payout: ' + payoutWallet, issued) };
  expect((await post('/ref/codes', { ...signed, payoutWallet: otherAccount.address })).statusCode).toBe(401);
  expect((await post('/ref/codes', { ...signed, payoutWallet: solanaWallet })).statusCode).toBe(400);
  const result = await post('/ref/codes', signed);
  expect(result.statusCode).toBe(200);
  expect(result.json().created).toBe(true);
  expect(state.values[state.queries.findIndex(q => q.includes('INSERT INTO ref_codes'))]).toEqual([
    result.json().code, solanaPublicKey, Buffer.from(payoutWallet.slice(2), 'hex'),
  ]);
  state.existingRegularCode = { code: result.json().code, payout_hex: payoutWallet.slice(2) };
  expect((await post('/ref/codes', signed)).json().created).toBe(false);
  expect((await post('/ref/codes', body)).json().code).toBe(result.json().code);
  state.existingRegularCode.payout_hex = otherAccount.address.toLowerCase().slice(2);
  expect((await post('/ref/codes', signed)).statusCode).toBe(409);
});

test('Solana wallet lookup preserves the address and signed partner access still requires allowlisting', async () => {
  app = await buildApiServer();
  const stats = await app.inject({ method: 'GET', url: '/affiliate/' + solanaWallet });
  expect(stats.statusCode).toBe(200);
  expect(stats.json().wallet).toBe(solanaWallet);
  const issued = nowSec();
  const authorization = { wallet: solanaWallet, issued, signature: signSolana('Partner Dashboard access', issued) };
  const result = await post('/partner', authorization);
  expect(result.statusCode).toBe(403);
});
