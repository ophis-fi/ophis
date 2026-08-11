/**
 * Request mapping: the Odos v3 field names in, the internal compat shapes out.
 *
 * Mapping table (request side, per the archived OpenAPI reference):
 *   chainId               -> chainId (must be an enabled Ophis-operated chain)
 *   inputTokens[1]        -> sellToken + sellAmount (arrays longer than 1 are
 *                            rejected: MULTI_TOKEN_UNSUPPORTED until the basket
 *                            roadmap ships multi-asset orders)
 *   outputTokens[1]       -> buyToken (proportion must be 1)
 *   userAddr              -> order owner; absent = quote-only (assemblable: false)
 *   slippageLimitPercent  -> signed slippage bound in bips (x100, cap 5000; above
 *                            the cap is INVALID_SLIPPAGE, never silently clamped)
 *   simple                -> priceQuality 'fast' (true) / 'optimal' (false)
 *   referralCode (int)    -> appData metadata.ophisReferrer.code = `odos<code>`
 *   referralFee (decimal) -> a CIP-75 Volume metadata.partnerFee entry with
 *                            referralFeeRecipient (0.001 fraction = 10 volumeBps),
 *                            once the partner-fee program is enabled; capped at
 *                            the program's 90 bps third-party ceiling. While the
 *                            program is off it is rejected (PARTNER_FEE_UNAVAILABLE)
 *                            rather than silently dropped.
 *   gasPrice              -> ignored + warning (solvers pay gas)
 *   source/pool filters   -> ignored + warning (solver competition replaces routing filters)
 *   disableRFQs, compact  -> silent no-ops (no RFQ lane; one response shape)
 *   likeAsset             -> ignored + warning
 *   pathViz*              -> requested from the orderbook pathviz endpoint when
 *                            the feature is enabled, else null + warning
 *   permit2               -> reserved null + warning (until permit2-witness ships)
 */
import {
  checksum,
  isZeroAddress,
  MAX_SLIPPAGE_BIPS,
  normalizeOphisReferralCode,
  type Address,
  type OphisVolumePartnerFee,
} from '@ophis/sdk';

import {
  CompatError,
  warning,
  type CompatAssembleRequest,
  type CompatQuoteRequest,
  type CompatSubmitRequest,
  type CompatWarning,
} from './types.js';

/**
 * Program-wide cap on a THIRD-PARTY partner's Volume-policy bps. Mirrors the
 * Rust constant `MAX_THIRD_PARTY_VOLUME_BPS` in
 * apps/backend/crates/app-data/src/app_data.rs (partner-fees Phase A, #926). A
 * recipient's OWN registered cap (default 50 bps) may be lower and is enforced
 * by the orderbook at ingress; this is the ceiling the compat surface can know
 * statically without a registry read.
 */
const MAX_THIRD_PARTY_VOLUME_BPS = 90;

/**
 * Minimum mappable Volume fee. The backend enforces a per-pair partner-fee floor
 * on EACH entry (`enforce_partner_fee_floor` / `partner_fee_floor_bps` in
 * apps/backend/crates/shared/src/order_validation.rs): a non-stable, non-boosted
 * pair floors at `OPHIS_NON_STABLE_FLOOR_BPS` = 4 bps, and only stable/boosted
 * pairs floor at the reduced 1 bps. The Ophis default 5-bps entry does not rescue
 * the separate integrator entry, which is floored on its own bps. The compat
 * surface has no on-chain token registry to establish stable/boosted eligibility,
 * so it enforces the conservative 4-bps floor: a mapped fee of 1-3 bps would
 * otherwise return a signable draft the orderbook rejects at submit.
 */
const MIN_MAPPABLE_VOLUME_BPS = 4;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const compatChecksum = (value: unknown, label: string): Address => {
  if (typeof value !== 'string') {
    throw new CompatError('INVALID_ADDRESS', `${label}: must be a 0x-prefixed address string.`);
  }
  try {
    return checksum(value, label);
  } catch (err) {
    throw new CompatError('INVALID_ADDRESS', (err as Error).message);
  }
};

/** Odos amount grammar: 1-64 digits. Zero is additionally rejected (a zero sell is unquotable). */
const assertCompatAtoms = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[0-9]{1,64}$/.test(value) || /^0+$/.test(value)) {
    throw new CompatError(
      'INVALID_AMOUNT',
      `${label}: must be a positive integer string of atoms (1-64 digits).`,
    );
  }
  return value;
};

/**
 * Tolerance for `outputTokens[0].proportion`. Odos proportions are IEEE-754
 * doubles that clients normalise to sum to 1, so a single-output request can
 * arrive as 1 +/- a few ULPs. 1e-9 is far above that noise floor and far below
 * any share a caller would mean on purpose.
 */
const PROPORTION_EPSILON = 1e-9;

const BASKET_ROADMAP_MESSAGE =
  'This surface is single token in, single token out for now. Multi-token requests return when ' +
  'Ophis basket intents ship (multi-asset orders are on the public roadmap); until then, decompose ' +
  'the request into single-pair calls.';

export function parseQuoteRequest(
  body: unknown,
  opts: { partnerFeeEnabled?: boolean } = {},
): CompatQuoteRequest {
  if (!isRecord(body)) {
    throw new CompatError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  const warnings: CompatWarning[] = [];

  if (typeof body.chainId !== 'number' || !Number.isInteger(body.chainId) || body.chainId <= 0) {
    throw new CompatError('INVALID_REQUEST', 'chainId: required positive integer.');
  }
  const chainId = body.chainId;

  // inputTokens / outputTokens: exactly one each for v1.
  const inputTokens = body.inputTokens;
  const outputTokens = body.outputTokens;
  if (!Array.isArray(inputTokens) || inputTokens.length < 1) {
    throw new CompatError('INVALID_REQUEST', 'inputTokens: required non-empty array.');
  }
  if (!Array.isArray(outputTokens) || outputTokens.length < 1) {
    throw new CompatError('INVALID_REQUEST', 'outputTokens: required non-empty array.');
  }
  if (inputTokens.length > 1 || outputTokens.length > 1) {
    throw new CompatError('MULTI_TOKEN_UNSUPPORTED', BASKET_ROADMAP_MESSAGE);
  }
  const input = inputTokens[0];
  const output = outputTokens[0];
  if (!isRecord(input) || !isRecord(output)) {
    throw new CompatError('INVALID_REQUEST', 'inputTokens/outputTokens entries must be objects.');
  }
  const sellToken = compatChecksum(input.tokenAddress, 'inputTokens[0].tokenAddress');
  const buyToken = compatChecksum(output.tokenAddress, 'outputTokens[0].tokenAddress');
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
    throw new CompatError('INVALID_REQUEST', 'inputTokens and outputTokens must differ.');
  }
  const sellAmount = assertCompatAtoms(input.amount, 'inputTokens[0].amount');
  if (output.proportion !== undefined) {
    // Odos clients build `proportion` so the output side sums to 1. With a
    // single output that is definitionally 1, but a client that normalises in
    // floating point can hand us 0.9999999999999999 or 1.0000000000000002.
    // Those are exactly-1 requests and must not be turned away.
    const proportion = output.proportion;
    if (typeof proportion !== 'number' || !Number.isFinite(proportion)) {
      throw new CompatError(
        'INVALID_REQUEST',
        'outputTokens[0].proportion: must be a finite number.',
      );
    }
    if (Math.abs(proportion - 1) > PROPORTION_EPSILON) {
      if (proportion > 0 && proportion < 1) {
        // A genuinely partial share is a split intent, which is basket
        // territory. This is the only case that keeps the roadmap error.
        throw new CompatError('MULTI_TOKEN_UNSUPPORTED', BASKET_ROADMAP_MESSAGE);
      }
      // Anything else (<= 0, or > 1 such as the percent convention `100`) is a
      // malformed request, not an unsupported feature. Saying "multi-token
      // unsupported" here sent integrators to the wrong fix.
      throw new CompatError(
        'INVALID_REQUEST',
        'outputTokens[0].proportion: must be 1 for a single output token ' +
          '(proportions are fractions of the output side, not percentages).',
      );
    }
  }

  // userAddr: optional. Absent = quote-only, not assemblable.
  const userAddr =
    body.userAddr === undefined || body.userAddr === null
      ? null
      : compatChecksum(body.userAddr, 'userAddr');
  if (userAddr === null) {
    warnings.push(
      warning(
        'NOT_ASSEMBLABLE_NO_USER',
        'No userAddr was sent, so no order draft or pathId is issued (assemblable: false). Re-quote with userAddr to get a signable draft.',
      ),
    );
  }

  // slippageLimitPercent -> bips. Above the 50% cap is a hard reject: silently
  // clamping would sign a different limit than the caller asked for.
  let slippageBips = 30; // the v3 default, 0.3%
  if (body.slippageLimitPercent !== undefined && body.slippageLimitPercent !== null) {
    const pct = body.slippageLimitPercent;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) {
      throw new CompatError('INVALID_SLIPPAGE', 'slippageLimitPercent: must be a number > 0.');
    }
    slippageBips = Math.round(pct * 100);
    if (slippageBips > MAX_SLIPPAGE_BIPS) {
      throw new CompatError(
        'INVALID_SLIPPAGE',
        `slippageLimitPercent: exceeds the ${MAX_SLIPPAGE_BIPS / 100}% cap (${MAX_SLIPPAGE_BIPS} bips).`,
      );
    }
  }

  // referralFee -> a CIP-75 Volume partner-fee entry (partner-fees Phase A, #926).
  // The decimal fraction maps to volume bps (0.001 = 10 bps). The cap is enforced
  // loudly (reject, never a silent clamp-down that would strand a partner's
  // expected revenue). While the program is disabled on this deployment the fee
  // is rejected rather than mapped into a draft that the orderbook refuses at
  // ingress.
  const referralFee = body.referralFee;
  let partnerFee: OphisVolumePartnerFee | null = null;
  if (referralFee !== undefined && referralFee !== null) {
    if (typeof referralFee !== 'number' || !Number.isFinite(referralFee) || referralFee < 0) {
      throw new CompatError('INVALID_REQUEST', 'referralFee: must be a non-negative number.');
    }
    if (referralFee > 0) {
      if (!opts.partnerFeeEnabled) {
        throw new CompatError(
          'PARTNER_FEE_UNAVAILABLE',
          'referralFee: integrator-priced partner fees are not enabled on this deployment yet. ' +
            'When the partner-fee program is live, a non-zero referralFee maps to a CIP-75 Volume ' +
            'fee to referralFeeRecipient; until then it is rejected rather than silently dropped, so no ' +
            'expected revenue is lost. referralCode-only attribution works today.',
        );
      }
      const recipient = compatChecksum(body.referralFeeRecipient, 'referralFeeRecipient');
      if (isZeroAddress(recipient)) {
        throw new CompatError(
          'INVALID_REQUEST',
          'referralFeeRecipient: required non-zero address when referralFee > 0 (the fee needs a payee).',
        );
      }
      // Odos referralFee is a decimal fraction of volume; 0.001 = 0.1% = 10 bps.
      // CIP-75 Volume fees are bps-granular, so round to the nearest bps.
      const volumeBps = Math.round(referralFee * 10_000);
      if (volumeBps < MIN_MAPPABLE_VOLUME_BPS) {
        throw new CompatError(
          'INVALID_REQUEST',
          `referralFee ${referralFee} maps to ${volumeBps} bps, below the ${MIN_MAPPABLE_VOLUME_BPS} bps ` +
            `partner-fee floor the orderbook enforces per entry for a non-stable pair. Raise it to at least ` +
            `${MIN_MAPPABLE_VOLUME_BPS} bps (${MIN_MAPPABLE_VOLUME_BPS / 10_000}) or drop it. The reduced 1 bps ` +
            `floor applies only to stable or boosted pairs, which this surface cannot establish without an ` +
            `on-chain token registry.`,
        );
      }
      if (volumeBps > MAX_THIRD_PARTY_VOLUME_BPS) {
        throw new CompatError(
          'PARTNER_FEE_CAP_EXCEEDED',
          `referralFee ${referralFee} maps to ${volumeBps} bps, above the program's ` +
            `${MAX_THIRD_PARTY_VOLUME_BPS} bps third-party cap. Lower it. (A silent clamp-down is refused: ` +
            `it would charge less than you asked and strand your expected revenue.)`,
        );
      }
      partnerFee = { volumeBps, recipient };
      warnings.push(
        warning(
          'PARTNER_FEE_MAPPED',
          `referralFee ${referralFee} maps to a ${volumeBps} bps CIP-75 Volume fee to ${recipient}. ` +
            `The recipient must be a registered, active partner-fee recipient (POST /api/v1/partners); ` +
            `its own registered cap (default 50 bps) is enforced by the orderbook at submit.`,
        ),
      );
    }
  }
  if (
    (referralFee === undefined || referralFee === null || referralFee === 0) &&
    body.referralFeeRecipient !== undefined &&
    body.referralFeeRecipient !== null
  ) {
    warnings.push(
      warning(
        'REFERRAL_FEE_RECIPIENT_IGNORED',
        'referralFeeRecipient without a non-zero referralFee has no effect and was ignored.',
      ),
    );
  }

  // referralCode: integer -> `odos<code>` in appData (rebate-indexer grammar).
  let referrerCode: string | null = null;
  if (body.referralCode !== undefined && body.referralCode !== null && body.referralCode !== 0) {
    const code = body.referralCode;
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 0) {
      throw new CompatError('INVALID_REQUEST', 'referralCode: must be a non-negative integer.');
    }
    try {
      referrerCode = normalizeOphisReferralCode(`odos${code}`);
    } catch (err) {
      throw new CompatError('INVALID_REQUEST', `referralCode: ${(err as Error).message}`);
    }
  }

  const priceQuality: 'fast' | 'optimal' = body.simple === true ? 'fast' : 'optimal';

  // Ignored knobs: named warnings where the caller plausibly relied on the
  // behavior, silent no-ops where the outcome is indistinguishable.
  if (body.gasPrice !== undefined && body.gasPrice !== null) {
    warnings.push(
      warning(
        'GAS_PRICE_IGNORED',
        'gasPrice was ignored: you submit no transaction on Ophis; the winning solver pays settlement gas.',
      ),
    );
  }
  const hasFilters = (['sourceBlacklist', 'sourceWhitelist', 'poolBlacklist'] as const).some(
    (k) => Array.isArray(body[k]) && (body[k] as unknown[]).length > 0,
  );
  if (hasFilters) {
    warnings.push(
      warning(
        'SOURCE_FILTERS_IGNORED',
        'sourceBlacklist/sourceWhitelist/poolBlacklist were ignored: routing is decided by competing solvers, not a configurable source list.',
      ),
    );
  }
  if (body.likeAsset === true) {
    warnings.push(warning('LIKE_ASSET_IGNORED', 'likeAsset was ignored on this surface.'));
  }
  // pathViz/pathVizImage/pathVizImageConfig: requested from the orderbook's
  // pathviz endpoint when the feature is enabled. No parse-time warning; the
  // quote path warns-and-degrades to null only if the feature is off/degraded.
  const pathViz = body.pathViz === true;
  const pathVizImage = body.pathVizImage === true;
  const pathVizImageConfig = isRecord(body.pathVizImageConfig) ? body.pathVizImageConfig : null;
  const isStablePair = body.isStablePair === true;
  if (body.permit2 === true) {
    warnings.push(
      warning(
        'PERMIT2_UNAVAILABLE',
        'permit2 flow is reserved and currently null (permit2Message/permit2Hash); approve the vault relayer instead.',
      ),
    );
  }
  // disableRFQs and compact: silent no-ops (no RFQ lane exists; one response shape).

  return {
    chainId,
    sellToken,
    buyToken,
    isStablePair,
    sellAmount,
    userAddr,
    slippageBips,
    referrerCode,
    partnerFee,
    priceQuality,
    pathViz,
    pathVizImage,
    pathVizImageConfig,
    warnings,
  };
}

export function parseAssembleRequest(body: unknown): CompatAssembleRequest {
  if (!isRecord(body)) {
    throw new CompatError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  const userAddr = compatChecksum(body.userAddr, 'userAddr');
  if (typeof body.pathId !== 'string' || body.pathId.length === 0) {
    throw new CompatError('INVALID_REQUEST', 'pathId: required string from /sor/quote/v3.');
  }
  const receiver =
    body.receiver === undefined || body.receiver === null
      ? null
      : compatChecksum(body.receiver, 'receiver');
  return {
    userAddr,
    pathId: body.pathId,
    simulate: body.simulate === true,
    receiver,
  };
}

const MAX_FULL_APP_DATA_BYTES = 8192;

export function parseSubmitRequest(body: unknown): CompatSubmitRequest {
  if (!isRecord(body)) {
    throw new CompatError('INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  if (typeof body.chainId !== 'number' || !Number.isInteger(body.chainId) || body.chainId <= 0) {
    throw new CompatError('INVALID_REQUEST', 'chainId: required positive integer.');
  }
  if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
    throw new CompatError('INVALID_REQUEST', 'signature: must be 0x-prefixed hex.');
  }
  const signingScheme = body.signingScheme ?? 'eip712';
  if (signingScheme !== 'eip712' && signingScheme !== 'ethsign') {
    throw new CompatError('INVALID_REQUEST', "signingScheme: must be 'eip712' or 'ethsign'.");
  }
  const from = compatChecksum(body.from, 'from');
  const o = body.order;
  if (!isRecord(o)) {
    throw new CompatError(
      'INVALID_REQUEST',
      'order: required object (the ophis.order draft, signed).',
    );
  }
  const sellToken = compatChecksum(o.sellToken, 'order.sellToken');
  const buyToken = compatChecksum(o.buyToken, 'order.buyToken');
  const receiver = compatChecksum(o.receiver, 'order.receiver');
  const sellAmount = assertCompatAtoms(o.sellAmount, 'order.sellAmount');
  const buyAmount = assertCompatAtoms(o.buyAmount, 'order.buyAmount');
  const feeAmount = o.feeAmount;
  if (typeof feeAmount !== 'string' || !/^[0-9]{1,64}$/.test(feeAmount)) {
    throw new CompatError(
      'INVALID_AMOUNT',
      'order.feeAmount: must be a non-negative integer string of atoms.',
    );
  }
  if (
    typeof o.validTo !== 'number' ||
    !Number.isInteger(o.validTo) ||
    o.validTo <= 0 ||
    o.validTo > 0xffffffff
  ) {
    throw new CompatError('INVALID_REQUEST', 'order.validTo: must be a uint32 unix timestamp.');
  }
  if (typeof o.appData !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.appData)) {
    throw new CompatError('INVALID_REQUEST', 'order.appData: must be the 0x bytes32 appData hash.');
  }
  if (o.kind !== 'sell' && o.kind !== 'buy') {
    throw new CompatError('INVALID_REQUEST', "order.kind: must be 'sell' or 'buy'.");
  }
  if (typeof o.partiallyFillable !== 'boolean') {
    throw new CompatError('INVALID_REQUEST', 'order.partiallyFillable: must be a boolean.');
  }
  if (o.sellTokenBalance !== 'erc20' || o.buyTokenBalance !== 'erc20') {
    throw new CompatError(
      'INVALID_REQUEST',
      "order.sellTokenBalance/buyTokenBalance: must be 'erc20'.",
    );
  }
  if (typeof body.fullAppData !== 'string' || body.fullAppData.length > MAX_FULL_APP_DATA_BYTES) {
    throw new CompatError(
      'INVALID_REQUEST',
      `fullAppData: required string of at most ${MAX_FULL_APP_DATA_BYTES} bytes.`,
    );
  }
  let quoteId: number | null = null;
  if (body.quoteId !== undefined && body.quoteId !== null) {
    if (typeof body.quoteId !== 'number' || !Number.isInteger(body.quoteId)) {
      throw new CompatError('INVALID_REQUEST', 'quoteId: must be an integer when present.');
    }
    quoteId = body.quoteId;
  }
  return {
    chainId: body.chainId,
    order: {
      sellToken,
      buyToken,
      receiver,
      sellAmount,
      buyAmount,
      validTo: o.validTo,
      appData: o.appData as Address,
      feeAmount,
      kind: o.kind,
      partiallyFillable: o.partiallyFillable,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
    signature: body.signature,
    signingScheme,
    from,
    fullAppData: body.fullAppData,
    quoteId,
    acceptNonOwnerReceiver: body.acceptNonOwnerReceiver === true,
  };
}
