import { beforeEach, describe, expect, it } from 'vitest';
import { buildOrder } from '@ophis/sdk';

import { clearStatusCache, handleRequest, type Deps } from '../src/index.js';
import { mintPathId } from '../src/pathid.js';
import { clearPriceCache } from '../src/values.js';
import type { Env, PathIdPayload } from '../src/types.js';

const USER = '0x931e9f531cdd4835Def0dEDE1452BA8aFbe5ff9b';
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const WETH_OP = '0x4200000000000000000000000000000000000006';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const UID = `0x${'12'.repeat(56)}`;

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const ENV: Env = { COMPAT_PATHID_KEY: 'test-key' };

/** Hand-authored upstream stubs shaped to the live Optimism orderbook responses. */
const liveQuoteBody = {
  quote: {
    sellToken: USDC_OP.toLowerCase(),
    buyToken: WETH_OP.toLowerCase(),
    receiver: USER.toLowerCase(),
    sellAmount: '999997740',
    buyAmount: '538126832449298940',
    validTo: NOW_S + 1200,
    appData: `0x${'00'.repeat(32)}`,
    feeAmount: '2260',
    gasAmount: '1217142',
    gasPrice: '1000346',
    kind: 'sell',
    partiallyFillable: false,
    signingScheme: 'eip712',
  },
  from: USER.toLowerCase(),
  expiration: new Date(NOW_MS + 90_000).toISOString(),
  id: 9858,
  verified: false,
};

interface StubOptions {
  quote?: () => Response;
  orders?: (init?: RequestInit) => Response;
  orderByUid?: () => Response;
  trades?: () => Response;
  onRequest?: (url: string, init?: RequestInit) => void;
}

const stubFetch = (opts: StubOptions = {}): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    opts.onRequest?.(url, init);
    if (url.includes('/api/v1/quote')) {
      return (opts.quote ?? (() => Response.json(liveQuoteBody)))();
    }
    if (url.includes('/native_price')) {
      const price = url.toLowerCase().includes(USDC_OP.toLowerCase()) ? 538821428.2368592 : 1.0;
      return Response.json({ price });
    }
    if (url.endsWith('/api/v1/orders') && init?.method === 'POST') {
      return (opts.orders ?? (() => Response.json(UID)))(init);
    }
    if (url.includes('/api/v1/orders/')) {
      return (
        opts.orderByUid ??
        (() =>
          Response.json({
            status: 'fulfilled',
            executedSellAmount: '1000000000',
            executedBuyAmount: '538500000000000000',
          }))
      )();
    }
    if (url.includes('/api/v1/trades')) {
      return (opts.trades ?? (() => Response.json([{ txHash: '0xfeed', orderUid: UID }])))();
    }
    throw new Error(`unexpected upstream call: ${url}`);
  }) as typeof fetch;

// A controllable clock so the settlement long-poll can be tested without real
// waits: `sleep` advances the fake clock instead of blocking.
const deps = (fetchImpl: typeof fetch): Deps => {
  let clock = NOW_MS;
  return {
    fetchImpl,
    nowMs: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
};

const post = (path: string, body: unknown): Request =>
  new Request(`https://compat.ophis.fi${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const quoteBody = (overrides: Record<string, unknown> = {}) => ({
  chainId: 10,
  inputTokens: [{ tokenAddress: USDC_OP, amount: '1000000000' }],
  outputTokens: [{ tokenAddress: WETH_OP, proportion: 1 }],
  userAddr: USER,
  slippageLimitPercent: 0.3,
  ...overrides,
});

// 30 bips off the quoted out.
const EXPECTED_MIN_OUT = ((538126832449298940n * 9970n) / 10000n).toString();

beforeEach(() => {
  clearPriceCache();
  clearStatusCache();
});

describe('POST /sor/quote/v3', () => {
  it('answers the full compat surface with an assemblable draft', async () => {
    const res = await handleRequest(post('/sor/quote/v3', quoteBody()), ENV, deps(stubFetch()));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-trace-id')).toBeTruthy();
    const body = (await res.json()) as Record<string, any>;

    // Odos-shaped field surface
    expect(body.inTokens).toEqual([USDC_OP]);
    expect(body.outTokens).toEqual([WETH_OP]);
    expect(body.inAmounts).toEqual(['1000000000']); // 999997740 + 2260
    expect(body.outAmounts).toEqual(['538126832449298940']);
    expect(body.gasEstimate).toBe(0);
    expect(body.gasEstimateValue).toBe(0);
    expect(body.priceImpact).toBeNull();
    expect(body.percentDiff).toBe(0);
    expect(body.permit2Message).toBeNull();
    expect(body.pathViz).toBeNull();
    expect(body.partnerFeePercent).toBe(0.01); // 1 bp sovereign base on chain 10
    expect(body.pathId).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.blockNumber).toBe(0);
    expect(body.inValues[0]).toBeCloseTo(0.5388, 3);
    expect(body.outValues[0]).toBeCloseTo(0.53813, 4);
    expect(body.netOutValue).toBe(body.outValues[0]);

    // ophis block: draft + envelope + async semantics
    expect(body.ophis.settlementModel).toBe('batch-auction-async');
    expect(body.ophis.expectedSettlementSeconds).toBe(24); // configured/derived baseline
    expect(body.ophis.valueCurrency).toBe('native');
    expect(body.ophis.assemblable).toBe(true);
    expect(body.ophis.quoteId).toBe(9858);
    expect(body.ophis.orderbookUrl).toBe('https://optimism-mainnet.ophis.fi');
    expect(body.ophis.order.receiver).toBe(USER);
    expect(body.ophis.order.sellAmount).toBe('1000000000');
    expect(body.ophis.order.buyAmount).toBe(EXPECTED_MIN_OUT);
    expect(body.ophis.order.feeAmount).toBe('0');
    expect(body.ophis.signing.primaryType).toBe('Order');
    expect(body.ophis.signing.domain.chainId).toBe(10);
    expect(body.ophis.fullAppData).toContain('"appCode":"ophis"');
    expect(body.ophis.executionCost).toEqual({
      gasAmount: '1217142',
      gasPriceWei: '1000346',
      feeAmount: '2260',
    });
    const warningCodes = body.ophis.warnings.map((w: { code: string }) => w.code);
    expect(warningCodes).toContain('GASLESS_SETTLEMENT');
    expect(warningCodes).toContain('BLOCK_NUMBER_UNAVAILABLE');
  });

  it('embeds the referral mapping in appData', async () => {
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralCode: 777 })),
      ENV,
      deps(stubFetch()),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.ophis.fullAppData).toContain('"ophisReferrer":{"code":"odos777"}');
    expect(body.ophis.fullAppData).toContain('"ophisSource":{"app":"compat"}');
  });

  it('quotes without userAddr but is not assemblable', async () => {
    const body = quoteBody();
    delete (body as Record<string, unknown>).userAddr;
    const res = await handleRequest(post('/sor/quote/v3', body), ENV, deps(stubFetch()));
    const parsed = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(parsed.pathId).toBeNull();
    expect(parsed.ophis.assemblable).toBe(false);
    expect(parsed.ophis.order).toBeNull();
    const codes = parsed.ophis.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('NOT_ASSEMBLABLE_NO_USER');
  });

  it('surfaces the error envelope with string + numeric codes', async () => {
    const res = await handleRequest(
      post(
        '/sor/quote/v3',
        quoteBody({
          inputTokens: [
            { tokenAddress: USDC_OP, amount: '1' },
            { tokenAddress: OTHER, amount: '1' },
          ],
        }),
      ),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.traceId).toBeTruthy();
    expect(body.error.code).toBe('MULTI_TOKEN_UNSUPPORTED');
    expect(body.error.numericCode).toBe(4901);
    expect(body.error.docs).toContain('migrating-from-odos');
  });

  it('passes unroutable through as NO_ROUTE (an answer, 404)', async () => {
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody()),
      ENV,
      deps(
        stubFetch({
          quote: () =>
            Response.json(
              { errorType: 'NoLiquidity', description: 'no route found' },
              { status: 404 },
            ),
        }),
      ),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe('NO_ROUTE');
    expect(body.error.numericCode).toBe(2000);
    expect(body.error.upstream.errorType).toBe('NoLiquidity');
  });

  it('maps upstream 5xx to a retryable 503', async () => {
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody()),
      ENV,
      deps(
        stubFetch({
          quote: () => Response.json({ errorType: 'InternalServerError' }, { status: 500 }),
        }),
      ),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('maps a non-JSON 200 upstream body to a retryable 503, not a 500', async () => {
    // Same fault class as valid-JSON-wrong-shape (broken upstream), so the
    // integrator gets identical "retry" guidance instead of "our bug".
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody()),
      ENV,
      deps(
        stubFetch({
          quote: () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
        }),
      ),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('rejects unsupported chains listing the enabled set', async () => {
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ chainId: 1 })),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe('UNSUPPORTED_CHAIN');
    expect(body.error.message).toContain('10, 130, 4663');
  });

  it('fails loudly when the pathId key is missing and a draft is needed', async () => {
    const res = await handleRequest(post('/sor/quote/v3', quoteBody()), {}, deps(stubFetch()));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe('CONFIG_MISSING');
  });
});

describe('referralFee -> partnerFee mapping', () => {
  const PARTNER = OTHER; // a valid, checksummed recipient address
  const feeEnv: Env = { COMPAT_PATHID_KEY: 'test-key', COMPAT_PARTNER_FEE_ENABLED: 'true' };

  it('rejects a non-zero referralFee while the program is disabled (default)', async () => {
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralFee: 0.001, referralFeeRecipient: PARTNER })),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe('PARTNER_FEE_UNAVAILABLE');
    expect(body.error.numericCode).toBe(4902);
  });

  it('maps referralFee 0.001 to a 10 bps partnerFee entry when enabled', async () => {
    let quoteAppData: string | undefined;
    const impl = stubFetch({
      onRequest: (url, init) => {
        if (url.includes('/api/v1/quote') && init?.method === 'POST') {
          quoteAppData = (JSON.parse(String(init.body)) as { appData: string }).appData;
        }
      },
    });
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralFee: 0.001, referralFeeRecipient: PARTNER })),
      feeEnv,
      deps(impl),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    // metadata.partnerFee is now an array: Ophis base (1 bp) + partner (10 bps).
    // Keys are deterministically sorted, so recipient precedes volumeBps.
    expect(body.ophis.fullAppData).toContain('"partnerFee":[');
    expect(body.ophis.fullAppData).toContain(`"recipient":"${PARTNER}","volumeBps":10`);
    // The quote request carried the same appData the draft signs.
    expect(quoteAppData).toBe(body.ophis.fullAppData);
    // partnerFeePercent reflects total embedded volume bps: 1 + 10 = 11 bps.
    expect(body.partnerFeePercent).toBe(0.11);
    const codes = body.ophis.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('PARTNER_FEE_MAPPED');
  });

  it('rejects a mapped fee above the 90 bps program cap (never a silent clamp)', async () => {
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralFee: 0.01, referralFeeRecipient: PARTNER })),
      feeEnv,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe('PARTNER_FEE_CAP_EXCEEDED');
    expect(body.error.numericCode).toBe(4915);
  });

  it('rejects a fee too small to represent (sub-1-bps) and a missing recipient', async () => {
    const tiny = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralFee: 0.00004, referralFeeRecipient: PARTNER })),
      feeEnv,
      deps(stubFetch()),
    );
    expect(tiny.status).toBe(400);
    expect(((await tiny.json()) as Record<string, any>).error.code).toBe('INVALID_REQUEST');

    const noRecipient = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralFee: 0.001 })),
      feeEnv,
      deps(stubFetch()),
    );
    expect(noRecipient.status).toBe(400);
    expect(((await noRecipient.json()) as Record<string, any>).error.code).toBe('INVALID_ADDRESS');
  });

  it('carries the mapped fee through the quote -> assemble round-trip', async () => {
    const quoteRes = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralFee: 0.001, referralFeeRecipient: PARTNER })),
      feeEnv,
      deps(stubFetch()),
    );
    const quote = (await quoteRes.json()) as Record<string, any>;
    const assembleRes = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId: quote.pathId }),
      feeEnv,
      deps(stubFetch()),
    );
    expect(assembleRes.status).toBe(200);
    const assembly = (await assembleRes.json()) as Record<string, any>;
    // The reassembled draft signs the same appData (partner fee included).
    expect(assembly.ophis.fullAppData).toBe(quote.ophis.fullAppData);
    expect(assembly.ophis.fullAppData).toContain(`"recipient":"${PARTNER}"`);
  });

  it('refuses to assemble a still-valid partner-fee pathId after the flag is turned off', async () => {
    // Mint while the program is enabled.
    const quoteRes = await handleRequest(
      post('/sor/quote/v3', quoteBody({ referralFee: 0.001, referralFeeRecipient: PARTNER })),
      feeEnv,
      deps(stubFetch()),
    );
    const quote = (await quoteRes.json()) as Record<string, any>;
    // Assemble after the master switch is flipped off (ENV has it disabled): the
    // pathId is still within its 60s window but its partner fee is now refused.
    const assembleRes = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId: quote.pathId }),
      ENV,
      deps(stubFetch()),
    );
    expect(assembleRes.status).toBe(400);
    expect(((await assembleRes.json()) as Record<string, any>).error.code).toBe(
      'PARTNER_FEE_UNAVAILABLE',
    );
  });
});

describe('pathViz flag wiring (#924)', () => {
  const FAKE_GRAPH = { schemaVersion: 1, nodes: [], links: [], solvers: [] };
  const quoteWithViz = () =>
    Response.json({ ...liveQuoteBody, pathViz: FAKE_GRAPH, pathVizImage: 'c3ZnLWJhc2U2NA==' });

  it('populates pathViz/pathVizImage when requested and the feature answers', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const impl = stubFetch({
      quote: quoteWithViz,
      onRequest: (url, init) => {
        if (url.includes('/api/v1/quote') && init?.method === 'POST') {
          sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        }
      },
    });
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ pathViz: true, pathVizImage: true })),
      ENV,
      deps(impl),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(sentBody?.pathViz).toBe(true);
    expect(sentBody?.pathVizImage).toBe(true);
    expect(body.pathViz).toEqual(FAKE_GRAPH);
    expect(body.pathVizImage).toBe('c3ZnLWJhc2U2NA==');
    // No unavailable warning when the feature answered.
    const codes = body.ophis.warnings.map((w: { code: string }) => w.code);
    expect(codes).not.toContain('PATH_VIZ_UNAVAILABLE');
  });

  it('warns per missing artifact when the graph renders but the image degrades', async () => {
    // Graph present, image null: only the pathVizImage warning must fire, and the
    // graph is still returned. The old both-null check missed this partial case.
    const impl = stubFetch({
      quote: () => Response.json({ ...liveQuoteBody, pathViz: FAKE_GRAPH, pathVizImage: null }),
    });
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ pathViz: true, pathVizImage: true })),
      ENV,
      deps(impl),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.pathViz).toEqual(FAKE_GRAPH);
    expect(body.pathVizImage).toBeNull();
    const warns = body.ophis.warnings.filter(
      (w: { code: string }) => w.code === 'PATH_VIZ_UNAVAILABLE',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('pathVizImage');
  });

  it('does not warn about an artifact the caller did not request (image null but only graph asked)', async () => {
    const impl = stubFetch({
      quote: () => Response.json({ ...liveQuoteBody, pathViz: FAKE_GRAPH, pathVizImage: null }),
    });
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ pathViz: true })),
      ENV,
      deps(impl),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.pathViz).toEqual(FAKE_GRAPH);
    const codes = body.ophis.warnings.map((w: { code: string }) => w.code);
    expect(codes).not.toContain('PATH_VIZ_UNAVAILABLE');
  });

  it('degrades to null + warning when pathViz is requested but the feature is off', async () => {
    // Default stub omits pathViz (kill switch off / degraded).
    const res = await handleRequest(
      post('/sor/quote/v3', quoteBody({ pathViz: true })),
      ENV,
      deps(stubFetch()),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.pathViz).toBeNull();
    expect(body.pathVizImage).toBeNull();
    const codes = body.ophis.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('PATH_VIZ_UNAVAILABLE');
  });

  it('does not request pathViz when the caller did not ask (no wasted work, no warning)', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const impl = stubFetch({
      onRequest: (url, init) => {
        if (url.includes('/api/v1/quote') && init?.method === 'POST') {
          sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        }
      },
    });
    const res = await handleRequest(post('/sor/quote/v3', quoteBody()), ENV, deps(impl));
    const body = (await res.json()) as Record<string, any>;
    expect(sentBody?.pathViz).toBeUndefined();
    expect(body.pathViz).toBeNull();
    const codes = body.ophis.warnings.map((w: { code: string }) => w.code);
    expect(codes).not.toContain('PATH_VIZ_UNAVAILABLE');
  });
});

describe('GET /sor/settlement/{chainId}/{orderUid} (Mode B1 long-poll)', () => {
  it('returns immediately when the order is already settled', async () => {
    const res = await handleRequest(
      new Request(`https://compat.ophis.fi/sor/settlement/10/${UID}`),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.settled).toBe(true);
    expect(body.terminal).toBe(true);
    expect(body.pending).toBe(false);
    expect(body.status).toBe('fulfilled');
    expect(body.txHash).toBe('0xfeed');
  });

  it('resolves once a pending order settles, within the bounded wait', async () => {
    let polls = 0;
    const impl = stubFetch({
      orderByUid: () =>
        Response.json({ status: 'open', executedSellAmount: '0', executedBuyAmount: '0' }),
      trades: () => {
        polls += 1;
        // No settlement trade on the first two polls, then one appears.
        return polls < 3 ? Response.json([]) : Response.json([{ txHash: '0xfeed', orderUid: UID }]);
      },
    });
    const res = await handleRequest(
      new Request(`https://compat.ophis.fi/sor/settlement/10/${UID}?waitSeconds=30`),
      ENV,
      deps(impl),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.settled).toBe(true);
    expect(body.txHash).toBe('0xfeed');
    expect(polls).toBe(3);
  });

  it('does not treat a partial fill of a partiallyFillable order as terminal', async () => {
    // A partiallyFillable order stays `open` after its first partial fill and is
    // still live. A trade alone must NOT stop the poll (the old trades.length>0
    // check would have returned terminal here and stopped early).
    const impl = stubFetch({
      orderByUid: () =>
        Response.json({
          status: 'open',
          partiallyFillable: true,
          executedSellAmount: '400000000',
          executedBuyAmount: '200000000000000000',
        }),
      trades: () => Response.json([{ txHash: '0xpartial', orderUid: UID }]),
    });
    const res = await handleRequest(
      new Request(`https://compat.ophis.fi/sor/settlement/10/${UID}?waitSeconds=5`),
      ENV,
      deps(impl),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.settled).toBe(false);
    expect(body.pending).toBe(true);
  });

  it('treats a fill-or-kill order with a trade as settled even before the status flips', async () => {
    // partiallyFillable false + a trade = fully done (covers the indexer-lag
    // window before status becomes `fulfilled`).
    const impl = stubFetch({
      orderByUid: () =>
        Response.json({
          status: 'open',
          partiallyFillable: false,
          executedSellAmount: '1000000000',
          executedBuyAmount: '538500000000000000',
        }),
      trades: () => Response.json([{ txHash: '0xfeed', orderUid: UID }]),
    });
    const res = await handleRequest(
      new Request(`https://compat.ophis.fi/sor/settlement/10/${UID}?waitSeconds=5`),
      ENV,
      deps(impl),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.settled).toBe(true);
    expect(body.txHash).toBe('0xfeed');
  });

  it('returns pending (bounded, no unbounded retry) when the wait elapses', async () => {
    const impl = stubFetch({
      orderByUid: () =>
        Response.json({ status: 'open', executedSellAmount: '0', executedBuyAmount: '0' }),
      trades: () => Response.json([]),
    });
    const res = await handleRequest(
      new Request(`https://compat.ophis.fi/sor/settlement/10/${UID}?waitSeconds=5`),
      ENV,
      deps(impl),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.settled).toBe(false);
    expect(body.pending).toBe(true);
    expect(body.ophis.pollAgainAfterSeconds).toBeGreaterThan(0);
  });

  it('rejects a malformed uid', async () => {
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/sor/settlement/10/0xbad'),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /sor/assemble', () => {
  const mintedPathId = async (): Promise<string> => {
    const res = await handleRequest(post('/sor/quote/v3', quoteBody()), ENV, deps(stubFetch()));
    const body = (await res.json()) as Record<string, any>;
    return body.pathId as string;
  };

  it('rebuilds the draft from the pathId', async () => {
    const pathId = await mintedPathId();
    const res = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.transaction).toBeNull();
    expect(body.simulation).toBeNull();
    expect(body.inputTokens).toEqual([{ tokenAddress: USDC_OP, amount: '1000000000' }]);
    expect(body.outputTokens).toEqual([{ tokenAddress: WETH_OP, amount: '538126832449298940' }]);
    expect(body.ophis.order.buyAmount).toBe(EXPECTED_MIN_OUT);
    expect(body.ophis.order.receiver).toBe(USER);
    expect(body.ophis.receiverIsNotOwner).toBeUndefined();
  });

  it('honors a receiver override but flags it and keeps submit gated', async () => {
    const pathId = await mintedPathId();
    const res = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId, receiver: OTHER, simulate: true }),
      ENV,
      deps(stubFetch()),
    );
    const body = (await res.json()) as Record<string, any>;
    expect(body.ophis.order.receiver.toLowerCase()).toBe(OTHER.toLowerCase());
    expect(body.ophis.receiverIsNotOwner).toBe(true);
    const codes = body.ophis.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('NON_OWNER_RECEIVER');
    expect(codes).toContain('SIMULATION_UNAVAILABLE');
  });

  it('rejects a mismatched user', async () => {
    const pathId = await mintedPathId();
    const res = await handleRequest(
      post('/sor/assemble', { userAddr: OTHER, pathId }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('USER_MISMATCH');
  });

  it('rejects expired pathIds with 410', async () => {
    const payload: PathIdPayload = {
      v: 1,
      cid: 10,
      usr: USER as PathIdPayload['usr'],
      st: USDC_OP as PathIdPayload['st'],
      bt: WETH_OP as PathIdPayload['bt'],
      ssa: '1000000000',
      sba: EXPECTED_MIN_OUT,
      qba: '538126832449298940',
      fee: '2260',
      slp: 30,
      ref: null,
      pf: null,
      qid: 9858,
      iat: NOW_S - 120,
      exp: NOW_S - 60,
    };
    const pathId = await mintPathId(payload, 'test-key');
    const res = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('PATH_ID_EXPIRED');
  });

  it('accepts pathIds signed with the previous key (rotation window)', async () => {
    const pathId = await mintedPathId();
    const rotated: Env = { COMPAT_PATHID_KEY: 'new-key', COMPAT_PATHID_KEY_PREVIOUS: 'test-key' };
    const res = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId }),
      rotated,
      deps(stubFetch()),
    );
    expect(res.status).toBe(200);
  });

  it('treats a previous-only key set as a misconfiguration (CONFIG_MISSING)', async () => {
    const pathId = await mintedPathId();
    // Current key unset, only the previous one present: a half-applied rotation.
    // It must fail as loudly as an unset key rather than quietly accept tokens.
    const halfRotated: Env = { COMPAT_PATHID_KEY_PREVIOUS: 'test-key' };
    const res = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId }),
      halfRotated,
      deps(stubFetch()),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('CONFIG_MISSING');
  });
});

describe('POST /sor/swap/v3', () => {
  it('returns quote + assembly in one call', async () => {
    const res = await handleRequest(post('/sor/swap/v3', quoteBody()), ENV, deps(stubFetch()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.quote.inAmounts).toEqual(['1000000000']);
    expect(body.assembly.transaction).toBeNull();
    expect(body.assembly.ophis.order.buyAmount).toBe(EXPECTED_MIN_OUT);
  });

  it('requires userAddr', async () => {
    const body = quoteBody();
    delete (body as Record<string, unknown>).userAddr;
    const res = await handleRequest(post('/sor/swap/v3', body), ENV, deps(stubFetch()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('NOT_ASSEMBLABLE');
  });
});

describe('POST /sor/submit', () => {
  const draft = () =>
    buildOrder(
      {
        chainId: 10,
        owner: USER as `0x${string}`,
        sellToken: USDC_OP as `0x${string}`,
        buyToken: WETH_OP as `0x${string}`,
        sellAmount: '1000000000',
        buyAmount: EXPECTED_MIN_OUT,
        kind: 'sell',
        slippageBips: 30,
        source: 'compat',
      },
      NOW_S,
    );

  it('re-validates and relays with quoteId', async () => {
    const built = draft();
    let posted: Record<string, unknown> | null = null;
    const res = await handleRequest(
      post('/sor/submit', {
        chainId: 10,
        order: built.order,
        signature: '0xdeadbeef',
        from: USER,
        fullAppData: built.fullAppData,
        quoteId: 9858,
      }),
      ENV,
      deps(
        stubFetch({
          orders: (init) => {
            posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Response.json(UID);
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.orderUid).toBe(UID);
    expect(body.ophis.statusUrl).toBe(`/sor/order-status/10/${UID}`);
    expect(posted).not.toBeNull();
    expect(posted!.appData).toBe(built.fullAppData);
    expect(posted!.appDataHash).toBe(built.appDataHash);
    expect(posted!.quoteId).toBe(9858);
    expect(posted!.signingScheme).toBe('eip712');
  });

  it('refuses a fullAppData that does not hash to order.appData', async () => {
    const built = draft();
    const res = await handleRequest(
      post('/sor/submit', {
        chainId: 10,
        order: built.order,
        signature: '0xdeadbeef',
        from: USER,
        fullAppData: '{"tampered":true}',
      }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('APP_DATA_MISMATCH');
  });

  it('refuses a non-owner receiver without the explicit ack', async () => {
    const built = buildOrder(
      {
        chainId: 10,
        owner: USER as `0x${string}`,
        sellToken: USDC_OP as `0x${string}`,
        buyToken: WETH_OP as `0x${string}`,
        sellAmount: '1000000000',
        buyAmount: EXPECTED_MIN_OUT,
        kind: 'sell',
        slippageBips: 30,
        source: 'compat',
        unsafeCustomReceiver: OTHER as `0x${string}`,
      },
      NOW_S,
    );
    const submitBody = {
      chainId: 10,
      order: built.order,
      signature: '0xdeadbeef',
      from: USER,
      fullAppData: built.fullAppData,
    };
    const refused = await handleRequest(post('/sor/submit', submitBody), ENV, deps(stubFetch()));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as Record<string, any>).error.code).toBe(
      'RECEIVER_NOT_ACKNOWLEDGED',
    );

    const acked = await handleRequest(
      post('/sor/submit', { ...submitBody, acceptNonOwnerReceiver: true }),
      ENV,
      deps(stubFetch()),
    );
    expect(acked.status).toBe(200);
  });
});

describe('GET /sor/order-status/{chainId}/{orderUid}', () => {
  it('proxies order + trades and caches for 3 seconds', async () => {
    let orderFetches = 0;
    const impl = stubFetch({
      onRequest: (url) => {
        if (url.includes('/api/v1/orders/')) orderFetches += 1;
      },
    });
    const get = () =>
      handleRequest(
        new Request(`https://compat.ophis.fi/sor/order-status/10/${UID}`),
        ENV,
        deps(impl),
      );
    const first = (await (await get()).json()) as Record<string, any>;
    expect(first.status).toBe('fulfilled');
    expect(first.txHash).toBe('0xfeed');
    expect(first.executedSellAmount).toBe('1000000000');
    const second = (await (await get()).json()) as Record<string, any>;
    expect(second.cached).toBe(true);
    expect(orderFetches).toBe(1);
  });

  it('rejects malformed uids', async () => {
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/sor/order-status/10/0x1234'),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(400);
  });
});

describe('worker plumbing', () => {
  it('serves /healthz without rate limiting', async () => {
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/healthz'),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe('ok');
    expect(body.chains).toEqual([10, 130, 4663]);
  });

  it('applies the per-IP rate limit on /sor/*', async () => {
    const env: Env = { ...ENV, COMPAT_RATE_LIMIT: { limit: async () => ({ success: false }) } };
    const res = await handleRequest(post('/sor/quote/v3', quoteBody()), env, deps(stubFetch()));
    expect(res.status).toBe(429);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('RATE_LIMITED');
  });

  it('caps the request body', async () => {
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/sor/quote/v3', {
        method: 'POST',
        body: `{"pad":"${'x'.repeat(70 * 1024)}"}`,
      }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(413);
  });

  it('rejects an over-cap Content-Length before buffering the body', async () => {
    // A truthful over-cap Content-Length must fail immediately; the body here is
    // small, so a 413 proves the header check fired before any read.
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/sor/quote/v3', {
        method: 'POST',
        headers: { 'content-length': String(70 * 1024) },
        body: '{}',
      }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('BODY_TOO_LARGE');
  });

  it('measures body size in bytes, not UTF-16 units', async () => {
    // Each of these emoji is 2 UTF-16 units but 4 UTF-8 bytes; ~48k of them is
    // under the cap by string length yet well over it in bytes.
    const multibyte = '\u{1F600}'.repeat(48 * 1024);
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/sor/quote/v3', {
        method: 'POST',
        body: `{"pad":"${multibyte}"}`,
      }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('BODY_TOO_LARGE');
  });

  it('404s unknown routes with the endpoint list', async () => {
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/nope'),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, any>).error.code).toBe('NOT_FOUND');
  });

  it('answers CORS preflights', async () => {
    const res = await handleRequest(
      new Request('https://compat.ophis.fi/sor/quote/v3', { method: 'OPTIONS' }),
      ENV,
      deps(stubFetch()),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// Live read-only integration against the Optimism orderbook. Quotes and builds
// only; NEVER signs or submits. Run: COMPAT_LIVE=1 pnpm --filter @ophis/compat-api test
describe.runIf(process.env.COMPAT_LIVE === '1')('live Optimism integration (read-only)', () => {
  const liveDeps: Deps = {
    fetchImpl: (...args) => fetch(...args),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const liveEnv: Env = { COMPAT_PATHID_KEY: 'live-integration-test-key' };

  it('quote -> assemble round-trip on chain 10', async () => {
    const quoteRes = await handleRequest(
      post('/sor/quote/v3', quoteBody({ slippageLimitPercent: 0.5 })),
      liveEnv,
      liveDeps,
    );
    expect(quoteRes.status).toBe(200);
    const quote = (await quoteRes.json()) as Record<string, any>;
    expect(quote.inAmounts[0]).toBe('1000000000');
    expect(BigInt(quote.outAmounts[0])).toBeGreaterThan(0n);
    expect(quote.ophis.assemblable).toBe(true);
    expect(quote.ophis.order.receiver).toBe(USER);
    expect(quote.ophis.signing.domain.verifyingContract).toBe(
      '0x310784c7FCE12d578dA6f53460777bAc9718B859',
    );
    expect(quote.partnerFeePercent).toBe(0.01);
    expect(quote.inValues[0]).toBeGreaterThan(0);

    const assembleRes = await handleRequest(
      post('/sor/assemble', { userAddr: USER, pathId: quote.pathId }),
      liveEnv,
      liveDeps,
    );
    expect(assembleRes.status).toBe(200);
    const assembly = (await assembleRes.json()) as Record<string, any>;
    expect(assembly.transaction).toBeNull();
    expect(assembly.ophis.order.sellAmount).toBe(quote.ophis.order.sellAmount);
    expect(assembly.ophis.order.buyAmount).toBe(quote.ophis.order.buyAmount);
  }, 30_000);

  it('order-status proxies a real settled order when one exists', async () => {
    // Look up any recent order by the test account; skip silently if none.
    const res = await fetch(
      `https://optimism-mainnet.ophis.fi/api/v1/account/${USER}/orders?limit=1`,
    );
    if (!res.ok) return;
    const orders = (await res.json()) as { uid?: string }[];
    if (!Array.isArray(orders) || orders.length === 0 || !orders[0]?.uid) return;
    const statusRes = await handleRequest(
      new Request(`https://compat.ophis.fi/sor/order-status/10/${orders[0].uid}`),
      liveEnv,
      liveDeps,
    );
    expect(statusRes.status).toBe(200);
    const body = (await statusRes.json()) as Record<string, any>;
    expect(typeof body.status).toBe('string');
  }, 30_000);
});
