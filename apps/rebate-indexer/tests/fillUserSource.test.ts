import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({ sql: vi.fn(), db: {}, schema: {} }));

const { pickFillUser } = await import('../src/repair/defillamaSettlement.js');
const FLOW = '0xba3cb449bd2b4adddbc894d8697f5170800eadec'; // an eth-flow contract: never a usable wallet
const PAYER = `0x${'a1'.repeat(20)}`, STORED = `0x${'b1'.repeat(20)}`, TRADES = `0x${'c1'.repeat(20)}`, OWNER = `0x${'d1'.repeat(20)}`;

describe('pickFillUser: the settlement repair keeps each wallet with its own source', () => {
  it('takes the first usable candidate and its source, skipping an eth-flow contract', () => {
    expect(pickFillUser([[PAYER.toUpperCase().replace('0X', '0x'), 'onchain_user'], [STORED, 'receiver'], [TRADES, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: PAYER, userSource: 'onchain_user' });
    expect(pickFillUser([[null, null], [STORED, 'receiver'], [TRADES, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: STORED, userSource: 'receiver' });
    expect(pickFillUser([[undefined, null], [FLOW, null], [TRADES, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: TRADES, userSource: null });
    expect(pickFillUser([[undefined, null], [null, null], [FLOW, null], [OWNER, 'owner']]))
      .toEqual({ userAddress: OWNER, userSource: 'owner' });
    expect(pickFillUser([[undefined, null], [null, null], [null, null], [FLOW, 'owner']]))
      .toEqual({ userAddress: null, userSource: null });
  });
});
