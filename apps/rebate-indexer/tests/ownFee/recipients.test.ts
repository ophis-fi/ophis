import { describe, it, expect } from 'vitest';
import {
  assertOwnFeeRecipientsSane,
  isPayableOwnFeeRecipient,
  SOVEREIGN_OWN_FEE_RECIPIENTS,
  OPHIS_SAFE_LOWER,
  ZERO_ADDRESS_LOWER,
} from '../../src/ownFee/recipients.js';
import { planOwnFeePayout, resolveOwnFeePayoutEnabled } from '../../src/ownFee/payoutPlan.js';
import type { OwnFeeOwed } from '../../src/ownFee/accrual.js';
import { safeTxServiceUrl } from '../../src/safe/addresses.js';

const WEI = 10n ** 18n;
const R = ('0x' + 'a1'.repeat(20)) as `0x${string}`;
const owed = (recipient: string, owedWei: bigint): OwnFeeOwed => ({
  recipient: recipient as `0x${string}`,
  owedUsd: Number(owedWei) / 1e18,
  owedWei,
});

describe('own-fee recipients allowlist (fail-closed)', () => {
  it('the REAL allowlist is empty today and passes the sanity assertion', () => {
    expect(SOVEREIGN_OWN_FEE_RECIPIENTS.size).toBe(0);
    expect(() => assertOwnFeeRecipientsSane(SOVEREIGN_OWN_FEE_RECIPIENTS)).not.toThrow();
  });

  it('the assertion THROWS if the Ophis Safe or zero address is ever added (9e)', () => {
    expect(() => assertOwnFeeRecipientsSane(new Set([OPHIS_SAFE_LOWER]))).toThrow(/Ophis Safe/);
    expect(() => assertOwnFeeRecipientsSane(new Set([ZERO_ADDRESS_LOWER]))).toThrow(/zero/);
    // Also rejects a non-lowercased / non-address entry.
    expect(() => assertOwnFeeRecipientsSane(new Set(['0xNOT_AN_ADDRESS']))).toThrow();
  });

  it('isPayableOwnFeeRecipient never treats the Ophis Safe / zero as payable, even if wrongly listed (9e)', () => {
    const bad = new Set([OPHIS_SAFE_LOWER, ZERO_ADDRESS_LOWER, R]);
    expect(isPayableOwnFeeRecipient(OPHIS_SAFE_LOWER, bad)).toBe(false);
    expect(isPayableOwnFeeRecipient(ZERO_ADDRESS_LOWER, bad)).toBe(false);
    // Case-insensitive membership: an allowlisted recipient is payable regardless of case.
    expect(isPayableOwnFeeRecipient(('0x' + 'A1'.repeat(20)) as `0x${string}`, bad)).toBe(true);
    // A non-listed recipient is never payable.
    expect(isPayableOwnFeeRecipient(('0x' + 'bb'.repeat(20)) as `0x${string}`, bad)).toBe(false);
  });
});

describe('planOwnFeePayout - over-draw guard + transfer plan', () => {
  it('builds transfers when owed fits the Safe balance', () => {
    const plan = planOwnFeePayout([owed(R, 1n * WEI)], 10n * WEI);
    expect(plan.blocked).toBe(false);
    expect(plan.totalOwedWei).toBe(1n * WEI);
    expect(plan.transfers).toEqual([{ to: R, amount: 1n * WEI }]);
  });

  it('BLOCKS (no transfers) when owed would over-draw the Safe (9d, pure)', () => {
    const plan = planOwnFeePayout([owed(R, 6n * WEI)], 5n * WEI);
    expect(plan.blocked).toBe(true);
    expect(plan.transfers).toHaveLength(0);
    expect(plan.reason).toMatch(/exceed/);
  });

  it('allows exactly filling the Safe (owed == balance)', () => {
    const plan = planOwnFeePayout([owed(R, 5n * WEI)], 5n * WEI);
    expect(plan.blocked).toBe(false);
    expect(plan.totalOwedWei).toBe(5n * WEI);
  });

  it('drops zero-amount, zero-address and Ophis-Safe recipients (defense-in-depth)', () => {
    const plan = planOwnFeePayout(
      [owed(R, 0n), owed(ZERO_ADDRESS_LOWER, 1n * WEI), owed(OPHIS_SAFE_LOWER, 1n * WEI), owed(('0x' + 'cc'.repeat(20)), 2n * WEI)],
      100n * WEI,
    );
    expect(plan.transfers).toHaveLength(1);
    expect(plan.transfers[0]!.to).toBe('0x' + 'cc'.repeat(20));
    expect(plan.totalOwedWei).toBe(2n * WEI);
  });
});

describe('resolveOwnFeePayoutEnabled - default OFF, fail-loud', () => {
  it('defaults OFF and is fail-loud on garbage', () => {
    delete process.env.OWN_FEE_PAYOUT_ENABLED;
    expect(resolveOwnFeePayoutEnabled()).toBe(false);
    process.env.OWN_FEE_PAYOUT_ENABLED = 'true';
    expect(resolveOwnFeePayoutEnabled()).toBe(true);
    process.env.OWN_FEE_PAYOUT_ENABLED = '1';
    expect(resolveOwnFeePayoutEnabled()).toBe(true);
    process.env.OWN_FEE_PAYOUT_ENABLED = '0';
    expect(resolveOwnFeePayoutEnabled()).toBe(false);
    process.env.OWN_FEE_PAYOUT_ENABLED = 'garbage';
    expect(() => resolveOwnFeePayoutEnabled()).toThrow();
    delete process.env.OWN_FEE_PAYOUT_ENABLED;
  });
});

describe('safeTxServiceUrl - Unichain override path (9g)', () => {
  it('selects the explicit Unichain (130) Transaction Service URL', () => {
    delete process.env.SAFE_TX_SERVICE_UNICHAIN;
    expect(safeTxServiceUrl(130)).toBe('https://safe-transaction-unichain.safe.global/api');
  });
  it('returns undefined for chains the api-kit already knows (Optimism 10, Gnosis 100)', () => {
    expect(safeTxServiceUrl(10)).toBeUndefined();
    expect(safeTxServiceUrl(100)).toBeUndefined();
  });
  it('is env-overridable for Unichain', () => {
    process.env.SAFE_TX_SERVICE_UNICHAIN = 'https://example.test/api';
    expect(safeTxServiceUrl(130)).toBe('https://example.test/api');
    delete process.env.SAFE_TX_SERVICE_UNICHAIN;
  });
});
