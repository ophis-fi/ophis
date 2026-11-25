import { generateKeyPairSync, sign } from 'node:crypto';
import { base58 } from '@scure/base';
import { expect, test } from 'vitest';
import { startPg, stopPg } from '../fixtures/pgContainer.js';

function wallet() {
  const keys = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const address = base58.encode(bytes);
  function authorize(action: string) {
    const issued = Math.floor(Date.now() / 1000);
    const message = `Ophis ${action}\nAddress: ${address}\nIssued: ${issued}\nChain: solana:mainnet`;
    return { issued, signature: '0x' + sign(null, Buffer.from(message), keys.privateKey).toString('hex') };
  }
  return { address, bytes, authorize };
}

test('Solana referral identities round-trip through Postgres and signed partner reporting', async () => {
  const { container, connectionUri } = await startPg();
  process.env.DATABASE_URL = connectionUri;
  const { sql } = await import('../../src/db/index.js');
  const { runMigrations } = await import('../../src/db/migrate.js');
  const { buildApiServer } = await import('../../src/api.js');
  const app = await buildApiServer();
  try {
    await runMigrations();
    const partner = wallet();
    const trader = wallet();
    const payoutWallet = '0x' + '66'.repeat(20);
    const create = { wallet: partner.address, payoutWallet, ...partner.authorize('create referral code\nWETH payout: ' + payoutWallet) };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
    const [a, b] = await Promise.all([post('/ref/codes', create), post('/ref/codes', create)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().code).toBe(b.json().code);
    expect([a.json().created, b.json().created].sort()).toEqual([false, true]);

    const code = a.json().code as string;
    await sql`UPDATE ref_codes SET kind = 'partner' WHERE code = ${code}`;
    const bind = { referredWallet: trader.address, code, ...trader.authorize('bind referral code ' + code) };
    expect((await post('/ref/bind', bind)).json()).toEqual({ bound: true, alreadyBound: false });
    expect((await post('/ref/bind', bind)).json()).toEqual({ bound: true, alreadyBound: true });
    const dashboard = await post('/partner', { wallet: partner.address, ...partner.authorize('Partner Dashboard access') });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({ wallet: partner.address, referees: [{ wallet: trader.address, attribution: 'link' }] });
    const [identity] = await sql`SELECT referrer_wallet, payout_wallet FROM ref_codes WHERE code = ${code}`;
    expect(identity?.referrer_wallet).toEqual(partner.bytes);
    expect(identity?.payout_wallet).toEqual(Buffer.from(payoutWallet.slice(2), 'hex'));
    expect(await sql`SELECT 1 FROM tracked_wallets WHERE wallet = ${trader.bytes}`).toHaveLength(0);
  } finally {
    await app.close();
    await sql.end();
    await stopPg(container);
  }
}, 180_000);
