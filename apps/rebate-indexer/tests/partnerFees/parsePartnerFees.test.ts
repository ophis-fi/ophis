import { describe, it, expect } from 'vitest';
import { attributePartnerFees, parsePartnerFeeCandidates } from '../../src/partnerFees/parsePartnerFees.js';

// Money-critical attribution: map the feed's collected protocolFeeAmounts back to each
// NON-Ophis partner recipient by positional zip, gated by an EXACT slot-count match.

const OPHIS = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
const PARTNER_A = '0x1111111111111111111111111111111111111111';
const PARTNER_B = '0x2222222222222222222222222222222222222222';
const BUY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // the surplus (fee) token for a sell

const appData = (partnerFee: unknown) => JSON.stringify({ metadata: { partnerFee } });

describe('parsePartnerFeeCandidates', () => {
  it('parses a single object as a one-element array, lowercasing the recipient', () => {
    const c = parsePartnerFeeCandidates(appData({ volumeBps: 30, recipient: PARTNER_A }));
    expect(c).toEqual([{ recipient: PARTNER_A.toLowerCase(), volumeBps: 30 }]);
  });

  it('preserves array order and drops entries without a valid recipient', () => {
    const c = parsePartnerFeeCandidates(
      appData([
        { volumeBps: 10, recipient: OPHIS },
        { volumeBps: 30, recipient: PARTNER_A },
        { volumeBps: 5, recipient: 'not-an-address' },
      ]),
    );
    expect(c).toEqual([
      { recipient: OPHIS.toLowerCase(), volumeBps: 10 },
      { recipient: PARTNER_A.toLowerCase(), volumeBps: 30 },
    ]);
  });

  it('returns [] for absent / malformed appData', () => {
    expect(parsePartnerFeeCandidates(null)).toEqual([]);
    expect(parsePartnerFeeCandidates('not json')).toEqual([]);
    expect(parsePartnerFeeCandidates(JSON.stringify({ metadata: {} }))).toEqual([]);
  });
});

describe('attributePartnerFees', () => {
  it('an Ophis-only fee yields no attribution (not an error)', () => {
    const r = attributePartnerFees({
      protocolFeeAmounts: ['1000'],
      protocolFeeTokens: [BUY],
      protocolFeeKinds: ['volume'],
      fullAppData: appData([{ volumeBps: 10, recipient: OPHIS }]),
    });
    expect(r.skipped).toBe(false);
    expect(r.attributions).toEqual([]);
  });

  it('[Ophis, partner] with 2 slots attributes the partner to slot[1]', () => {
    const r = attributePartnerFees({
      protocolFeeAmounts: ['1000', '3000'], // ophis 1000, partner 3000
      protocolFeeTokens: [BUY, BUY],
      protocolFeeKinds: ['volume', 'volume'],
      fullAppData: appData([
        { volumeBps: 10, recipient: OPHIS },
        { volumeBps: 30, recipient: PARTNER_A },
      ]),
    });
    expect(r.skipped).toBe(false);
    expect(r.attributions).toEqual([
      { recipient: PARTNER_A.toLowerCase(), volumeBps: 30, feeToken: BUY, feeAmount: 3000n },
    ]);
  });

  it('a partner-only order attributes slot[0]', () => {
    const r = attributePartnerFees({
      protocolFeeAmounts: ['4200'],
      protocolFeeTokens: [BUY],
      protocolFeeKinds: ['volume'],
      fullAppData: appData({ volumeBps: 30, recipient: PARTNER_A }),
    });
    expect(r.attributions).toEqual([{ recipient: PARTNER_A.toLowerCase(), volumeBps: 30, feeToken: BUY, feeAmount: 4200n }]);
  });

  it('SKIPS (money-safe) when a candidate was dropped -> slot count mismatch', () => {
    // appData still lists a suspended partner, but only the Ophis fee settled (1 slot).
    const r = attributePartnerFees({
      protocolFeeAmounts: ['1000'],
      protocolFeeTokens: [BUY],
      protocolFeeKinds: ['volume'],
      fullAppData: appData([
        { volumeBps: 10, recipient: OPHIS },
        { volumeBps: 30, recipient: PARTNER_A },
      ]),
    });
    expect(r.skipped).toBe(true);
    expect(r.attributions).toEqual([]);
    expect(r.reason).toMatch(/count/i);
  });

  it('sums multiple slots for the SAME recipient (satisfies the trade_uid+recipient PK)', () => {
    const r = attributePartnerFees({
      protocolFeeAmounts: ['1000', '2000', '500'],
      protocolFeeTokens: [BUY, BUY, BUY],
      protocolFeeKinds: ['volume', 'volume', 'volume'],
      fullAppData: appData([
        { volumeBps: 10, recipient: OPHIS },
        { volumeBps: 20, recipient: PARTNER_A },
        { volumeBps: 5, recipient: PARTNER_A },
      ]),
    });
    expect(r.skipped).toBe(false);
    expect(r.attributions).toEqual([
      { recipient: PARTNER_A.toLowerCase(), volumeBps: 25, feeToken: BUY, feeAmount: 2500n },
    ]);
  });

  it('drops a zero-amount partner slot (nothing collected)', () => {
    const r = attributePartnerFees({
      protocolFeeAmounts: ['1000', '0'],
      protocolFeeTokens: [BUY, BUY],
      protocolFeeKinds: ['volume', 'volume'],
      fullAppData: appData([
        { volumeBps: 10, recipient: OPHIS },
        { volumeBps: 30, recipient: PARTNER_A },
      ]),
    });
    expect(r.skipped).toBe(false);
    expect(r.attributions).toEqual([]); // partner slot collected 0
  });

  it('attributes two distinct partners across a 3-slot order', () => {
    const r = attributePartnerFees({
      protocolFeeAmounts: ['1000', '3000', '2000'],
      protocolFeeTokens: [BUY, BUY, BUY],
      protocolFeeKinds: ['volume', 'volume', 'volume'],
      fullAppData: appData([
        { volumeBps: 10, recipient: OPHIS },
        { volumeBps: 30, recipient: PARTNER_A },
        { volumeBps: 20, recipient: PARTNER_B },
      ]),
    });
    expect(r.skipped).toBe(false);
    expect(new Set(r.attributions)).toEqual(
      new Set([
        { recipient: PARTNER_A.toLowerCase(), volumeBps: 30, feeToken: BUY, feeAmount: 3000n },
        { recipient: PARTNER_B.toLowerCase(), volumeBps: 20, feeToken: BUY, feeAmount: 2000n },
      ]),
    );
  });

  it('ignores a prepended config price-improvement slot before partner attribution', () => {
    const r = attributePartnerFees({
      protocolFeeAmounts: ['8000', '1000', '3000'],
      protocolFeeTokens: [BUY, BUY, BUY],
      protocolFeeKinds: ['priceImprovement', 'volume', 'volume'],
      fullAppData: appData([
        { volumeBps: 1, recipient: OPHIS },
        { volumeBps: 30, recipient: PARTNER_A },
      ]),
    });
    expect(r.skipped).toBe(false);
    expect(r.attributions).toEqual([
      { recipient: PARTNER_A.toLowerCase(), volumeBps: 30, feeToken: BUY, feeAmount: 3000n },
    ]);
  });
});
