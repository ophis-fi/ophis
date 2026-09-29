import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashMessage, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildPartnerAuthMessage, buildSignedActionMessage, verifyPartnerAuth, PARTNER_SIG_MAX_AGE_SEC } from '../../src/affiliate/partnerAuth.js';

// Deterministic well-known TEST key (anvil account #0) — NOT a real secret.
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const account = privateKeyToAccount(PK);
const ADDR = account.address.toLowerCase();
const NOW = 1_780_000_000;

async function sign(addr: string, issued: number): Promise<`0x${string}`> {
  return account.signMessage({ message: buildPartnerAuthMessage(addr, issued) });
}

describe('verifyPartnerAuth — signature gate for the Partner dashboard', () => {
  const safe = `0x${'12'.repeat(20)}` as const;
  const safeInput = { address: safe, chainId: 1, issued: NOW, nowSec: NOW, signature: '0xdeadbeef' as const };
  const client = (magic: string, chainId = 1) => ({ getChainId: vi.fn().mockResolvedValue(chainId), readContract: vi.fn().mockResolvedValue(magic) });

  beforeEach(() => vi.stubEnv('CONTRACT_WALLET_AUTH_CHAINS', JSON.stringify({ [safe]: 1 })));
  afterEach(() => vi.unstubAllEnvs());

  it('rejects an otherwise valid same-address Safe on a non-authoritative chain before RPC', async () => {
    const factory = vi.fn(() => client('0x1626ba7e', 100) as unknown as PublicClient);
    const result = await verifyPartnerAuth({ ...safeInput, chainId: 100 }, factory);
    expect(result.ok).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['{}', 'null', '[]', 'invalid JSON', JSON.stringify({ [safe]: '1' })])(
    'fails closed for missing or invalid authority configuration: %s', async (config) => {
      vi.stubEnv('CONTRACT_WALLET_AUTH_CHAINS', config);
      const factory = vi.fn(() => client('0x1626ba7e') as unknown as PublicClient);
      expect((await verifyPartnerAuth(safeInput, factory)).ok).toBe(false);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it('verifies the exact chain-bound message on the claimed contract wallet', async () => {
    const rpc = client('0x1626ba7e');
    expect(await verifyPartnerAuth(safeInput, () => rpc as unknown as PublicClient)).toEqual({ ok: true, address: safe });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: safe, functionName: 'isValidSignature',
      args: [hashMessage(buildSignedActionMessage('Partner Dashboard access', safe, NOW, 1)), safeInput.signature],
    }));
  });

  it('rejects wrong contract magic, wrong RPC chain, missing chain, unsupported chain and RPC failure', async () => {
    for (const rpc of [client('0xffffffff'), client('0x1626ba7e', 10)]) {
      expect((await verifyPartnerAuth(safeInput, () => rpc as unknown as PublicClient)).ok).toBe(false);
    }
    const rpc = client('0x1626ba7e');
    const factory = vi.fn(() => rpc as unknown as PublicClient);
    expect((await verifyPartnerAuth({ ...safeInput, chainId: undefined }, factory)).ok).toBe(false);
    expect((await verifyPartnerAuth({ ...safeInput, chainId: 999999 }, factory)).ok).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    rpc.readContract.mockRejectedValue(new Error('RPC unavailable'));
    expect((await verifyPartnerAuth(safeInput, factory)).ok).toBe(false);
  });

  it('requires a chain-bound EOA signature when chainId is supplied', async () => {
    const legacy = await sign(ADDR, NOW);
    const bound = await account.signMessage({ message: buildSignedActionMessage('Partner Dashboard access', ADDR, NOW, 1) });
    const rpc = client('0xffffffff');
    expect((await verifyPartnerAuth({ ...safeInput, address: ADDR, signature: bound })).ok).toBe(true);
    expect((await verifyPartnerAuth({ ...safeInput, address: ADDR, signature: legacy }, () => rpc as unknown as PublicClient)).ok).toBe(false);
  });

  it('does not accept a Safe owner signature merely because it recovers to an EOA', async () => {
    const signature = await account.signMessage({ message: buildSignedActionMessage('Partner Dashboard access', safe, NOW, 1) });
    const rpc = client('0xffffffff');
    expect((await verifyPartnerAuth({ ...safeInput, signature }, () => rpc as unknown as PublicClient)).ok).toBe(false);
  });

  it('accepts an empty Safe signature only when the contract approves the exact message', async () => {
    const rpc = client('0x1626ba7e');
    expect((await verifyPartnerAuth({ ...safeInput, signature: '0x' }, () => rpc as unknown as PublicClient)).ok).toBe(true);
    rpc.readContract.mockResolvedValue('0xffffffff');
    expect((await verifyPartnerAuth({ ...safeInput, signature: '0x' }, () => rpc as unknown as PublicClient)).ok).toBe(false);
    expect((await verifyPartnerAuth({ ...safeInput, signature: '0x', chainId: undefined })).ok).toBe(false);
  });
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
