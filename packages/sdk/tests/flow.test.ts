import { describe, expect, it, vi } from 'vitest';
import {
  isOphisFeeChain,
  buildOphisOrderMetadata,
  enrollOphisTrader,
  buildOphisOrderCreation,
  OPHIS_REBATE_INDEXER_URL,
} from '../src/flow.js';
import { OPHIS_PARTNER_FEE_RECIPIENT } from '../src/partner-fee.js';

const OWNER = '0x6D46e28aB34622d9A39d0F306a37a8dC270951aF' as const;
const NON_FEE_CHAIN = 12345; // not in OPHIS_FEE_CHAIN_IDS

describe('isOphisFeeChain', () => {
  it('is true for served chains and false for others', () => {
    expect(isOphisFeeChain(1)).toBe(true); // mainnet
    expect(isOphisFeeChain(10)).toBe(true); // optimism
    expect(isOphisFeeChain(8453)).toBe(true); // base
    expect(isOphisFeeChain(NON_FEE_CHAIN)).toBe(false);
  });
  it('throws on an invalid chainId (forgot the arg)', () => {
    expect(() => isOphisFeeChain(0)).toThrow();
    // @ts-expect-error exercising the runtime guard
    expect(() => isOphisFeeChain(undefined)).toThrow();
  });
});

describe('buildOphisOrderMetadata', () => {
  it('hardcodes appCode to ophis (the silent-failure footgun)', () => {
    const out = buildOphisOrderMetadata({ chainId: 1, referralCode: 'yourcode' });
    expect(out.appCode).toBe('ophis');
  });

  it('builds the partner fee to the Ophis recipient at 10 bps by default', () => {
    const { metadata } = buildOphisOrderMetadata({ chainId: 1, referralCode: 'yourcode' });
    expect(metadata.partnerFee).toEqual({ recipient: OPHIS_PARTNER_FEE_RECIPIENT, volumeBps: 10 });
  });

  it('uses the reduced 1 bp rate for a stable pair', () => {
    const { metadata } = buildOphisOrderMetadata({ chainId: 1, referralCode: 'yourcode', isStablePair: true });
    expect(metadata.partnerFee.volumeBps).toBe(1);
  });

  it('tags the referral code (normalized) so the rebate accrues', () => {
    const { metadata } = buildOphisOrderMetadata({ chainId: 1, referralCode: 'YourCode' });
    expect(metadata.ophisReferrer).toEqual({ code: 'yourcode' });
  });

  it('includes signer only when provided (EIP-1271), and always an empty hooks', () => {
    const withSigner = buildOphisOrderMetadata({ chainId: 1, referralCode: 'yourcode', signer: OWNER });
    expect(withSigner.metadata.signer).toBe(OWNER);
    expect(withSigner.metadata.hooks).toEqual({});
    const withoutSigner = buildOphisOrderMetadata({ chainId: 1, referralCode: 'yourcode' });
    expect('signer' in withoutSigner.metadata).toBe(false);
  });

  it('throws on a chain Ophis does not serve (never route a fee-less order by mistake)', () => {
    expect(() => buildOphisOrderMetadata({ chainId: NON_FEE_CHAIN, referralCode: 'yourcode' })).toThrow(/no live Ophis orderbook/);
  });

  it('throws on a fee chain whose orderbook is paused (in fee set but no live orderbook URL)', () => {
    // 4326 / 999 are in OPHIS_FEE_CHAIN_IDS but absent from OPHIS_ORDERBOOK_URLS.
    expect(() => buildOphisOrderMetadata({ chainId: 4326, referralCode: 'yourcode' })).toThrow(/no live Ophis orderbook/);
    expect(() => buildOphisOrderMetadata({ chainId: 999, referralCode: 'yourcode' })).toThrow(/no live Ophis orderbook/);
  });

  it('throws on an invalid referral code (typo fails at build, not silently)', () => {
    expect(() => buildOphisOrderMetadata({ chainId: 1, referralCode: 'bad code' })).toThrow();
  });
});

describe('enrollOphisTrader', () => {
  // Typed-param impl so mock.calls is inferred as [input, init?] (not an empty tuple).
  const okFetch = (status = 200) =>
    vi.fn((_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(new Response('{}', { status })),
    );

  it('GETs the indexer /tier/:wallet endpoint with the default host', async () => {
    const fetchMock = okFetch();
    await enrollOphisTrader(OWNER, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${OPHIS_REBATE_INDEXER_URL}/tier/${OWNER}`);
    expect(init?.method).toBe('GET');
  });

  it('honours a custom host and strips trailing slashes', async () => {
    const fetchMock = okFetch();
    await enrollOphisTrader(OWNER, { host: 'https://staging.example.com//', fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://staging.example.com/tier/${OWNER}`);
  });

  it('throws on a non-2xx response so the caller can block the first swap', async () => {
    const fetchMock = okFetch(500);
    await expect(enrollOphisTrader(OWNER, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a malformed wallet before making any request', async () => {
    const fetchMock = okFetch();
    await expect(enrollOphisTrader('0xnotanaddress', { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an insecure or credential-embedding host (no regex bypass)', async () => {
    const fetchMock = okFetch();
    // plaintext, non-local
    await expect(enrollOphisTrader(OWNER, { host: 'http://evil.tld', fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow();
    // userinfo bypass attempt: the real host is evil.com, not localhost
    await expect(
      enrollOphisTrader(OWNER, { host: 'http://localhost:80@evil.com', fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows http://localhost for dev', async () => {
    const fetchMock = okFetch();
    await enrollOphisTrader(OWNER, { host: 'http://localhost:8080', fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://localhost:8080/tier/${OWNER}`);
  });
});

describe('buildOphisOrderCreation', () => {
  const HASH = ('0x' + 'a'.repeat(64)) as `0x${string}`;
  const FOREIGN = '0x000000000000000000000000000000000000dEaD' as const;
  const base = {
    owner: OWNER,
    fullAppData: '{"appCode":"ophis"}',
    appDataHash: HASH,
    signature: '0xsig' as `0x${string}`,
    signingScheme: 'eip712' as const,
  };

  it('submits appData as the full JSON STRING plus appDataHash (the wire shape)', () => {
    const body = buildOphisOrderCreation({ ...base, order: { sellToken: '0x1', receiver: OWNER, appData: HASH } });
    expect(body.appData).toBe('{"appCode":"ophis"}'); // full string, NOT the hash
    expect(body.appDataHash).toBe(HASH);
    expect(body.from).toBe(OWNER);
    expect(body.signingScheme).toBe('eip712');
    expect(body.signature).toBe('0xsig');
    expect(body.sellToken).toBe('0x1'); // preserves the rest of the order
  });

  it('rejects a non-bytes32 appDataHash (e.g. the full appData passed by mistake)', () => {
    expect(() =>
      buildOphisOrderCreation({ ...base, appDataHash: '0xabc' as `0x${string}`, order: { receiver: OWNER } }),
    ).toThrow(/bytes32/);
  });

  it('rejects a mismatch between the signed order.appData and appDataHash', () => {
    const otherHash = ('0x' + 'b'.repeat(64)) as `0x${string}`;
    expect(() =>
      buildOphisOrderCreation({ ...base, order: { receiver: OWNER, appData: otherHash } }),
    ).toThrow(/does not match appDataHash/);
  });

  it('pins the receiver to the owner (drain guard) and rejects a foreign receiver', () => {
    expect(() => buildOphisOrderCreation({ ...base, order: { receiver: FOREIGN } })).toThrow(/receiver/);
  });

  it('PRESERVES the signed receiver, never rewriting zero/absent to owner (would break the signature)', () => {
    // absent receiver stays absent (CoW resolves it to the owner at settlement)
    const b1 = buildOphisOrderCreation({ ...base, order: {} });
    expect(b1.receiver).toBeUndefined();
    // zero receiver is preserved exactly as signed
    const zero = '0x0000000000000000000000000000000000000000';
    const b2 = buildOphisOrderCreation({ ...base, order: { receiver: zero } });
    expect(b2.receiver).toBe(zero);
  });

  it('allows a custom receiver only when NAMED via allowReceiver, and that name must match', () => {
    // Matches -> allowed.
    const body = buildOphisOrderCreation({ ...base, order: { receiver: FOREIGN }, allowReceiver: FOREIGN });
    expect(body.receiver).toBe(FOREIGN);
    // A stale/injected order.receiver that does not match the named address still throws.
    const other = '0x000000000000000000000000000000000000bEEf' as const;
    expect(() =>
      buildOphisOrderCreation({ ...base, order: { receiver: other }, allowReceiver: FOREIGN }),
    ).toThrow(/does not match/);
  });

  it('throws on a malformed owner', () => {
    expect(() => buildOphisOrderCreation({ ...base, owner: '0xbad' as `0x${string}`, order: { receiver: OWNER } })).toThrow();
  });
});
