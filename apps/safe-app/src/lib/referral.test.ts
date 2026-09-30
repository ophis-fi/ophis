import { afterEach, expect, it, vi } from 'vitest';
import { buildOphisOrderMetadata } from '@ophis/sdk';
import { resolveReferralCode } from './referral';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('uses the configured referral default on Arc and other chains', () => {
  vi.stubGlobal('location', { search: '' });
  vi.stubEnv('VITE_OPHIS_REFERRAL_CODE', 'builder-code');
  expect(resolveReferralCode(5042)).toBe('builder-code');
  expect(resolveReferralCode(10)).toBe('builder-code');
});

it('lets an explicit Arc URL code override the app default', () => {
  vi.stubGlobal('location', { search: '?ref=caller-code' });
  vi.stubEnv('VITE_OPHIS_REFERRAL_CODE', 'builder-code');
  const referralCode = resolveReferralCode(5042);
  expect(referralCode).toBe('caller-code');
  expect(buildOphisOrderMetadata({ chainId: 5042, referralCode }).metadata.ophisReferrer).toEqual({ code: 'caller-code' });
  expect(resolveReferralCode(10)).toBe('caller-code');
});

it('retains an explicitly empty URL code as an opt-out on every chain', () => {
  vi.stubGlobal('location', { search: '?ref=' });
  vi.stubEnv('VITE_OPHIS_REFERRAL_CODE', 'builder-code');
  expect(resolveReferralCode(5042)).toBeUndefined();
  expect(resolveReferralCode(10)).toBeUndefined();
});
