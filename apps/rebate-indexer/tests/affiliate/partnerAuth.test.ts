import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { buildPartnerAuthMessage, verifyPartnerAuth, PARTNER_SIG_MAX_AGE_SEC } from '../../src/affiliate/partnerAuth.js';

// Deterministic well-known TEST key (anvil account #0) — NOT a real secret.
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const account = privateKeyToAccount(PK);
const ADDR = account.address.toLowerCase();
const NOW = 1_780_000_000;

async function sign(addr: string, issued: number): Promise<`0x${string}`> {
  return account.signMessage({ message: buildPartnerAuthMessage(addr, issued) });
}

describe('verifyPartnerAuth — signature gate for the Partner dashboard', () => {
  it('accepts a fresh signature from the claimed address', async () => {
    const sig = await sign(ADDR, NOW);
    const res = await verifyPartnerAuth({ address: ADDR, issued: NOW, signature: sig, nowSec: NOW });
    expect(res).toEqual({ ok: true, address: ADDR });
  });

  it('rejects an expired signature (older than the window)', async () => {
    const issued = NOW - PARTNER_SIG_MAX_AGE_SEC - 1;
    const sig = await sign(ADDR, issued);
    const res = await verifyPartnerAuth({ address: ADDR, issued, signature: sig, nowSec: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/expired/);
  });

  it('rejects a future-dated signature', async () => {
    const issued = NOW + 10_000;
    const sig = await sign(ADDR, issued);
    const res = await verifyPartnerAuth({ address: ADDR, issued, signature: sig, nowSec: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/future/);
  });

  it('rejects when the signer does not match the claimed address (impersonation)', async () => {
    // Sign with account #0 but claim to be a different address.
    const other = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'; // anvil #1
    const sig = await sign(other, NOW); // account#0 signs a message claiming `other`
    const res = await verifyPartnerAuth({ address: other, issued: NOW, signature: sig, nowSec: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/does not match/);
  });

  it('rejects a tampered/garbage signature', async () => {
    const res = await verifyPartnerAuth({
      address: ADDR,
      issued: NOW,
      signature: '0xdeadbeef' as `0x${string}`,
      nowSec: NOW,
    });
    expect(res.ok).toBe(false);
  });

  it('rejects a malformed address and a non-integer timestamp', async () => {
    const sig = await sign(ADDR, NOW);
    expect((await verifyPartnerAuth({ address: 'nope', issued: NOW, signature: sig, nowSec: NOW })).ok).toBe(false);
    expect((await verifyPartnerAuth({ address: ADDR, issued: 1.5, signature: sig, nowSec: NOW })).ok).toBe(false);
  });

  it('a signature for one issued-time cannot be replayed at a different claimed time', async () => {
    // Signed at NOW, but caller presents a different `issued` -> message differs -> recovery mismatch.
    const sig = await sign(ADDR, NOW);
    const res = await verifyPartnerAuth({ address: ADDR, issued: NOW - 100, signature: sig, nowSec: NOW });
    expect(res.ok).toBe(false);
  });
});
