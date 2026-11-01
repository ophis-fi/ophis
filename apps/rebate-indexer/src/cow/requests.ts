import { setTimeout as sleep } from 'node:timers/promises';

const origins = new Map<string, { tail: Promise<unknown>; nextAt: number; unavailableUntil: number; error?: Error }>();
const services = new Map<string, { until: number; error: Error }>();

/** All hosted chain paths share one rate limit. Queue reads by origin. */
export async function readCow<T>(url: string, request: () => Promise<Response>, parse: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const endpoint = new URL(url);
  const origin = endpoint.origin;
  const service = origin + endpoint.pathname.split('/api/')[0];
  const tokenService = endpoint.pathname.endsWith('/native_price') ? origin + endpoint.pathname : service;
  let state = origins.get(origin);
  if (!state) {
    state = { tail: Promise.resolve(), nextAt: 0, unavailableUntil: 0 };
    origins.set(origin, state);
  }
  const queue = state;
  const result = queue.tail.then(async () => {
    signal?.throwIfAborted();
    if (queue.unavailableUntil > Date.now()) throw queue.error;
    for (const scope of [service, tokenService]) {
      const unavailable = services.get(scope);
      if (unavailable && unavailable.until > Date.now()) throw unavailable.error;
    }
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, queue.nextAt - Date.now()), undefined, { signal });
      let response: Response;
      try {
        response = await request();
      } catch (error) {
        if (!signal?.aborted) {
          services.set(tokenService, { until: Date.now() + 60_000, error: error instanceof Error ? error : new Error(String(error)) });
        }
        throw error;
      }
      queue.nextAt = Date.now() + 400;
      if (response.status === 429 || response.status >= 500) {
        const body = await response.text();
        queue.error = new Error(`CoW API ${response.status} ${response.statusText} @ ${url} — ${body.slice(0, 200)}`);
        if (response.status >= 500) {
          // Estimator failures are token-specific; proxy outages cover the service.
          const outage = response.status === 502 || response.status === 504 || response.status >= 520;
          services.set(outage ? service : tokenService, { until: Date.now() + 60_000, error: queue.error });
          throw queue.error;
        }
        const retry = response.headers.get('retry-after');
        const seconds = retry === null ? NaN : Number(retry);
        const retryMs = retry !== null && Number.isNaN(seconds) ? Date.parse(retry) - Date.now() : seconds * 1_000;
        const delay = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 2_000 * 2 ** attempt;
        queue.unavailableUntil = Date.now() + delay;
        if (attempt >= 2 || delay > 30_000) throw queue.error;
        queue.nextAt = Math.max(queue.nextAt, queue.unavailableUntil);
        continue;
      }
      queue.unavailableUntil = 0;
      services.delete(service);
      services.delete(tokenService);
      return parse(response);
    }
  });
  queue.tail = result.catch(() => {});
  if (!signal) return result;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
