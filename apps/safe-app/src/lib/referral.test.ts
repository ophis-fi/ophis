import { afterEach, expect, it, vi } from 'vitest';
import { buildOphisOrderMetadata } from '@ophis/sdk';
import { resolveReferralCode } from './referral';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('skips the configured Arc referral default while preserving other chains', () => {
  vi.stubGlobal('location', { search: '' });
  vi.stubEnv('VITE_OPHIS_REFERRAL_CODE', 'builder-code');
  expect(resolveReferralCode(5042)).toBeUndefined();
  expect(resolveReferralCode(10)).toBe('builder-code');
});

it('preserves an explicit Arc URL code for the SDK to reject truthfully', () => {
  vi.stubGlobal('location', { search: '?ref=caller-code' });
  vi.stubEnv('VITE_OPHIS_REFERRAL_CODE', 'builder-code');
  const referralCode = resolveReferralCode(5042);
  expect(referralCode).toBe('caller-code');
  expect(() => buildOphisOrderMetadata({ chainId: 5042, referralCode })).toThrow(/Arc.*not supported/);
  expect(resolveReferralCode(10)).toBe('caller-code');
});

it('retains an explicitly empty URL code as an opt-out on every chain', () => {
  vi.stubGlobal('location', { search: '?ref=' });
  vi.stubEnv('VITE_OPHIS_REFERRAL_CODE', 'builder-code');
  expect(resolveReferralCode(5042)).toBeUndefined();
  expect(resolveReferralCode(10)).toBeUndefined();
});
