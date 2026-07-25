import { describe, expect, it } from 'vitest';

import { parseAssembleRequest, parseQuoteRequest, parseSubmitRequest } from '../src/mapping.js';
import { CompatError } from '../src/types.js';

const USER = '0x931e9f531cdd4835Def0dEDE1452BA8aFbe5ff9b';
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const WETH_OP = '0x4200000000000000000000000000000000000006';
const OTHER = '0x000000000000000000000000000000000000dEaD';

// Golden request hand-authored to the archived v3 shape (interface reference
// only; nothing vendored). Every field name matches PathRequestV3.
const golden = () => ({
  chainId: 10,
  inputTokens: [{ tokenAddress: USDC_OP, amount: '1000000000' }],
  outputTokens: [{ tokenAddress: WETH_OP, proportion: 1 }],
  userAddr: USER,
  slippageLimitPercent: 0.3,
  referralCode: 0,
  disableRFQs: true,
  compact: true,
});

const errCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof CompatError) return err.code;
    throw err;
  }
  throw new Error('expected a CompatError');
};

describe('parseQuoteRequest', () => {
  it('maps the golden v3 request', () => {
    const req = parseQuoteRequest(golden());
    expect(req.chainId).toBe(10);
    expect(req.sellToken).toBe(USDC_OP);
    expect(req.buyToken).toBe(WETH_OP);
    expect(req.sellAmount).toBe('1000000000');
    expect(req.userAddr).toBe(USER);
    expect(req.slippageBips).toBe(30);
    expect(req.referrerCode).toBeNull();
    expect(req.priceQuality).toBe('optimal');
    // disableRFQs/compact are silent no-ops: no warnings for them.
    expect(req.warnings).toEqual([]);
  });

  it('rejects multi-token inputs naming the basket roadmap', () => {
    const body = golden();
    body.inputTokens.push({ tokenAddress: WETH_OP, amount: '1' });
    expect(errCode(() => parseQuoteRequest(body))).toBe('MULTI_TOKEN_UNSUPPORTED');
    try {
      parseQuoteRequest(body);
    } catch (err) {
      expect((err as CompatError).message).toMatch(/basket/i);
    }
  });

  it('rejects multi-token outputs and partial proportions', () => {
    const multiOut = golden();
    multiOut.outputTokens.push({ tokenAddress: OTHER, proportion: 1 });
    expect(errCode(() => parseQuoteRequest(multiOut))).toBe('MULTI_TOKEN_UNSUPPORTED');

    const partial = golden();
    partial.outputTokens = [{ tokenAddress: WETH_OP, proportion: 0.5 }];
    expect(errCode(() => parseQuoteRequest(partial))).toBe('MULTI_TOKEN_UNSUPPORTED');
  });

  it('rejects a non-zero referralFee with PARTNER_FEE_UNAVAILABLE while the program is off', () => {
    const body = { ...golden(), referralFee: 0.1, referralFeeRecipient: OTHER };
    // Default (no opts) = program disabled: a loud reject, not a silent drop.
    expect(errCode(() => parseQuoteRequest(body))).toBe('PARTNER_FEE_UNAVAILABLE');
  });

  it('maps a non-zero referralFee to a Volume partnerFee entry when enabled', () => {
    const req = parseQuoteRequest(
      { ...golden(), referralFee: 0.001, referralFeeRecipient: OTHER },
      { partnerFeeEnabled: true },
    );
    expect(req.partnerFee).toEqual({ volumeBps: 10, recipient: OTHER });
    expect(req.warnings.some((w) => w.code === 'PARTNER_FEE_MAPPED')).toBe(true);
  });

  it('rounds referralFee to the nearest bps', () => {
    const req = parseQuoteRequest(
      { ...golden(), referralFee: 0.00259, referralFeeRecipient: OTHER },
      { partnerFeeEnabled: true },
    );
    expect(req.partnerFee?.volumeBps).toBe(26);
  });

  it('rejects a mapped fee above the 90 bps program cap (never a silent clamp)', () => {
    expect(
      errCode(() =>
        parseQuoteRequest(
          { ...golden(), referralFee: 0.0091, referralFeeRecipient: OTHER },
          { partnerFeeEnabled: true },
        ),
      ),
    ).toBe('PARTNER_FEE_CAP_EXCEEDED');
  });

  it('rejects a sub-1-bps fee, a missing recipient, and a zero recipient', () => {
    expect(
      errCode(() =>
        parseQuoteRequest(
          { ...golden(), referralFee: 0.00004, referralFeeRecipient: OTHER },
          { partnerFeeEnabled: true },
        ),
      ),
    ).toBe('INVALID_REQUEST');
    expect(
      errCode(() =>
        parseQuoteRequest({ ...golden(), referralFee: 0.001 }, { partnerFeeEnabled: true }),
      ),
    ).toBe('INVALID_ADDRESS');
    expect(
      errCode(() =>
        parseQuoteRequest(
          { ...golden(), referralFee: 0.001, referralFeeRecipient: `0x${'0'.repeat(40)}` },
          { partnerFeeEnabled: true },
        ),
      ),
    ).toBe('INVALID_REQUEST');
  });

  it('accepts referralFee 0 and warns on a dangling recipient', () => {
    const req = parseQuoteRequest({ ...golden(), referralFee: 0, referralFeeRecipient: OTHER });
    expect(req.warnings.some((w) => w.code === 'REFERRAL_FEE_RECIPIENT_IGNORED')).toBe(true);
    expect(req.partnerFee).toBeNull();
  });

  it('maps referralCode integers to odos<code>', () => {
    expect(parseQuoteRequest({ ...golden(), referralCode: 12345 }).referrerCode).toBe('odos12345');
    expect(parseQuoteRequest({ ...golden(), referralCode: 0 }).referrerCode).toBeNull();
    expect(errCode(() => parseQuoteRequest({ ...golden(), referralCode: 1.5 }))).toBe(
      'INVALID_REQUEST',
    );
    expect(errCode(() => parseQuoteRequest({ ...golden(), referralCode: -1 }))).toBe(
      'INVALID_REQUEST',
    );
  });

  it('converts slippageLimitPercent to bips and hard-rejects above the 50% cap', () => {
    expect(parseQuoteRequest({ ...golden(), slippageLimitPercent: 1 }).slippageBips).toBe(100);
    expect(parseQuoteRequest({ ...golden(), slippageLimitPercent: 0.05 }).slippageBips).toBe(5);
    expect(errCode(() => parseQuoteRequest({ ...golden(), slippageLimitPercent: 50.01 }))).toBe(
      'INVALID_SLIPPAGE',
    );
    expect(errCode(() => parseQuoteRequest({ ...golden(), slippageLimitPercent: 0 }))).toBe(
      'INVALID_SLIPPAGE',
    );
    // default when omitted: the v3 default 0.3% = 30 bips
    const body = golden();
    delete (body as Record<string, unknown>).slippageLimitPercent;
    expect(parseQuoteRequest(body).slippageBips).toBe(30);
  });

  it('maps simple to priceQuality fast', () => {
    expect(parseQuoteRequest({ ...golden(), simple: true }).priceQuality).toBe('fast');
    expect(parseQuoteRequest({ ...golden(), simple: false }).priceQuality).toBe('optimal');
  });

  it('marks quote-only requests (no userAddr) with a warning', () => {
    const body = golden();
    delete (body as Record<string, unknown>).userAddr;
    const req = parseQuoteRequest(body);
    expect(req.userAddr).toBeNull();
    expect(req.warnings.some((w) => w.code === 'NOT_ASSEMBLABLE_NO_USER')).toBe(true);
  });

  it('warns on ignored routing knobs and reserved features, and captures the pathViz flags', () => {
    const req = parseQuoteRequest({
      ...golden(),
      gasPrice: 20,
      sourceWhitelist: ['Uniswap V3'],
      likeAsset: true,
      pathViz: true,
      pathVizImage: true,
      permit2: true,
    });
    const codes = req.warnings.map((w) => w.code);
    expect(codes).toContain('GAS_PRICE_IGNORED');
    expect(codes).toContain('SOURCE_FILTERS_IGNORED');
    expect(codes).toContain('LIKE_ASSET_IGNORED');
    expect(codes).toContain('PERMIT2_UNAVAILABLE');
    // pathViz is no longer a parse-time "unavailable" warning: the flags are
    // captured and the quote path decides based on the live feature state.
    expect(codes).not.toContain('PATH_VIZ_UNAVAILABLE');
    expect(req.pathViz).toBe(true);
    expect(req.pathVizImage).toBe(true);
  });

  it('rejects malformed addresses, amounts, and same-token pairs', () => {
    expect(
      errCode(() =>
        parseQuoteRequest({ ...golden(), inputTokens: [{ tokenAddress: 'nope', amount: '1' }] }),
      ),
    ).toBe('INVALID_ADDRESS');
    expect(
      errCode(() =>
        parseQuoteRequest({ ...golden(), inputTokens: [{ tokenAddress: USDC_OP, amount: '0' }] }),
      ),
    ).toBe('INVALID_AMOUNT');
    expect(
      errCode(() =>
        parseQuoteRequest({
          ...golden(),
          outputTokens: [{ tokenAddress: USDC_OP, proportion: 1 }],
        }),
      ),
    ).toBe('INVALID_REQUEST');
    expect(errCode(() => parseQuoteRequest({ ...golden(), userAddr: '0x123' }))).toBe(
      'INVALID_ADDRESS',
    );
    expect(errCode(() => parseQuoteRequest(null))).toBe('INVALID_REQUEST');
    expect(errCode(() => parseQuoteRequest({ ...golden(), chainId: 'ten' }))).toBe(
      'INVALID_REQUEST',
    );
  });
});

describe('parseAssembleRequest', () => {
  it('parses the assemble shape and checksums the receiver', () => {
    const req = parseAssembleRequest({ userAddr: USER, pathId: 'abc.def', receiver: OTHER });
    expect(req.userAddr).toBe(USER);
    expect(req.pathId).toBe('abc.def');
    expect(req.receiver).toBe('0x000000000000000000000000000000000000dEaD');
    expect(req.simulate).toBe(false);
  });

  it('requires userAddr and pathId', () => {
    expect(errCode(() => parseAssembleRequest({ pathId: 'x' }))).toBe('INVALID_ADDRESS');
    expect(errCode(() => parseAssembleRequest({ userAddr: USER }))).toBe('INVALID_REQUEST');
  });
});

describe('parseSubmitRequest', () => {
  const order = {
    sellToken: USDC_OP,
    buyToken: WETH_OP,
    receiver: USER,
    sellAmount: '1000000000',
    buyAmount: '1',
    validTo: 2000000000,
    appData: `0x${'ab'.repeat(32)}`,
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  };
  const base = () => ({
    chainId: 10,
    order: { ...order },
    signature: '0x1234',
    from: USER,
    fullAppData: '{}',
    quoteId: 7,
  });

  it('parses a full submit body', () => {
    const req = parseSubmitRequest(base());
    expect(req.chainId).toBe(10);
    expect(req.signingScheme).toBe('eip712');
    expect(req.quoteId).toBe(7);
    expect(req.acceptNonOwnerReceiver).toBe(false);
  });

  it('validates the relayed fields (public entry point, not a passthrough)', () => {
    expect(errCode(() => parseSubmitRequest({ ...base(), signature: 'beef' }))).toBe(
      'INVALID_REQUEST',
    );
    expect(
      errCode(() => parseSubmitRequest({ ...base(), order: { ...order, validTo: 2 ** 33 } })),
    ).toBe('INVALID_REQUEST');
    expect(
      errCode(() => parseSubmitRequest({ ...base(), order: { ...order, appData: '0x123' } })),
    ).toBe('INVALID_REQUEST');
    expect(
      errCode(() => parseSubmitRequest({ ...base(), order: { ...order, sellAmount: '0' } })),
    ).toBe('INVALID_AMOUNT');
    expect(
      errCode(() =>
        parseSubmitRequest({ ...base(), order: { ...order, sellTokenBalance: 'external' } }),
      ),
    ).toBe('INVALID_REQUEST');
    expect(errCode(() => parseSubmitRequest({ ...base(), signingScheme: 'presign' }))).toBe(
      'INVALID_REQUEST',
    );
  });
});
