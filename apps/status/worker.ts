// status.ophis.fi: a cron run checks the services due this minute and hands the results to one
// Durable Object, which keeps the whole state as one JSON string. The page and its files are
// static assets, served without running this Worker; only /status.json does. README.md has the
// free-plan budget this shape is built around.
import { DurableObject } from 'cloudflare:workers';
import { apply, check, due, type Result, type State } from './core';

interface Env {
  STATUS: DurableObjectNamespace<StatusStore>;
}

export class StatusStore extends DurableObject<Env> {
  /** One row read and one row written a round. No other event runs between the two. */
  async record(t: number, results: Result[]): Promise<void> {
    const prev = await this.ctx.storage.get<string>('state');
    const next = apply(prev ? (JSON.parse(prev) as State) : undefined, t, results);
    await this.ctx.storage.put('state', JSON.stringify(next));
  }

  async snapshot(): Promise<string> {
    return (await this.ctx.storage.get<string>('state')) ?? '{}';
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const minute = Math.floor(controller.scheduledTime / 60_000);
    const results = await Promise.all(due(minute).map((s) => check(s)));
    const down = results.filter((r) => r[1] === 'down').map((r) => `${r[0]}: ${r[3]}`);
    if (down.length) console.log(JSON.stringify({ minute, down }));
    await env.STATUS.getByName('status').record(minute * 60, results);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { origin, pathname } = new URL(request.url);
    if (pathname !== '/status.json' || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return new Response('Not found\n', { status: 404 });
    }
    // Thirty seconds in this data centre's cache: a burst of readers costs the store one read.
    // That copy is the Worker's own and never goes out as it is: Cloudflare rewrites the
    // Cache-Control of an answer it serves from cache to the zone's browser TTL (four hours on
    // ophis.fi, seen on the first deploy), and a browser would then show a status hours old.
    const key = new Request(`${origin}/status.json`);
    const cached = await caches.default.match(key);
    let state = cached ? await cached.text() : undefined;
    if (state === undefined) {
      try {
        state = await env.STATUS.getByName('status').snapshot();
      } catch (error) {
        // The store is out of reach: say so. The page then reads "Status data is unavailable".
        console.error(JSON.stringify({ error: 'snapshot failed', detail: String(error) }));
        return new Response('{"error":"unavailable"}\n', {
          status: 503,
          headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
        });
      }
      const copy = new Response(state, { headers: { 'cache-control': 'public, max-age=30' } });
      ctx.waitUntil(caches.default.put(key, copy));
    }
    return new Response(state, { headers: { ...JSON_HEADERS, 'cache-control': 'no-store' } });
  },
} satisfies ExportedHandler<Env>;
