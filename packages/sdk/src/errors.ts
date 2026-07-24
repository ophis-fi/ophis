/**
 * Typed errors for the Ophis orderbook API (api-dx v1 numeric code bands).
 *
 * The self-hosted orderbook attaches a numeric `code` (1xxx-5xxx band table,
 * frozen v1), a UUID `traceId` (body field on errors, `X-Trace-Id` header on
 * every response) and optional `data` to its error envelope
 * `{ errorType, description, code?, traceId?, data? }`. CoW-hosted chains
 * never send codes or traceIds, so everything here degrades gracefully: an
 * unknown or absent code preserves the raw payload and falls back to the
 * `errorType` string.
 *
 * Two doctrines are encoded here on purpose:
 * - "Unroutable is an answer, not a failure": NO_ROUTE / UNSUPPORTED_TOKEN /
 *   INSUFFICIENT_LIQUIDITY (HTTP 404, `data.class: "unroutable"`) get their
 *   own class, OphisUnroutableError, and are never retryable. Retrying a
 *   route that does not exist only burns the rate budget.
 * - "429 is never retryable in-call": a RATE_LIMITED response means the
 *   caller must slow down globally, not spin on the same request. Only the
 *   3xxx upstream band (503 + Retry-After) is in-call retryable.
 *
 * Band structure and the retry doctrine follow the error-code design of the
 * archived aggregator Rust SDK (Apache-2.0); the code is an independent
 * TypeScript expression and the code numbers are Ophis-specific.
 *
 * Dependency-free: no viem, no fetch types. Anything with a `get(name)`
 * method (e.g. the WHATWG `Headers` class) or a plain header record works.
 */

/** Spec-named codes of the frozen v1 table. Other codes in a band exist (for example 4001-4018 validation); classify those via ophisErrorBand. */
export const OPHIS_ERROR_CODES = {
  /** 1000: generic API error. */
  API_ERROR: 1000,
  /** 1001: resource not found (not the unroutable 404, which carries a 2xxx code). */
  NOT_FOUND: 1001,
  /** 1029: rate limited (HTTP 429). Never retryable in-call. */
  RATE_LIMITED: 1029,
  /** 2000: no route exists for the pair. An answer, not a failure. */
  NO_ROUTE: 2000,
  /** 2001: token not supported by routing. Unroutable set. */
  UNSUPPORTED_TOKEN: 2001,
  /** 2002: liquidity too thin to route the amount. Unroutable set. */
  INSUFFICIENT_LIQUIDITY: 2002,
  /** 3000: internal service error surfaced as 503 + Retry-After. Retryable. */
  INTERNAL_SERVICE_ERROR: 3000,
  /** 3100: upstream estimator rate limited, surfaced as 503 + Retry-After. Retryable. */
  UPSTREAM_RATE_LIMITED: 3100,
  /** 4400: account is deny-listed. */
  ACCOUNT_DENY_LISTED: 4400,
} as const;

/** The codes whose meaning is "no route exists": a final answer, never retried. */
export const OPHIS_UNROUTABLE_CODES: readonly number[] = Object.freeze([
  OPHIS_ERROR_CODES.NO_ROUTE,
  OPHIS_ERROR_CODES.UNSUPPORTED_TOKEN,
  OPHIS_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
]);

/**
 * CoW-hosted chains send only `errorType` strings. These are the strings whose
 * meaning matches the unroutable set, used as the no-code fallback signal.
 */
const UNROUTABLE_ERROR_TYPES: ReadonlySet<string> = new Set(['NoLiquidity', 'UnsupportedToken']);

/** The five frozen v1 bands, plus 'unknown' for anything outside 1000-5999. */
export type OphisErrorBand = 'api' | 'quoting' | 'upstream' | 'validation' | 'internal' | 'unknown';

/** Maps a numeric code to its band: 1xxx api, 2xxx quoting, 3xxx upstream (retryable), 4xxx validation, 5xxx internal. */
export function ophisErrorBand(code: number): OphisErrorBand {
  if (!Number.isInteger(code)) return 'unknown';
  if (code >= 1000 && code < 2000) return 'api';
  if (code >= 2000 && code < 3000) return 'quoting';
  if (code >= 3000 && code < 4000) return 'upstream';
  if (code >= 4000 && code < 5000) return 'validation';
  if (code >= 5000 && code < 6000) return 'internal';
  return 'unknown';
}

/** Anything that can hand out response headers: WHATWG Headers, or a plain (case-insensitive) record. */
export type OphisHeadersLike =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

const readHeader = (headers: OphisHeadersLike | undefined, name: string): string | undefined => {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  }
  return undefined;
};

/**
 * Reads the `X-Trace-Id` correlation id from response headers. The orderbook
 * sets it on every response; on successes it is header-only (no body field),
 * so this is the one place to pick it up for logging alongside a result.
 */
export const getOphisTraceId = (headers: OphisHeadersLike | undefined): string | undefined =>
  readHeader(headers, 'X-Trace-Id');

/** What parseOphisApiError needs: the status, the parsed body (or raw text), and optionally the headers. */
export interface OphisErrorResponse {
  /** HTTP status code of the failed response. */
  status: number;
  /** The response body, JSON-parsed if possible; a raw string or undefined is fine. */
  body?: unknown;
  /** Response headers, for `X-Trace-Id` and `Retry-After`. */
  headers?: OphisHeadersLike;
}

interface ParsedErrorBody {
  errorType?: string;
  description?: string;
  code?: number;
  traceId?: string;
  data?: unknown;
}

const parseBody = (body: unknown): ParsedErrorBody => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const out: ParsedErrorBody = {};
  if (typeof record.errorType === 'string') out.errorType = record.errorType;
  if (typeof record.description === 'string') out.description = record.description;
  // An unknown or malformed code is dropped here but the raw payload is kept
  // on the error, so a future band the SDK does not know yet is never lost.
  if (typeof record.code === 'number' && Number.isInteger(record.code)) out.code = record.code;
  if (typeof record.traceId === 'string' && record.traceId.length > 0) out.traceId = record.traceId;
  if ('data' in record) out.data = record.data;
  return out;
};

const parseRetryAfterSeconds = (headers: OphisHeadersLike | undefined): number | undefined => {
  const raw = readHeader(headers, 'Retry-After');
  if (raw === undefined) return undefined;
  // Delta-seconds form only (what the orderbook sends). An HTTP-date or
  // garbage value is ignored rather than misread as a huge delay.
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

/** Constructor payload shared by the three error classes. */
export interface OphisApiErrorOptions {
  status: number;
  message?: string;
  errorType?: string;
  code?: number;
  traceId?: string;
  data?: unknown;
  retryAfterSeconds?: number;
  /** The raw response body, preserved verbatim for unknown shapes and codes. */
  payload?: unknown;
}

/**
 * An error response from the Ophis orderbook API. Carries the numeric `code`
 * and `traceId` when the self-hosted orderbook sent them, the `errorType`
 * string always (CoW-hosted chains send only that), and the raw `payload` so
 * nothing is lost when the SDK predates a new code.
 */
export class OphisApiError extends Error {
  override readonly name: string = 'OphisApiError';
  /** HTTP status of the response. */
  readonly status: number;
  /** CoW-style `errorType` string, when the body carried one. */
  readonly errorType?: string;
  /** Numeric v1 band code, when the self-hosted orderbook sent one. */
  readonly code?: number;
  /** Band of `code`, or 'unknown' when there is no code. */
  readonly band: OphisErrorBand;
  /** Correlation id for support, from the body or the `X-Trace-Id` header. Quote it when reporting a problem. */
  readonly traceId?: string;
  /** The envelope's `data` field (e.g. `{ class: "unroutable" }`). */
  readonly data?: unknown;
  /** Parsed `Retry-After` header in seconds, when the response carried one. */
  readonly retryAfterSeconds?: number;
  /** The raw response body, preserved verbatim. */
  readonly payload?: unknown;

  constructor(options: OphisApiErrorOptions) {
    const label = options.errorType ?? (options.code !== undefined ? `code ${options.code}` : `HTTP ${options.status}`);
    super(options.message ?? `Ophis API error (${label})`);
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.band = options.code === undefined ? 'unknown' : ophisErrorBand(options.code);
    this.traceId = options.traceId;
    this.data = options.data;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.payload = options.payload;
  }
}

/**
 * "No route exists" as a typed answer: the orderbook examined the request and
 * the answer is that this pair/amount cannot be routed right now (codes
 * 2000-2002, HTTP 404, `data.class: "unroutable"`). Distinct from a failure:
 * nothing went wrong, so it is never retryable in-call. Present it to the
 * user as a result ("no route for this pair"), not as an error screen.
 */
export class OphisUnroutableError extends OphisApiError {
  override readonly name = 'OphisUnroutableError';
}

/**
 * HTTP 429 / code 1029. Never retryable in-call: the correct reaction is to
 * slow the caller down globally (their rate budget is spent), not to re-issue
 * this request after `retryAfterSeconds`. withOphisRetry refuses to retry it.
 */
export class OphisRateLimitError extends OphisApiError {
  override readonly name = 'OphisRateLimitError';
}

const isUnroutableShape = (parsed: ParsedErrorBody): boolean => {
  if (parsed.code !== undefined) return OPHIS_UNROUTABLE_CODES.includes(parsed.code);
  if (typeof parsed.data === 'object' && parsed.data !== null) {
    const cls = (parsed.data as Record<string, unknown>).class;
    if (cls === 'unroutable') return true;
  }
  // Codeless CoW-hosted fallback: classify by errorType string.
  return parsed.errorType !== undefined && UNROUTABLE_ERROR_TYPES.has(parsed.errorType);
};

/**
 * Turns a failed orderbook response into the right typed error. Give it the
 * status, the JSON-parsed body (or the raw text when parsing failed) and,
 * when available, the headers:
 *
 *   const res = await fetch(url);
 *   if (!res.ok) throw parseOphisApiError({ status: res.status, body: await res.json().catch(() => undefined), headers: res.headers });
 *
 * Degrades gracefully: a body without a numeric code (CoW-hosted chains, or
 * a backend older than the code table) still produces a classified error via
 * status + errorType, and the raw body is always preserved on `.payload`.
 */
export function parseOphisApiError(response: OphisErrorResponse): OphisApiError {
  const parsed = parseBody(response.body);
  const options: OphisApiErrorOptions = {
    status: response.status,
    message: parsed.description,
    errorType: parsed.errorType,
    code: parsed.code,
    traceId: parsed.traceId ?? getOphisTraceId(response.headers),
    data: parsed.data,
    retryAfterSeconds: parseRetryAfterSeconds(response.headers),
    payload: response.body,
  };
  if (parsed.description === undefined && typeof response.body === 'string' && response.body.length > 0) {
    options.message = response.body;
  }
  if (response.status === 429 || parsed.code === OPHIS_ERROR_CODES.RATE_LIMITED) {
    return new OphisRateLimitError(options);
  }
  if (isUnroutableShape(parsed)) {
    return new OphisUnroutableError(options);
  }
  return new OphisApiError(options);
}

/**
 * True when the error means "no route exists" (the answer class), whether it
 * arrived with a 2000-2002 code, a `data.class: "unroutable"` marker, or a
 * codeless CoW-hosted `NoLiquidity`/`UnsupportedToken` errorType.
 */
export const isUnroutable = (error: unknown): boolean => error instanceof OphisUnroutableError;

/** Statuses treated as transient when the body carried no code (codeless hosts). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/**
 * True when retrying the same call can help. Only the 3xxx upstream band
 * (503 + Retry-After) qualifies; with no code, a 500/502/503/504 status does.
 * 429 is NEVER retryable in-call (slow down globally instead), and unroutable
 * is an answer, so retrying it cannot change anything.
 */
export const isRetryable = (error: unknown): boolean => {
  if (error instanceof OphisRateLimitError) return false;
  if (error instanceof OphisUnroutableError) return false;
  if (!(error instanceof OphisApiError)) return false;
  if (error.code !== undefined) return error.band === 'upstream';
  return RETRYABLE_STATUSES.has(error.status);
};

/** Tuning knobs for withOphisRetry. The defaults suit interactive quoting. */
export interface OphisRetryOptions {
  /** Retries after the first attempt (default 2, so at most 3 attempts). */
  retries?: number;
  /** Base backoff before jitter, in ms (default 250). */
  minDelayMs?: number;
  /** Backoff ceiling in ms (default 4000). A server Retry-After may exceed it, up to 30s. */
  maxDelayMs?: number;
  /** Abort waiting between attempts (the in-flight attempt itself is the caller's to wire). */
  signal?: AbortSignal;
  /** Retry predicate, default isRetryable. A custom one still cannot make withOphisRetry loop forever. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Injectable waiter for tests, default a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source for tests, default Math.random. */
  random?: () => number;
}

/** Server-provided Retry-After values are honored only up to this ceiling. */
const RETRY_AFTER_CAP_MS = 30_000;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const abortError = (signal?: AbortSignal): Error => {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error('Ophis: retry aborted.');
};

/**
 * Runs `fn` and retries it on transient errors with full-jitter exponential
 * backoff. The retry policy is isRetryable by default, so 429 and unroutable
 * answers are surfaced immediately, never spun on. When the failed attempt
 * carried a Retry-After (the 503 upstream band sends one), the wait is at
 * least that long, capped at 30s.
 *
 *   const quote = await withOphisRetry(() => fetchQuote(params));
 */
export async function withOphisRetry<T>(fn: (attempt: number) => Promise<T>, options: OphisRetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError(`Ophis: retries must be a non-negative integer, received ${String(options.retries)}.`);
  }
  const minDelayMs = options.minDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const shouldRetry = options.shouldRetry ?? isRetryable;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, options.signal));

  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error, attempt)) throw error;
      // Full jitter over an exponential base, floored at half the base so
      // consecutive retries cannot collapse to a zero-delay stampede.
      const base = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      let delayMs = base / 2 + random() * (base / 2);
      const retryAfterSeconds = error instanceof OphisApiError ? error.retryAfterSeconds : undefined;
      if (retryAfterSeconds !== undefined) {
        delayMs = Math.max(delayMs, Math.min(retryAfterSeconds * 1000, RETRY_AFTER_CAP_MS));
      }
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
