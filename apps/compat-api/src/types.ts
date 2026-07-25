/**
 * Wire types and the error/warning catalog for the Ophis sync-quote compat
 * surface.
 *
 * The request side accepts the Odos v3 field names (PathRequestV3 /
 * AssemblePathRequest / SwapRequestV3 per the archived OpenAPI document, used
 * as an interface reference only; nothing is vendored). The response side
 * reproduces the QuoteResponse field surface plus a namespaced `ophis` block
 * that carries what a batch-auction settlement actually produces: an unsigned
 * order draft, the EIP-712 signing envelope, and explicit async-settlement
 * semantics. Where the original semantics cannot be honored, the response says
 * so with structural nulls and named warnings; nothing is fabricated.
 */
import type { Address, BuiltOrder } from '@ophis/sdk';

// --- environment -----------------------------------------------------------

/** Cloudflare Workers rate-limit binding (unsafe.bindings type "ratelimit"). */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  COMPAT_RATE_LIMIT?: RateLimit;
  /**
   * HMAC-SHA256 key for stateless pathId tokens (wrangler secret). Required to
   * mint assemblable quotes; quote-only calls (no userAddr) work without it.
   */
  COMPAT_PATHID_KEY?: string;
  /** Previous pathId key, honored for verification only (two-key rotation window). */
  COMPAT_PATHID_KEY_PREVIOUS?: string;
  /** Comma-separated chainIds served by this deployment. Default "10,130". */
  COMPAT_ENABLED_CHAINS?: string;
}

/** Chains enabled by default: the Ophis-operated orderbooks (never CoW-hosted). */
export const DEFAULT_ENABLED_CHAINS: readonly number[] = Object.freeze([10, 130]);

export function enabledChains(env: Env): number[] {
  const raw = env.COMPAT_ENABLED_CHAINS;
  if (!raw) return [...DEFAULT_ENABLED_CHAINS];
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : [...DEFAULT_ENABLED_CHAINS];
}

// --- errors ----------------------------------------------------------------

/**
 * String error codes are the compat surface's primary discriminator; the
 * numeric codes adopt the api-dx v1 bands (1xxx api, 2xxx quoting, 3xxx
 * upstream/retryable, 4xxx validation, 5xxx internal) so an integrator that
 * already branches on bands gets consistent classes. Compat-specific numbers
 * sit at 49xx / 59xx, outside the backend's frozen 4001-4018 and 5000-5001
 * assignments, so they can never collide with an orderbook-issued code.
 */
export const COMPAT_ERRORS = {
  INVALID_REQUEST: { httpStatus: 400, numericCode: 4900 },
  MULTI_TOKEN_UNSUPPORTED: { httpStatus: 400, numericCode: 4901 },
  PARTNER_FEE_UNAVAILABLE: { httpStatus: 400, numericCode: 4902 },
  UNSUPPORTED_CHAIN: { httpStatus: 400, numericCode: 4903 },
  INVALID_SLIPPAGE: { httpStatus: 400, numericCode: 4904 },
  INVALID_ADDRESS: { httpStatus: 400, numericCode: 4905 },
  INVALID_AMOUNT: { httpStatus: 400, numericCode: 4906 },
  PATH_ID_INVALID: { httpStatus: 400, numericCode: 4907 },
  PATH_ID_EXPIRED: { httpStatus: 410, numericCode: 4908 },
  USER_MISMATCH: { httpStatus: 400, numericCode: 4909 },
  RECEIVER_NOT_ACKNOWLEDGED: { httpStatus: 400, numericCode: 4910 },
  NOT_ASSEMBLABLE: { httpStatus: 400, numericCode: 4911 },
  APP_DATA_MISMATCH: { httpStatus: 400, numericCode: 4912 },
  UPSTREAM_VALIDATION: { httpStatus: 400, numericCode: 4913 },
  BODY_TOO_LARGE: { httpStatus: 413, numericCode: 4914 },
  NO_ROUTE: { httpStatus: 404, numericCode: 2000 },
  NOT_FOUND: { httpStatus: 404, numericCode: 1001 },
  RATE_LIMITED: { httpStatus: 429, numericCode: 1029 },
  UPSTREAM_UNAVAILABLE: { httpStatus: 503, numericCode: 3000 },
  UPSTREAM_RATE_LIMITED: { httpStatus: 503, numericCode: 3100 },
  INTERNAL_ERROR: { httpStatus: 500, numericCode: 5900 },
  CONFIG_MISSING: { httpStatus: 500, numericCode: 5901 },
} as const;

export type CompatErrorCode = keyof typeof COMPAT_ERRORS;

export const COMPAT_DOCS_URL = 'https://docs.ophis.fi/migrating-from-odos';

/** Typed error carried through handlers and rendered as the wire envelope. */
export class CompatError extends Error {
  readonly code: CompatErrorCode;
  readonly httpStatus: number;
  readonly numericCode: number;
  /** Optional passthrough details from an upstream orderbook error. */
  readonly upstream?: { errorType?: string; traceId?: string; description?: string };
  readonly retryAfterSeconds?: number;

  constructor(
    code: CompatErrorCode,
    message: string,
    extra?: { upstream?: CompatError['upstream']; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'CompatError';
    this.code = code;
    this.httpStatus = COMPAT_ERRORS[code].httpStatus;
    this.numericCode = COMPAT_ERRORS[code].numericCode;
    this.upstream = extra?.upstream;
    this.retryAfterSeconds = extra?.retryAfterSeconds;
  }
}

/** The compat error envelope: `{ traceId, error: { code, httpStatus, message, docs } }`. */
export interface CompatErrorEnvelope {
  traceId: string;
  error: {
    code: CompatErrorCode;
    /** api-dx v1 band number (additive beside the string code). */
    numericCode: number;
    httpStatus: number;
    message: string;
    docs: string;
    upstream?: { errorType?: string; traceId?: string; description?: string };
  };
}

// --- warnings --------------------------------------------------------------

export type CompatWarningCode =
  | 'GASLESS_SETTLEMENT'
  | 'GAS_PRICE_IGNORED'
  | 'SOURCE_FILTERS_IGNORED'
  | 'LIKE_ASSET_IGNORED'
  | 'REFERRAL_FEE_RECIPIENT_IGNORED'
  | 'PATH_VIZ_UNAVAILABLE'
  | 'PERMIT2_UNAVAILABLE'
  | 'SIMULATION_UNAVAILABLE'
  | 'NOT_ASSEMBLABLE_NO_USER'
  | 'NON_OWNER_RECEIVER'
  | 'VALUES_UNAVAILABLE'
  | 'BLOCK_NUMBER_UNAVAILABLE';

export interface CompatWarning {
  code: CompatWarningCode;
  message: string;
}

export const warning = (code: CompatWarningCode, message: string): CompatWarning => ({
  code,
  message,
});

// --- internal request shapes (after mapping) -------------------------------

export interface CompatQuoteRequest {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  /** Sell amount in atoms (exact-in; the v3 shape is exact-in only). */
  sellAmount: string;
  /** Checksummed trading account, or null (quote-only, not assemblable). */
  userAddr: Address | null;
  /** Signed slippage bound in bips (slippageLimitPercent * 100, capped 5000). */
  slippageBips: number;
  /** Ophis referral code mapped from the integer referralCode (`odos<code>`), or null. */
  referrerCode: string | null;
  priceQuality: 'fast' | 'optimal';
  warnings: CompatWarning[];
}

export interface CompatAssembleRequest {
  userAddr: Address;
  pathId: string;
  simulate: boolean;
  /** Receiver override (checksummed), or null to pin proceeds to the owner. */
  receiver: Address | null;
}

export interface CompatSubmitRequest {
  chainId: number;
  order: BuiltOrder['order'];
  signature: string;
  signingScheme: 'eip712' | 'ethsign';
  from: Address;
  fullAppData: string;
  quoteId: number | null;
  acceptNonOwnerReceiver: boolean;
}

// --- pathId payload --------------------------------------------------------

/** Everything /sor/assemble needs to rebuild the draft without server state. */
export interface PathIdPayload {
  v: 1;
  /** chainId */
  cid: number;
  /** checksummed user address, or null when the quote was anonymous */
  usr: Address | null;
  st: Address;
  bt: Address;
  /** signed sellAmount atoms (quoted sellAmount + feeAmount) */
  ssa: string;
  /** signed buyAmount atoms (quoted buyAmount minus the slippage bound) */
  sba: string;
  /** quoted (fair) buyAmount atoms, for reference/valuation */
  qba: string;
  /** quoted feeAmount atoms */
  fee: string;
  /** slippage bound in bips */
  slp: number;
  /** normalized Ophis referral code, or null */
  ref: string | null;
  /** orderbook quote id, or null */
  qid: number | null;
  /** unix seconds: mint time and expiry (min(iat+60, quote expiration)) */
  iat: number;
  exp: number;
}

// --- response shapes -------------------------------------------------------

/** The `ophis` block attached to every successful compat response. */
export interface OphisBlock {
  /** Ophis settles via competitive batch auctions; settlement is asynchronous. */
  settlementModel: 'batch-auction-async';
  /** Owner decision 7: values are native-denominated until a USD feed is chosen. */
  valueCurrency: 'native';
  assemblable: boolean;
  quoteId: number | null;
  /** Orderbook quote expiration (ISO 8601), or null. */
  expiration: string | null;
  orderbookUrl: string;
  /**
   * Execution cost embedded in the quoted amounts (the user pays no gas on
   * top; the winning solver pays gas and the cost is priced into the quote).
   */
  executionCost: { gasAmount: string; gasPriceWei: string; feeAmount: string } | null;
  /** Unsigned CoW order draft (sign as EIP-712 with `signing`), or null when not assemblable. */
  order: BuiltOrder['order'] | null;
  signing: BuiltOrder['signing'] | null;
  fullAppData: string | null;
  appDataHash: string | null;
  submit: { url: '/sor/submit'; method: 'POST'; note: string };
  receiverIsNotOwner?: boolean;
  warnings: CompatWarning[];
}

/** Field-for-field the Odos v3 QuoteResponse surface, plus the `ophis` block. */
export interface CompatQuoteResponse {
  deprecated: null;
  traceId: string;
  inTokens: string[];
  outTokens: string[];
  inAmounts: string[];
  outAmounts: string[];
  /** 0: the user submits no transaction, so user-paid gas is zero (see ophis.executionCost). */
  gasEstimate: number;
  dataGasEstimate: number;
  gweiPerGas: number;
  gasEstimateValue: number;
  inValues: number[];
  outValues: number[];
  netOutValue: number;
  priceImpact: null;
  percentDiff: number;
  permit2Message: null;
  permit2Hash: null;
  partnerFeePercent: number;
  pathId: string | null;
  pathViz: null;
  pathVizImage: null;
  blockNumber: number;
  ophis: OphisBlock;
}

/** The assemble/swap "assembly" surface: PathResponse field names, transaction always null. */
export interface CompatAssembleResponse {
  deprecated: null;
  traceId: string;
  blockNumber: number;
  gasEstimate: number;
  gasEstimateValue: number;
  inputTokens: { tokenAddress: string; amount: string }[];
  outputTokens: { tokenAddress: string; amount: string }[];
  netOutValue: number;
  outValues: number[];
  /** Never fabricated: Ophis has no user-submitted swap transaction. Sign ophis.order instead. */
  transaction: null;
  simulation: null;
  ophis: OphisBlock;
}

export const SUBMIT_NOTE =
  'Sign ophis.order as EIP-712 typed data with ophis.signing, then POST ' +
  '{ chainId, order, signature, signingScheme: "eip712", from, fullAppData, quoteId } to /sor/submit. ' +
  'Settlement is asynchronous: poll /sor/order-status/{chainId}/{orderUid}.';
