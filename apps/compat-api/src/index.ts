/**
 * Ophis sync-quote compat surface (Cloudflare Worker).
 *
 * Accepts the Odos v3 request shape (PathRequestV3 / AssemblePathRequest /
 * SwapRequestV3 field names; single token in, single token out) and answers
 * with the QuoteResponse field surface plus a namespaced `ophis` block:
 * an unsigned CoW order draft, the EIP-712 signing envelope, the exact
 * fullAppData string, and explicit async-settlement semantics. The Worker
 * holds no keys and never signs; /sor/submit only relays pre-signed orders
 * after re-running the full validation set.
 *
 * Endpoints:
 *   POST /sor/quote/v3                          quote (+ draft + pathId when userAddr is sent)
 *   POST /sor/assemble                          pathId -> unsigned order draft (transaction: null, always)
 *   POST /sor/swap/v3                           quote + assembly in one call (userAddr required)
 *   POST /sor/submit                            keyless relay of a pre-signed order
 *   GET  /sor/order-status/{chainId}/{orderUid} order + trades passthrough, 3s cache
 *   GET  /sor/settlement/{chainId}/{orderUid}   bounded settlement long-poll (Mode B1)
 *   GET  /healthz
 */
import { keccak256, toBytes } from 'viem';
import {
  addressesEqual,
  assertReceiverIsOwner,
  buildOphisFullAppData,
  buildOrder,
  checksum,
  getOphisOrderbookUrl,
  isZeroAddress,
  type Address,
  type BuiltOrder,
  type OphisAppData,
  type OphisPartnerFee,
} from '@ophis/sdk';

import { parseAssembleRequest, parseQuoteRequest, parseSubmitRequest } from './mapping.js';
import { mintPathId, PATH_ID_TTL_SECONDS, verifyPathId } from './pathid.js';
import {
  fetchOrder,
  fetchOrderbookQuote,
  fetchTrades,
  relayOrder,
  type OrderbookQuote,
} from './upstream.js';
import { computeValues } from './values.js';
import {
  COMPAT_DOCS_URL,
  CompatError,
  enabledChains,
  envFlag,
  settlementBaselineSeconds,
  SUBMIT_NOTE,
  warning,
  type CompatAssembleResponse,
  type CompatErrorEnvelope,
  type CompatQuoteRequest,
  type CompatQuoteResponse,
  type CompatWarning,
  type Env,
  type OphisBlock,
  type PathIdPayload,
} from './types.js';

/** Injectable dependencies so the whole surface is testable with a stub fetch. */
export interface Deps {
  fetchImpl: typeof fetch;
  /** Unix milliseconds. */
  nowMs: () => number;
  /** Bounded delay for the settlement long-poll; injectable so tests do not wait. */
  sleep: (ms: number) => Promise<void>;
}

const realDeps: Deps = {
  fetchImpl: (...args) => fetch(...args),
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const MAX_BODY_BYTES = 64 * 1024;
const ORDER_VALID_FOR_SECONDS = 1200;
const ANON_FROM = '0x0000000000000000000000000000000000000000' as Address;
const ORDER_UID_RE = /^0x[0-9a-fA-F]{112}$/;

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (
  traceId: string,
  body: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response =>
  Response.json(body, {
    status,
    headers: { 'x-trace-id': traceId, ...CORS_HEADERS, ...extra },
  });

const errorResponse = (traceId: string, err: CompatError): Response => {
  const envelope: CompatErrorEnvelope = {
    traceId,
    error: {
      code: err.code,
      numericCode: err.numericCode,
      httpStatus: err.httpStatus,
      message: err.message,
      docs: COMPAT_DOCS_URL,
      ...(err.upstream ? { upstream: err.upstream } : {}),
    },
  };
  const extra: Record<string, string> = {};
  if (err.retryAfterSeconds !== undefined) extra['retry-after'] = String(err.retryAfterSeconds);
  return json(traceId, envelope, err.httpStatus, extra);
};

const assertChainEnabled = (env: Env, chainId: number): void => {
  const chains = enabledChains(env);
  if (!chains.includes(chainId)) {
    throw new CompatError(
      'UNSUPPORTED_CHAIN',
      `chainId ${chainId} is not served by this surface. Enabled chains: ${chains.join(', ')}.`,
    );
  }
};

async function readJsonBody(request: Request): Promise<unknown> {
  // Reject an over-cap body BEFORE buffering it: a declared Content-Length past
  // the cap fails immediately, so an arbitrarily large payload is never read
  // into memory first.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new CompatError('BODY_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  const text = await request.text();
  // Measure encoded BYTES, not UTF-16 code units: a multibyte body could carry
  // up to ~3x the cap in bytes while text.length stayed under it. This is the
  // authoritative check for a chunked/undeclared body that slipped the header.
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new CompatError('BODY_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CompatError('INVALID_REQUEST', 'Request body is not valid JSON.');
  }
}

// --- quote core -------------------------------------------------------------

interface QuoteArtifacts {
  req: CompatQuoteRequest;
  quote: OrderbookQuote;
  appData: OphisAppData;
  /** Total sell atoms the order signs (quoted sellAmount + feeAmount). */
  signedSellAmount: string;
  /** Min-out atoms after the slippage bound. */
  signedBuyAmount: string;
  /** Unsigned draft, present when userAddr was sent. */
  built: BuiltOrder | null;
  pathId: string | null;
  /** Integrator-priced partner-fee entry embedded beside the Ophis default, or null. */
  mappedPartnerFee: OphisPartnerFee | null;
  /** Typical quote-to-settlement latency (seconds), from the configured baseline. */
  expectedSettlementSeconds: number;
  values: { inValues: number[]; outValues: number[]; netOutValue: number };
  warnings: CompatWarning[];
}

async function quoteCore(env: Env, deps: Deps, req: CompatQuoteRequest): Promise<QuoteArtifacts> {
  assertChainEnabled(env, req.chainId);
  const warnings: CompatWarning[] = [...req.warnings];
  const extraPartnerFees = req.partnerFee ? [req.partnerFee] : undefined;

  // The quote request carries the EXACT appData the draft will sign (Ophis fee +
  // any mapped integrator partner fee + slippage + referral + source), so the
  // quoted amounts already price the CIP-75 fee and no widening is needed.
  const appData = buildOphisFullAppData(
    req.chainId,
    req.slippageBips,
    req.referrerCode ?? undefined,
    'compat',
    extraPartnerFees,
  );

  const quote = await fetchOrderbookQuote(
    {
      chainId: req.chainId,
      sellToken: req.sellToken,
      buyToken: req.buyToken,
      sellAmount: req.sellAmount,
      from: req.userAddr ?? ANON_FROM,
      priceQuality: req.priceQuality,
      fullAppData: appData.fullAppData,
      appDataHash: appData.appDataHash,
      validForSeconds: ORDER_VALID_FOR_SECONDS,
      pathViz: req.pathViz,
      pathVizImage: req.pathVizImage,
      pathVizImageConfig: req.pathVizImageConfig,
    },
    deps.fetchImpl,
  );

  // pathViz warns-and-degrades: if the caller asked for an artifact but the
  // feature is off (kill switch) or that artifact's assembly failed, the
  // orderbook omits the field and we surface null plus a named warning instead
  // of a hard failure. Each artifact is checked independently: the graph can
  // render while the image degrades to null (or vice versa), so a partial
  // failure still warns about exactly the missing piece.
  if (req.pathViz && quote.pathViz === null) {
    warnings.push(
      warning(
        'PATH_VIZ_UNAVAILABLE',
        'pathViz (the route graph) was requested but is not available on this deployment right now ' +
          '(route visualization is flag-gated and degrades to null); the quote itself is unaffected.',
      ),
    );
  }
  if (req.pathVizImage && quote.pathVizImage === null) {
    warnings.push(
      warning(
        'PATH_VIZ_UNAVAILABLE',
        'pathVizImage (the rendered SVG) was requested but is not available on this deployment right now ' +
          '(route visualization is flag-gated and degrades to null); the quote itself is unaffected.',
      ),
    );
  }

  // Modern CoW order signing: sign the full before-fee sell with feeAmount 0;
  // the limit (min out) is the quoted out minus the caller's slippage bound.
  const signedSell = BigInt(quote.sellAmount) + BigInt(quote.feeAmount);
  const signedBuy = (BigInt(quote.buyAmount) * BigInt(10_000 - req.slippageBips)) / 10_000n;
  if (signedBuy <= 0n) {
    throw new CompatError(
      'INVALID_AMOUNT',
      'The quoted output is too small to survive the slippage bound; increase the input amount.',
    );
  }

  let built: BuiltOrder | null = null;
  let pathId: string | null = null;
  if (req.userAddr) {
    if (!env.COMPAT_PATHID_KEY) {
      // Assemblable quotes mint pathIds; a missing key is a deploy mistake
      // that must fail loudly, not silently produce un-assemblable quotes.
      throw new CompatError(
        'CONFIG_MISSING',
        'Server misconfiguration: pathId signing key is not set.',
      );
    }
    const nowSeconds = Math.floor(deps.nowMs() / 1000);
    built = buildOrder(
      {
        chainId: req.chainId,
        owner: req.userAddr,
        sellToken: req.sellToken,
        buyToken: req.buyToken,
        sellAmount: signedSell.toString(),
        buyAmount: signedBuy.toString(),
        kind: 'sell',
        validForSeconds: ORDER_VALID_FOR_SECONDS,
        slippageBips: req.slippageBips,
        referrerCode: req.referrerCode ?? undefined,
        source: 'compat',
        partnerFees: extraPartnerFees,
      },
      nowSeconds,
    );
    if (built.appDataHash.toLowerCase() !== appData.appDataHash.toLowerCase()) {
      // The draft must sign the exact appData the quote priced. buildOrder
      // derives it from the same inputs, so a mismatch is a code bug.
      throw new CompatError(
        'INTERNAL_ERROR',
        'appData drift between quote and draft; report this with the traceId.',
      );
    }
    const quoteExpSeconds = quote.expiration
      ? Math.floor(Date.parse(quote.expiration) / 1000)
      : NaN;
    const exp = Number.isFinite(quoteExpSeconds)
      ? Math.min(nowSeconds + PATH_ID_TTL_SECONDS, quoteExpSeconds)
      : nowSeconds + PATH_ID_TTL_SECONDS;
    const payload: PathIdPayload = {
      v: 1,
      cid: req.chainId,
      usr: req.userAddr,
      st: req.sellToken,
      bt: req.buyToken,
      ssa: signedSell.toString(),
      sba: signedBuy.toString(),
      qba: quote.buyAmount,
      fee: quote.feeAmount,
      slp: req.slippageBips,
      ref: req.referrerCode,
      pf: req.partnerFee,
      qid: quote.quoteId,
      iat: nowSeconds,
      exp,
    };
    pathId = await mintPathId(payload, env.COMPAT_PATHID_KEY);
  }

  const values = await computeValues(
    {
      chainId: req.chainId,
      sellToken: req.sellToken,
      buyToken: req.buyToken,
      inAmount: signedSell.toString(),
      outAmount: quote.buyAmount,
    },
    deps.fetchImpl,
    deps.nowMs(),
  );
  warnings.push(...values.warnings);
  warnings.push(
    warning(
      'GASLESS_SETTLEMENT',
      'gasEstimate/gweiPerGas/gasEstimateValue are 0: you submit no transaction and pay no gas. The winning solver pays settlement gas; that cost is already priced into the quoted amounts (see ophis.executionCost).',
    ),
    warning(
      'BLOCK_NUMBER_UNAVAILABLE',
      'blockNumber is 0: quotes come from a batch auction, not a block-pinned route. Use ophis.expiration for staleness.',
    ),
  );

  return {
    req,
    quote,
    appData,
    signedSellAmount: signedSell.toString(),
    signedBuyAmount: signedBuy.toString(),
    built,
    pathId,
    mappedPartnerFee: req.partnerFee,
    expectedSettlementSeconds: settlementBaselineSeconds(env),
    values: {
      inValues: values.inValues,
      outValues: values.outValues,
      netOutValue: values.netOutValue,
    },
    warnings,
  };
}

const ophisBlock = (
  art: QuoteArtifacts,
  warnings: CompatWarning[],
  overrides?: Partial<OphisBlock>,
): OphisBlock => ({
  settlementModel: 'batch-auction-async',
  expectedSettlementSeconds: art.expectedSettlementSeconds,
  valueCurrency: 'native',
  assemblable: art.built !== null,
  quoteId: art.quote.quoteId,
  expiration: art.quote.expiration,
  orderbookUrl: getOphisOrderbookUrl(art.req.chainId),
  executionCost:
    art.quote.gasAmount && art.quote.gasPriceWei
      ? {
          gasAmount: art.quote.gasAmount,
          gasPriceWei: art.quote.gasPriceWei,
          feeAmount: art.quote.feeAmount,
        }
      : null,
  order: art.built?.order ?? null,
  signing: art.built?.signing ?? null,
  fullAppData: art.built ? art.built.fullAppData : null,
  appDataHash: art.built ? art.built.appDataHash : null,
  submit: { url: '/sor/submit', method: 'POST', note: SUBMIT_NOTE },
  warnings,
  ...overrides,
});

const quoteResponse = (traceId: string, art: QuoteArtifacts): CompatQuoteResponse => ({
  deprecated: null,
  traceId,
  inTokens: [art.req.sellToken],
  outTokens: [art.req.buyToken],
  inAmounts: [art.signedSellAmount],
  outAmounts: [art.quote.buyAmount],
  gasEstimate: 0,
  dataGasEstimate: 0,
  gweiPerGas: 0,
  gasEstimateValue: 0,
  inValues: art.values.inValues,
  outValues: art.values.outValues,
  netOutValue: art.values.netOutValue,
  priceImpact: null,
  percentDiff: 0,
  permit2Message: null,
  permit2Hash: null,
  // Total CIP-75 Volume bps embedded in the order, as a percent: the Ophis
  // protocol fee plus any mapped integrator referralFee. Both are already priced
  // into outAmounts.
  partnerFeePercent:
    ((art.appData.partnerFee?.volumeBps ?? 0) + (art.mappedPartnerFee?.volumeBps ?? 0)) / 100,
  pathId: art.pathId,
  pathViz: art.quote.pathViz,
  pathVizImage: art.quote.pathVizImage,
  blockNumber: 0,
  ophis: ophisBlock(art, art.warnings),
});

// --- handlers ---------------------------------------------------------------

async function handleQuote(
  env: Env,
  deps: Deps,
  request: Request,
  traceId: string,
): Promise<Response> {
  const req = parseQuoteRequest(await readJsonBody(request), {
    partnerFeeEnabled: envFlag(env.COMPAT_PARTNER_FEE_ENABLED),
  });
  const art = await quoteCore(env, deps, req);
  return json(traceId, quoteResponse(traceId, art));
}

/** Builds the assembly view from quote artifacts (shared by /sor/assemble and /sor/swap/v3). */
function assemblyResponse(
  traceId: string,
  art: QuoteArtifacts,
  built: BuiltOrder,
  extraWarnings: CompatWarning[],
  receiverIsNotOwner: boolean,
): CompatAssembleResponse {
  const warnings = [...extraWarnings];
  const block = ophisBlock(
    { ...art, built },
    warnings,
    receiverIsNotOwner ? { receiverIsNotOwner: true } : {},
  );
  return {
    deprecated: null,
    traceId,
    blockNumber: 0,
    gasEstimate: 0,
    gasEstimateValue: 0,
    inputTokens: [{ tokenAddress: art.req.sellToken, amount: art.signedSellAmount }],
    outputTokens: [{ tokenAddress: art.req.buyToken, amount: art.quote.buyAmount }],
    netOutValue: art.values.netOutValue,
    outValues: art.values.outValues,
    transaction: null,
    simulation: null,
    ophis: block,
  };
}

async function handleAssemble(
  env: Env,
  deps: Deps,
  request: Request,
  traceId: string,
): Promise<Response> {
  const req = parseAssembleRequest(await readJsonBody(request));
  // The CURRENT key must be present. A previous-only configuration (rotation
  // half-applied) is a misconfiguration, not a valid state, and must fail as
  // loudly as an unset key rather than quietly accepting stale tokens.
  if (typeof env.COMPAT_PATHID_KEY !== 'string' || env.COMPAT_PATHID_KEY.length === 0) {
    throw new CompatError(
      'CONFIG_MISSING',
      'Server misconfiguration: pathId signing key is not set.',
    );
  }
  const keys = [env.COMPAT_PATHID_KEY, env.COMPAT_PATHID_KEY_PREVIOUS].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
  const nowSeconds = Math.floor(deps.nowMs() / 1000);
  const payload = await verifyPathId(req.pathId, keys, nowSeconds);
  assertChainEnabled(env, payload.cid);
  if (payload.usr === null) {
    throw new CompatError(
      'NOT_ASSEMBLABLE',
      'This pathId came from a quote without userAddr, so no order can be assembled from it. Re-quote with userAddr.',
    );
  }
  if (!addressesEqual(req.userAddr, payload.usr)) {
    throw new CompatError(
      'USER_MISMATCH',
      'userAddr does not match the account this pathId was quoted for.',
    );
  }
  // Re-check the partner-fee master switch at assemble time. A pathId minted with
  // a mapped partner fee while the flag was on stays valid for up to 60s; if the
  // flag is turned off in that window, assembling it would produce a partner-fee
  // draft the now-disabled backend rejects at ingress. Refuse it here so the flag
  // protection holds end to end rather than only at quote time.
  if (payload.pf && !envFlag(env.COMPAT_PARTNER_FEE_ENABLED)) {
    throw new CompatError(
      'PARTNER_FEE_UNAVAILABLE',
      'This pathId carries an integrator partner fee, but the partner-fee program is not enabled on ' +
        'this deployment. Re-quote without referralFee, or wait until the program is live.',
    );
  }

  const warnings: CompatWarning[] = [];
  const receiverIsNotOwner =
    req.receiver !== null &&
    !isZeroAddress(req.receiver) &&
    !addressesEqual(req.receiver, req.userAddr);
  if (receiverIsNotOwner) {
    warnings.push(
      warning(
        'NON_OWNER_RECEIVER',
        'receiver differs from userAddr: proceeds will leave the signing account. /sor/submit refuses this order unless acceptNonOwnerReceiver: true is sent.',
      ),
    );
  }
  if (req.simulate) {
    warnings.push(
      warning(
        'SIMULATION_UNAVAILABLE',
        'simulate was ignored (simulation: null): there is no user transaction to simulate. The orderbook re-validates the order at submit time.',
      ),
    );
  }

  const partnerFees = payload.pf ? [payload.pf] : undefined;
  const built = buildOrder(
    {
      chainId: payload.cid,
      owner: payload.usr,
      sellToken: payload.st,
      buyToken: payload.bt,
      sellAmount: payload.ssa,
      buyAmount: payload.sba,
      kind: 'sell',
      validForSeconds: ORDER_VALID_FOR_SECONDS,
      slippageBips: payload.slp,
      referrerCode: payload.ref ?? undefined,
      source: 'compat',
      partnerFees,
      ...(receiverIsNotOwner && req.receiver ? { unsafeCustomReceiver: req.receiver } : {}),
    },
    nowSeconds,
  );

  const values = await computeValues(
    {
      chainId: payload.cid,
      sellToken: payload.st,
      buyToken: payload.bt,
      inAmount: payload.ssa,
      outAmount: payload.qba,
    },
    deps.fetchImpl,
    deps.nowMs(),
  );
  warnings.push(...values.warnings);

  const art: QuoteArtifacts = {
    req: {
      chainId: payload.cid,
      sellToken: payload.st,
      buyToken: payload.bt,
      sellAmount: payload.ssa,
      userAddr: payload.usr,
      slippageBips: payload.slp,
      referrerCode: payload.ref,
      partnerFee: payload.pf,
      priceQuality: 'optimal',
      pathViz: false,
      pathVizImage: false,
      pathVizImageConfig: null,
      warnings: [],
    },
    quote: {
      sellAmount: payload.ssa,
      buyAmount: payload.qba,
      feeAmount: payload.fee,
      validTo: built.order.validTo,
      gasAmount: null,
      gasPriceWei: null,
      quoteId: payload.qid,
      expiration: null,
      pathViz: null,
      pathVizImage: null,
    },
    appData: {
      doc: {},
      fullAppData: built.fullAppData,
      appDataHash: built.appDataHash,
      partnerFee: built.partnerFee,
    },
    signedSellAmount: payload.ssa,
    signedBuyAmount: payload.sba,
    built,
    pathId: req.pathId,
    mappedPartnerFee: payload.pf,
    expectedSettlementSeconds: settlementBaselineSeconds(env),
    values,
    warnings,
  };
  return json(traceId, assemblyResponse(traceId, art, built, warnings, receiverIsNotOwner));
}

async function handleSwap(
  env: Env,
  deps: Deps,
  request: Request,
  traceId: string,
): Promise<Response> {
  const body = await readJsonBody(request);
  const req = parseQuoteRequest(body, {
    partnerFeeEnabled: envFlag(env.COMPAT_PARTNER_FEE_ENABLED),
  });
  if (!req.userAddr) {
    throw new CompatError(
      'NOT_ASSEMBLABLE',
      'POST /sor/swap/v3 requires userAddr (it returns a signable order draft).',
    );
  }
  const record = body as Record<string, unknown>;
  const receiverRaw = record.receiver;
  const simulate = record.simulate === true;

  const art = await quoteCore(env, deps, req);
  const built = art.built;
  if (!built)
    throw new CompatError(
      'INTERNAL_ERROR',
      'Draft missing despite userAddr; report this with the traceId.',
    );

  const warnings: CompatWarning[] = [];
  let receiverIsNotOwner = false;
  let finalBuilt = built;
  if (receiverRaw !== undefined && receiverRaw !== null) {
    let receiver: Address;
    try {
      receiver = checksum(receiverRaw as string, 'receiver');
    } catch (err) {
      throw new CompatError('INVALID_ADDRESS', (err as Error).message);
    }
    if (!isZeroAddress(receiver) && !addressesEqual(receiver, req.userAddr)) {
      receiverIsNotOwner = true;
      warnings.push(
        warning(
          'NON_OWNER_RECEIVER',
          'receiver differs from userAddr: proceeds will leave the signing account. /sor/submit refuses this order unless acceptNonOwnerReceiver: true is sent.',
        ),
      );
      finalBuilt = buildOrder(
        {
          chainId: req.chainId,
          owner: req.userAddr,
          sellToken: req.sellToken,
          buyToken: req.buyToken,
          sellAmount: art.signedSellAmount,
          buyAmount: art.signedBuyAmount,
          kind: 'sell',
          validForSeconds: ORDER_VALID_FOR_SECONDS,
          slippageBips: req.slippageBips,
          referrerCode: req.referrerCode ?? undefined,
          source: 'compat',
          partnerFees: req.partnerFee ? [req.partnerFee] : undefined,
          unsafeCustomReceiver: receiver,
        },
        Math.floor(deps.nowMs() / 1000),
      );
    }
  }
  if (simulate) {
    warnings.push(
      warning(
        'SIMULATION_UNAVAILABLE',
        'simulate was ignored (simulation: null): there is no user transaction to simulate. The orderbook re-validates the order at submit time.',
      ),
    );
  }

  return json(traceId, {
    quote: quoteResponse(traceId, art),
    assembly: assemblyResponse(traceId, art, finalBuilt, warnings, receiverIsNotOwner),
  });
}

async function handleSubmit(
  env: Env,
  deps: Deps,
  request: Request,
  traceId: string,
): Promise<Response> {
  const req = parseSubmitRequest(await readJsonBody(request));
  assertChainEnabled(env, req.chainId);

  // Defence in depth, mirroring the MCP relay posture: refuse a non-owner
  // receiver unless explicitly acknowledged, even though the signature already
  // commits to it. Refusing to forward a drain-capable order is the relay's job.
  try {
    assertReceiverIsOwner(req.from, req.order.receiver, {
      allowCustomReceiver: req.acceptNonOwnerReceiver,
    });
  } catch (err) {
    throw new CompatError(
      'RECEIVER_NOT_ACKNOWLEDGED',
      `${(err as Error).message} Send acceptNonOwnerReceiver: true only if proceeds are meant to leave the account.`,
    );
  }

  // The fullAppData must hash to the signed order.appData; the orderbook would
  // reject a mismatch anyway, so fail fast with a precise message.
  const computed = keccak256(toBytes(req.fullAppData));
  if (computed.toLowerCase() !== req.order.appData.toLowerCase()) {
    throw new CompatError(
      'APP_DATA_MISMATCH',
      `fullAppData does not hash to order.appData (${computed} != ${req.order.appData}).`,
    );
  }

  const orderUid = await relayOrder(
    req.chainId,
    {
      ...req.order,
      appData: req.fullAppData,
      appDataHash: req.order.appData,
      signingScheme: req.signingScheme,
      signature: req.signature,
      from: req.from,
      ...(req.quoteId !== null ? { quoteId: req.quoteId } : {}),
    },
    deps.fetchImpl,
  );
  return json(traceId, {
    traceId,
    orderUid,
    ophis: {
      settlementModel: 'batch-auction-async',
      expectedSettlementSeconds: settlementBaselineSeconds(env),
      statusUrl: `/sor/order-status/${req.chainId}/${orderUid}`,
      // Bounded long-poll: blocks until the order settles or the wait elapses,
      // so you do not have to busy-poll statusUrl.
      settlementAwaitUrl: `/sor/settlement/${req.chainId}/${orderUid}`,
      orderbookUrl: getOphisOrderbookUrl(req.chainId),
      note: 'Settlement is asynchronous: solvers compete in the next batch auction. Poll statusUrl or block on settlementAwaitUrl; typical settlement is on the order of tens of seconds, and the order expires at order.validTo if unfilled.',
    },
  });
}

// Small positive cache so integrators polling order status do not hammer the
// orderbook. Per-isolate and best-effort by design.
const STATUS_CACHE_TTL_MS = 3_000;
const statusCache = new Map<string, { at: number; body: unknown }>();

/** Test hook: drop the status cache. */
export const clearStatusCache = (): void => {
  statusCache.clear();
};

async function handleStatus(
  env: Env,
  deps: Deps,
  chainIdRaw: string,
  orderUid: string,
  traceId: string,
): Promise<Response> {
  const chainId = Number.parseInt(chainIdRaw, 10);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new CompatError('INVALID_REQUEST', 'chainId path segment must be a positive integer.');
  }
  assertChainEnabled(env, chainId);
  if (!ORDER_UID_RE.test(orderUid)) {
    throw new CompatError(
      'INVALID_REQUEST',
      'orderUid path segment must be a 0x-prefixed 56-byte order UID.',
    );
  }

  const cacheKey = `${chainId}:${orderUid.toLowerCase()}`;
  const cached = statusCache.get(cacheKey);
  if (cached && deps.nowMs() - cached.at < STATUS_CACHE_TTL_MS) {
    return json(traceId, { ...(cached.body as Record<string, unknown>), traceId, cached: true });
  }

  const [order, trades] = await Promise.all([
    fetchOrder(chainId, orderUid, deps.fetchImpl),
    fetchTrades(chainId, orderUid, deps.fetchImpl),
  ]);
  const lastTrade =
    trades.length > 0 ? (trades[trades.length - 1] as Record<string, unknown>) : null;
  const body = {
    traceId,
    chainId,
    orderUid,
    status: typeof order.status === 'string' ? order.status : 'unknown',
    executedSellAmount: order.executedSellAmount ?? null,
    executedBuyAmount: order.executedBuyAmount ?? null,
    txHash: lastTrade && typeof lastTrade.txHash === 'string' ? lastTrade.txHash : null,
    order,
    trades,
    ophis: {
      settlementModel: 'batch-auction-async',
      orderbookUrl: getOphisOrderbookUrl(chainId),
    },
  };
  statusCache.set(cacheKey, { at: deps.nowMs(), body });
  return json(traceId, body);
}

// --- settlement long-poll (Mode B1) -----------------------------------------
//
// A submitted order settles asynchronously in a batch auction. Rather than
// having integrators busy-poll /sor/order-status, this endpoint blocks (bounded)
// until the order reaches a terminal state, then returns it. It is a long-poll,
// not a webhook: a Worker cannot hold a background callback past the request, so
// the bound is explicit and there are no unbounded retries. Reconnect if it
// returns pending.
const SETTLEMENT_POLL_INTERVAL_MS = 2_500;
const SETTLEMENT_DEFAULT_WAIT_SECONDS = 20;
const SETTLEMENT_MAX_WAIT_SECONDS = 55;

/**
 * Terminal settlement. `fulfilled` is the authoritative fully-settled status.
 * A trade alone is NOT sufficient for a partiallyFillable order: it stays `open`
 * after a partial fill and is still live, so treating any trade as terminal would
 * stop the long-poll while more of the order can still settle. For a fill-or-kill
 * order (partiallyFillable false) a settlement trade does mean it is done, so that
 * is accepted too (it covers the brief window before the indexer flips the status
 * to `fulfilled`).
 */
const isSettled = (status: string, partiallyFillable: boolean, trades: unknown[]): boolean =>
  status === 'fulfilled' || (!partiallyFillable && trades.length > 0);
const isTerminalUnsettled = (status: string): boolean =>
  status === 'expired' || status === 'cancelled';

async function handleSettlementAwait(
  env: Env,
  deps: Deps,
  chainIdRaw: string,
  orderUid: string,
  waitSecondsRaw: string | null,
  traceId: string,
): Promise<Response> {
  const chainId = Number.parseInt(chainIdRaw, 10);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new CompatError('INVALID_REQUEST', 'chainId path segment must be a positive integer.');
  }
  assertChainEnabled(env, chainId);
  if (!ORDER_UID_RE.test(orderUid)) {
    throw new CompatError(
      'INVALID_REQUEST',
      'orderUid path segment must be a 0x-prefixed 56-byte order UID.',
    );
  }

  // Clamp the caller's requested wait into a bounded window so the Worker never
  // holds the request open indefinitely.
  let waitSeconds = SETTLEMENT_DEFAULT_WAIT_SECONDS;
  if (waitSecondsRaw !== null) {
    const parsed = Number.parseInt(waitSecondsRaw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      waitSeconds = Math.min(parsed, SETTLEMENT_MAX_WAIT_SECONDS);
    }
  }
  const deadlineMs = deps.nowMs() + waitSeconds * 1000;
  const orderbookUrl = getOphisOrderbookUrl(chainId);

  // Bounded poll loop: at most ceil(wait / interval) + 1 iterations, so there is
  // a hard upper bound on upstream calls regardless of settlement outcome.
  for (;;) {
    const [order, trades] = await Promise.all([
      fetchOrder(chainId, orderUid, deps.fetchImpl),
      fetchTrades(chainId, orderUid, deps.fetchImpl),
    ]);
    const status = typeof order.status === 'string' ? order.status : 'unknown';
    const partiallyFillable = order.partiallyFillable === true;
    const settled = isSettled(status, partiallyFillable, trades);
    const terminal = settled || isTerminalUnsettled(status);
    if (terminal || deps.nowMs() >= deadlineMs) {
      const lastTrade =
        trades.length > 0 ? (trades[trades.length - 1] as Record<string, unknown>) : null;
      return json(traceId, {
        traceId,
        chainId,
        orderUid,
        settled,
        terminal,
        pending: !terminal,
        status,
        txHash: lastTrade && typeof lastTrade.txHash === 'string' ? lastTrade.txHash : null,
        executedSellAmount: order.executedSellAmount ?? null,
        executedBuyAmount: order.executedBuyAmount ?? null,
        order,
        trades,
        ophis: {
          settlementModel: 'batch-auction-async',
          orderbookUrl,
          // When still pending, reconnect after this hint rather than tight-looping.
          ...(terminal
            ? {}
            : { pollAgainAfterSeconds: Math.ceil(SETTLEMENT_POLL_INTERVAL_MS / 1000) }),
        },
      });
    }
    // Sleep only when another poll will follow, and never past the deadline.
    const remainingMs = deadlineMs - deps.nowMs();
    await deps.sleep(Math.min(SETTLEMENT_POLL_INTERVAL_MS, Math.max(0, remainingMs)));
  }
}

// --- router -----------------------------------------------------------------

export async function handleRequest(
  request: Request,
  env: Env,
  deps: Deps = realDeps,
): Promise<Response> {
  const traceId = crypto.randomUUID();
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    if (path === '/healthz' && request.method === 'GET') {
      return json(traceId, {
        status: 'ok',
        service: 'ophis-compat-api',
        chains: enabledChains(env),
        docs: COMPAT_DOCS_URL,
      });
    }

    if (path.startsWith('/sor/')) {
      // Per-IP rate limit (per colo, best-effort): abuse cap for the public
      // unauthenticated surface. Local wrangler dev treats this as a no-op.
      const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
      if (env.COMPAT_RATE_LIMIT) {
        const { success } = await env.COMPAT_RATE_LIMIT.limit({ key: ip });
        if (!success) {
          throw new CompatError(
            'RATE_LIMITED',
            'Rate limit exceeded: slow down globally. Do not retry this call.',
            {
              retryAfterSeconds: 30,
            },
          );
        }
      }

      if (path === '/sor/quote/v3' && request.method === 'POST')
        return await handleQuote(env, deps, request, traceId);
      if (path === '/sor/assemble' && request.method === 'POST')
        return await handleAssemble(env, deps, request, traceId);
      if (path === '/sor/swap/v3' && request.method === 'POST')
        return await handleSwap(env, deps, request, traceId);
      if (path === '/sor/submit' && request.method === 'POST')
        return await handleSubmit(env, deps, request, traceId);

      const statusMatch = path.match(/^\/sor\/order-status\/([^/]+)\/([^/]+)$/);
      if (statusMatch && request.method === 'GET') {
        return await handleStatus(env, deps, statusMatch[1], statusMatch[2], traceId);
      }

      const settleMatch = path.match(/^\/sor\/settlement\/([^/]+)\/([^/]+)$/);
      if (settleMatch && request.method === 'GET') {
        return await handleSettlementAwait(
          env,
          deps,
          settleMatch[1],
          settleMatch[2],
          url.searchParams.get('waitSeconds'),
          traceId,
        );
      }
    }

    throw new CompatError(
      'NOT_FOUND',
      'Unknown route. Endpoints: POST /sor/quote/v3, /sor/assemble, /sor/swap/v3, /sor/submit; ' +
        'GET /sor/order-status/{chainId}/{orderUid}, /sor/settlement/{chainId}/{orderUid}, /healthz.',
    );
  } catch (err) {
    if (err instanceof CompatError) return errorResponse(traceId, err);
    // SDK guards throw plain Errors on malformed inputs that slipped past
    // mapping; surface them as request validation, not a 500.
    if (err instanceof Error && /Ophis:|must be|invalid/i.test(err.message)) {
      return errorResponse(traceId, new CompatError('INVALID_REQUEST', err.message));
    }
    console.error('compat-api unhandled error', err);
    return errorResponse(
      traceId,
      new CompatError('INTERNAL_ERROR', 'Unexpected server error; report this with the traceId.'),
    );
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, realDeps);
  },
};
