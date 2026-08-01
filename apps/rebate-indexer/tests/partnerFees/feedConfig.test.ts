import { describe, it, expect } from 'vitest';
import { resolvePartnerFeeFeeds, assertFeedsConfigFeeFree } from '../../src/partnerFees/fetch.js';

// Fail-closed chain-config guard: the positional fee->partner attribution is money-safe ONLY on
// chains whose autopilot [fee-policies] is empty. The poller REFUSES to poll any other chain, so
// a config protocol fee can never silently shift partner slots and mis-attribute.

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

  it('REFUSES a chain that is not asserted config-fee-free (fail loud)', () => {
    // 999 has no verified-empty [fee-policies] -> the positional attribution could mis-map.
    expect(() => resolvePartnerFeeFeeds('999=https://x.test/feed')).toThrow(/config-fee-free/i);
  });

  it('rejects a malformed url / duplicate chain', () => {
    expect(() => resolvePartnerFeeFeeds('10=not-a-url')).toThrow(/invalid url/i);
    expect(() => resolvePartnerFeeFeeds('10=https://a.test,10=https://b.test')).toThrow(/duplicate/i);
  });
});

describe('assertFeedsConfigFeeFree', () => {
  it('passes the asserted chains (10, 130)', () => {
    expect(() => assertFeedsConfigFeeFree([{ chainId: 10, url: 'u' }, { chainId: 130, url: 'u' }])).not.toThrow();
  });

  it('throws for any non-asserted chain', () => {
    expect(() => assertFeedsConfigFeeFree([{ chainId: 8453, url: 'u' }])).toThrow(/chain 8453 is NOT asserted config-fee-free/i);
  });
});
