import { describe, expect, it, vi } from 'vitest';
import {
  OPHIS_ERROR_CODES,
  OPHIS_UNROUTABLE_CODES,
  ophisErrorBand,
  getOphisTraceId,
  OphisApiError,
  OphisUnroutableError,
  OphisRateLimitError,
  parseOphisApiError,
  isUnroutable,
  isRetryable,
  withOphisRetry,
} from '../src/errors.js';

const TRACE = '0b5b1f4e-6f0a-4c37-9f6e-6f4f0e2a9d11';

describe('OPHIS_ERROR_CODES (frozen v1 table)', () => {
  it('pins the spec-named codes exactly', () => {
    // Frozen by owner decision 9: renaming or renumbering any of these is a
    // breaking API change the moment an integrator ships against them.
    expect(OPHIS_ERROR_CODES).toEqual({
      API_ERROR: 1000,
      NOT_FOUND: 1001,
      RATE_LIMITED: 1029,
      NO_ROUTE: 2000,
      UNSUPPORTED_TOKEN: 2001,
      INSUFFICIENT_LIQUIDITY: 2002,
      INTERNAL_SERVICE_ERROR: 3000,
      UPSTREAM_RATE_LIMITED: 3100,
      ACCOUNT_DENY_LISTED: 4400,
    });
  });

  it('pins the unroutable set to exactly 2000-2002', () => {
    expect([...OPHIS_UNROUTABLE_CODES]).toEqual([2000, 2001, 2002]);
  });
});

describe('ophisErrorBand', () => {
  it('maps every band of the frozen table', () => {
    expect(ophisErrorBand(1000)).toBe('api');
    expect(ophisErrorBand(1029)).toBe('api');
    expect(ophisErrorBand(2000)).toBe('quoting');
    expect(ophisErrorBand(2101)).toBe('quoting');
    expect(ophisErrorBand(3000)).toBe('upstream');
    expect(ophisErrorBand(3100)).toBe('upstream');
    expect(ophisErrorBand(4001)).toBe('validation');
    expect(ophisErrorBand(4400)).toBe('validation');
    expect(ophisErrorBand(5001)).toBe('internal');
  });

  it('is unknown outside 1000-5999 and for non-integers', () => {
    expect(ophisErrorBand(0)).toBe('unknown');
    expect(ophisErrorBand(999)).toBe('unknown');
    expect(ophisErrorBand(6000)).toBe('unknown');
    expect(ophisErrorBand(2000.5)).toBe('unknown');
  });
});

describe('parseOphisApiError', () => {
  it('parses the full self-hosted envelope (errorType, description, code, traceId, data)', () => {
    const err = parseOphisApiError({
      status: 400,
      body: {
        errorType: 'InvalidAppData',
        description: 'appData hash mismatch',
        code: 4007,
        traceId: TRACE,
        data: { field: 'appData' },
      },
    });
    expect(err).toBeInstanceOf(OphisApiError);
    expect(err.status).toBe(400);
    expect(err.errorType).toBe('InvalidAppData');
    expect(err.message).toBe('appData hash mismatch');
    expect(err.code).toBe(4007);
    expect(err.band).toBe('validation');
    expect(err.traceId).toBe(TRACE);
    expect(err.data).toEqual({ field: 'appData' });
  });

  it('classifies 404 code 2000 with data.class unroutable as the answer class', () => {
    const err = parseOphisApiError({
      status: 404,
      body: {
        errorType: 'NoLiquidity',
        description: 'no route found',
        code: 2000,
        traceId: TRACE,
        data: { class: 'unroutable' },
      },
    });
    expect(err).toBeInstanceOf(OphisUnroutableError);
    expect(err.name).toBe('OphisUnroutableError');
    expect(isUnroutable(err)).toBe(true);
    expect(isRetryable(err)).toBe(false);
  });

  it('classifies each unroutable code (2000, 2001, 2002)', () => {
    for (const code of OPHIS_UNROUTABLE_CODES) {
      const err = parseOphisApiError({ status: 404, body: { errorType: 'X', description: 'x', code } });
      expect(err, `code ${code}`).toBeInstanceOf(OphisUnroutableError);
    }
  });

  it('classifies data.class unroutable even without a code (envelope precedes the code rollout)', () => {
    const err = parseOphisApiError({
      status: 404,
      body: { errorType: 'SomeNewType', description: 'no route', data: { class: 'unroutable' } },
    });
    expect(err).toBeInstanceOf(OphisUnroutableError);
  });

  it('falls back to errorType strings on codeless CoW-hosted chains', () => {
    const noLiquidity = parseOphisApiError({
      status: 404,
      body: { errorType: 'NoLiquidity', description: 'no route was found' },
    });
    expect(noLiquidity).toBeInstanceOf(OphisUnroutableError);
    expect(noLiquidity.code).toBeUndefined();
    expect(noLiquidity.band).toBe('unknown');

    const unsupported = parseOphisApiError({
      status: 400,
      body: { errorType: 'UnsupportedToken', description: 'token xyz is unsupported' },
    });
    expect(unsupported).toBeInstanceOf(OphisUnroutableError);
  });

  it('a code on the body wins over the errorType fallback (2xxx code with a non-listed errorType)', () => {
    const err = parseOphisApiError({
      status: 404,
      body: { errorType: 'FreshlyRenamedType', description: 'x', code: 2002 },
    });
    expect(err).toBeInstanceOf(OphisUnroutableError);
  });

  it('classifies 429 as the rate-limit class via status, and via code 1029', () => {
    const byStatus = parseOphisApiError({ status: 429, body: { errorType: 'RateLimited', description: 'slow down' } });
    expect(byStatus).toBeInstanceOf(OphisRateLimitError);

    const byCode = parseOphisApiError({
      status: 429,
      body: { errorType: 'RateLimited', description: 'slow down', code: 1029 },
    });
    expect(byCode).toBeInstanceOf(OphisRateLimitError);
    expect(isRetryable(byCode)).toBe(false);
  });

  it('reads traceId from the X-Trace-Id header when the body has none', () => {
    const err = parseOphisApiError({
      status: 500,
      body: { errorType: 'InternalServerError', description: '' },
      headers: new Headers({ 'X-Trace-Id': TRACE }),
    });
    expect(err.traceId).toBe(TRACE);
  });

  it('prefers the body traceId over the header', () => {
    const err = parseOphisApiError({
      status: 500,
      body: { errorType: 'InternalServerError', description: '', traceId: TRACE },
      headers: new Headers({ 'X-Trace-Id': 'ffffffff-ffff-ffff-ffff-ffffffffffff' }),
    });
    expect(err.traceId).toBe(TRACE);
  });

  it('accepts a plain header record, case-insensitively', () => {
    const err = parseOphisApiError({
      status: 503,
      body: { errorType: 'UpstreamRateLimited', description: 'retry later', code: 3100 },
      headers: { 'x-trace-id': TRACE, 'retry-after': '1' },
    });
    expect(err.traceId).toBe(TRACE);
    expect(err.retryAfterSeconds).toBe(1);
  });

  it('parses Retry-After (delta seconds) and ignores garbage values', () => {
    const good = parseOphisApiError({ status: 503, body: undefined, headers: { 'Retry-After': '7' } });
    expect(good.retryAfterSeconds).toBe(7);

    const bad = parseOphisApiError({
      status: 503,
      body: undefined,
      headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });
    expect(bad.retryAfterSeconds).toBeUndefined();
  });

  it('degrades gracefully: unknown code preserves the raw payload and classifies by band', () => {
    const body = { errorType: 'BrandNewThing', description: 'from a newer backend', code: 4999, extra: [1, 2, 3] };
    const err = parseOphisApiError({ status: 400, body });
    expect(err).toBeInstanceOf(OphisApiError);
    expect(err.code).toBe(4999);
    expect(err.band).toBe('validation');
    expect(err.payload).toBe(body); // verbatim, nothing lost
  });

  it('degrades gracefully: non-JSON string body is preserved and used as the message', () => {
    const err = parseOphisApiError({ status: 502, body: 'Bad Gateway' });
    expect(err.message).toBe('Bad Gateway');
    expect(err.payload).toBe('Bad Gateway');
    expect(err.code).toBeUndefined();
  });

  it('degrades gracefully: missing body still yields a classified error', () => {
    const err = parseOphisApiError({ status: 500 });
    expect(err).toBeInstanceOf(OphisApiError);
    expect(err.message).toContain('500');
    expect(isRetryable(err)).toBe(true);
  });

  it('drops a malformed (non-integer) code instead of misclassifying', () => {
    const err = parseOphisApiError({ status: 400, body: { errorType: 'X', description: 'x', code: 'NOT_A_NUMBER' } });
    expect(err.code).toBeUndefined();
    expect(err.band).toBe('unknown');
  });
});

describe('getOphisTraceId', () => {
  it('reads the header from Headers and from a record', () => {
    expect(getOphisTraceId(new Headers({ 'X-Trace-Id': TRACE }))).toBe(TRACE);
    expect(getOphisTraceId({ 'X-TRACE-ID': TRACE })).toBe(TRACE);
    expect(getOphisTraceId({})).toBeUndefined();
    expect(getOphisTraceId(undefined)).toBeUndefined();
  });
});

describe('isRetryable', () => {
  it('retries the 3xxx upstream band and nothing else with a known code', () => {
    const upstream = parseOphisApiError({
      status: 503,
      body: { errorType: 'InternalServiceError', description: '', code: 3000 },
    });
    expect(isRetryable(upstream)).toBe(true);

    const upstreamRateLimited = parseOphisApiError({
      status: 503,
      body: { errorType: 'UpstreamRateLimited', description: '', code: 3100 },
    });
    expect(isRetryable(upstreamRateLimited)).toBe(true);

    // A coded validation error on a 503 status is still not retryable: the
    // code is the source of truth once present.
    const coded = parseOphisApiError({ status: 503, body: { errorType: 'X', description: '', code: 4001 } });
    expect(isRetryable(coded)).toBe(false);

    // 5xxx internal codes are not promised transient; only the 3xxx band is.
    const internal = parseOphisApiError({ status: 500, body: { errorType: 'X', description: '', code: 5000 } });
    expect(isRetryable(internal)).toBe(false);
  });

  it('falls back to the status on codeless hosts: 500/502/503/504 retry, 4xx do not', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryable(parseOphisApiError({ status })), `status ${status}`).toBe(true);
    }
    for (const status of [400, 403, 404, 422]) {
      expect(isRetryable(parseOphisApiError({ status })), `status ${status}`).toBe(false);
    }
  });

  it('never retries 429, even though it arrives with Retry-After', () => {
    const err = parseOphisApiError({ status: 429, body: undefined, headers: { 'Retry-After': '10' } });
    expect(err).toBeInstanceOf(OphisRateLimitError);
    expect(err.retryAfterSeconds).toBe(10);
    expect(isRetryable(err)).toBe(false);
  });

  it('never retries the unroutable answer class', () => {
    const err = parseOphisApiError({ status: 404, body: { errorType: 'NoLiquidity', description: '', code: 2000 } });
    expect(isRetryable(err)).toBe(false);
  });

  it('is false for foreign errors (transport failures are the caller\'s policy)', () => {
    expect(isRetryable(new Error('ECONNRESET'))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('withOphisRetry', () => {
  const upstreamError = (retryAfterSeconds?: number) =>
    parseOphisApiError({
      status: 503,
      body: { errorType: 'UpstreamRateLimited', description: 'later', code: 3100 },
      headers: retryAfterSeconds === undefined ? undefined : { 'Retry-After': String(retryAfterSeconds) },
    });

  it('retries a retryable error and returns the eventual success', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(upstreamError())
      .mockRejectedValueOnce(upstreamError())
      .mockResolvedValueOnce('quote');
    await expect(withOphisRetry(fn, { sleep, random: () => 0.5 })).resolves.toBe('quote');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured retries and rethrows the last error', async () => {
    const err = upstreamError();
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withOphisRetry(fn, { retries: 2, sleep: async () => {} })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries
  });

  it('never retries a 429 (the in-call doctrine)', async () => {
    const err = parseOphisApiError({ status: 429, headers: { 'Retry-After': '1' } });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withOphisRetry(fn, { sleep: async () => {} })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never retries an unroutable answer', async () => {
    const err = parseOphisApiError({ status: 404, body: { errorType: 'NoLiquidity', description: '', code: 2000 } });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withOphisRetry(fn, { sleep: async () => {} })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry foreign errors by default, but honors a custom predicate', async () => {
    const boom = new Error('ECONNRESET');
    const fn = vi.fn(async () => {
      throw boom;
    });
    await expect(withOphisRetry(fn, { sleep: async () => {} })).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);

    const fn2 = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce('ok');
    await expect(
      withOphisRetry(fn2, { sleep: async () => {}, shouldRetry: (e) => e === boom }),
    ).resolves.toBe('ok');
    expect(fn2).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially with jitter and honors Retry-After as a jittered floor', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(upstreamError()) // no Retry-After: jittered base 250
      .mockRejectedValueOnce(upstreamError(3)) // Retry-After 3s floors the 500ms base
      .mockResolvedValueOnce('ok');
    await expect(withOphisRetry(fn, { retries: 2, sleep, random: () => 1 })).resolves.toBe('ok');
    // Second delay: 3000ms floor + full 25% jitter on top of it. The floor is
    // jittered so synchronized clients told the same Retry-After second do
    // not all re-stampede the recovering upstream at once.
    expect(delays).toEqual([250, 3750]);
  });

  it('spreads the Retry-After floor across the jitter window instead of waking everyone on the same second', async () => {
    const delaysAt = async (random: () => number): Promise<number[]> => {
      const delays: number[] = [];
      const fn = vi
        .fn<(attempt: number) => Promise<string>>()
        .mockRejectedValueOnce(upstreamError(4))
        .mockResolvedValueOnce('ok');
      await withOphisRetry(fn, {
        sleep: async (ms) => {
          delays.push(ms);
        },
        random,
      });
      return delays;
    };
    expect(await delaysAt(() => 0)).toEqual([4000]); // floor untouched at the low end
    expect(await delaysAt(() => 0.5)).toEqual([4500]); // + half the 25% window
    expect(await delaysAt(() => 1)).toEqual([5000]); // + the full 25% window
  });

  it('caps a hostile Retry-After at 30s before jitter', async () => {
    const delaysAt = async (random: () => number): Promise<number[]> => {
      const delays: number[] = [];
      const fn = vi
        .fn<(attempt: number) => Promise<string>>()
        .mockRejectedValueOnce(upstreamError(86_400))
        .mockResolvedValueOnce('ok');
      await withOphisRetry(fn, {
        sleep: async (ms) => {
          delays.push(ms);
        },
        random,
      });
      return delays;
    };
    // The server value is capped at 30s; only the bounded 25% jitter window
    // sits on top, so a hostile header cannot park the caller for a day.
    expect(await delaysAt(() => 0)).toEqual([30_000]);
    expect(await delaysAt(() => 1)).toEqual([37_500]);
  });

  it('caps the jittered backoff at maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(upstreamError())
      .mockRejectedValueOnce(upstreamError())
      .mockRejectedValueOnce(upstreamError())
      .mockResolvedValueOnce('ok');
    await expect(
      withOphisRetry(fn, {
        retries: 3,
        minDelayMs: 1000,
        maxDelayMs: 1500,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 1,
      }),
    ).resolves.toBe('ok');
    expect(delays).toEqual([1000, 1500, 1500]);
  });

  it('respects an already-aborted signal before the first attempt', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user navigated away'));
    const fn = vi.fn(async () => 'never');
    await expect(withOphisRetry(fn, { signal: controller.signal })).rejects.toThrow('user navigated away');
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a negative or fractional retries option loudly', async () => {
    await expect(withOphisRetry(async () => 'x', { retries: -1 })).rejects.toThrow(TypeError);
    await expect(withOphisRetry(async () => 'x', { retries: 1.5 })).rejects.toThrow(TypeError);
  });

  it('rejects NaN, negative and Infinity delay options loudly (0.3.0 API freeze)', async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await expect(withOphisRetry(async () => 'x', { minDelayMs: bad })).rejects.toThrow(TypeError);
      await expect(withOphisRetry(async () => 'x', { maxDelayMs: bad })).rejects.toThrow(TypeError);
    }
  });

  it('rejects a broken random source instead of silently producing NaN delays', async () => {
    for (const bad of [Number.NaN, -0.5, Number.POSITIVE_INFINITY]) {
      const fn = vi
        .fn<(attempt: number) => Promise<string>>()
        .mockRejectedValueOnce(upstreamError())
        .mockResolvedValueOnce('never reached');
      await expect(withOphisRetry(fn, { sleep: async () => {}, random: () => bad })).rejects.toThrow(
        /random\(\) result/,
      );
      expect(fn).toHaveBeenCalledTimes(1); // failed before any sleep or second attempt
    }
  });
});
