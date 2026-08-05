import { describe, it, expect } from 'vitest';
import { resolvePartnerFeeFeeds, assertFeedsConfigFeeFree } from '../../src/partnerFees/fetch.js';

// Fee policy kinds travel alongside fee amounts, so configured protocol-fee slots can be
// distinguished from partner volume-fee slots on every supported chain.

describe('resolvePartnerFeeFeeds', () => {
  it('parses <chainId>=<url> entries', () => {
    expect(resolvePartnerFeeFeeds('10=https://a.test/feed,130=https://b.test/feed')).toEqual([
      { chainId: 10, url: 'https://a.test/feed' },
      { chainId: 130, url: 'https://b.test/feed' },
    ]);
  });

  it('a bare url defaults to Optimism (10)', () => {
    expect(resolvePartnerFeeFeeds('https://a.test/feed')).toEqual([{ chainId: 10, url: 'https://a.test/feed' }]);
  });

  it('returns [] when unset/empty (feature inert)', () => {
    expect(resolvePartnerFeeFeeds('')).toEqual([]);
    expect(resolvePartnerFeeFeeds(undefined)).toEqual([]);
  });

  it('accepts config-fee chains because attribution uses aligned policy kinds', () => {
    expect(resolvePartnerFeeFeeds('8453=https://x.test/feed')).toEqual([
      { chainId: 8453, url: 'https://x.test/feed' },
    ]);
  });

  it('rejects a malformed url / duplicate chain', () => {
    expect(() => resolvePartnerFeeFeeds('10=not-a-url')).toThrow(/invalid url/i);
    expect(() => resolvePartnerFeeFeeds('10=https://a.test,10=https://b.test')).toThrow(/duplicate/i);
  });
});

describe('assertFeedsConfigFeeFree', () => {
  it('is a compatibility no-op now that policy kinds disambiguate fee slots', () => {
    expect(() =>
      assertFeedsConfigFeeFree([
        { chainId: 10, url: 'u' },
        { chainId: 8453, url: 'u' },
      ]),
    ).not.toThrow();
  });
});
