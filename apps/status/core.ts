// Status page logic with no Workers-only API, so tests/functions/status.test.ts runs it on plain
// Node: the monitored services, which of them are due in a given minute, one check, and how a
// round of results changes the stored state. The stored state is served as it is on /status.json.

export type St = 'up' | 'warn' | 'down';
export type Result = [id: string, st: St, ms: number, why: string];

export interface Service {
  id: string;
  name: string;
  group: number; // index into GROUPS
  url: string;
  every: number; // minutes between two checks
  expect?: number; // the healthy HTTP status, 200 when omitted
  indexer?: true; // the body is the rebate indexer's health JSON
}

export const GROUPS = [
  'Apps',
  'For builders',
  'Ophis-operated chains',
  'Partner-hosted chains',
  'Cross-chain routes',
];

// A chain's orderbook answers its version: Ophis's own through a tunnel, a partner's on its API.
const own = (id: string, name: string): Service => ({
  id,
  name,
  group: 2,
  every: 1,
  url: `https://${id}-mainnet.ophis.fi/api/v1/version`,
});
const partner = (id: string, name: string, slug = id): Service => ({
  id,
  name,
  group: 3,
  every: 5,
  url: `https://api.cow.fi/${slug}/api/v1/version`,
});

// `every` is the budget (README, "Free plan"). 1: served from Ophis's own servers through a tunnel,
// the likeliest to fail and free to check. 5: static sites and partner APIs, free to check.
// 10: the check runs Worker or Pages Function code of this account, so it costs one of the
// account's 100,000 daily requests.
export const SERVICES: Service[] = [
  { id: 'swap', name: 'Swap', group: 0, every: 10, url: 'https://swap.ophis.fi/' },
  { id: 'web', name: 'Website', group: 0, every: 5, url: 'https://ophis.fi/' },
  { id: 'docs', name: 'Docs', group: 0, every: 5, url: 'https://docs.ophis.fi/' },
  { id: 'explorer', name: 'Explorer', group: 0, every: 5, url: 'https://explorer.ophis.fi/' },
  { id: 'safe', name: 'Safe app', group: 0, every: 5, url: 'https://safe.ophis.fi/manifest.json' },
  { id: 'pro', name: 'Business console', group: 0, every: 10, url: 'https://pro.ophis.fi/' },
  // A GET never reaches the model behind the Intent API: 405 proves the function is deployed.
  {
    id: 'intent',
    name: 'Intent API',
    group: 1,
    every: 10,
    url: 'https://ophis.fi/api/intent',
    expect: 405,
  },
  { id: 'mcp', name: 'MCP server', group: 1, every: 10, url: 'https://mcp.ophis.fi/health' },
  {
    id: 'compat',
    name: 'Compatibility API',
    group: 1,
    every: 10,
    url: 'https://compat.ophis.fi/healthz',
  },
  {
    id: 'indexer',
    name: 'Rewards indexer',
    group: 1,
    every: 1,
    url: 'https://rebates.ophis.fi/health',
    indexer: true,
  },
  own('optimism', 'Optimism'),
  own('robinhood', 'Robinhood Chain'),
  own('arc', 'Arc'),
  partner('ethereum', 'Ethereum', 'mainnet'),
  partner('bnb', 'BNB Chain'),
  partner('gnosis', 'Gnosis', 'xdai'),
  partner('polygon', 'Polygon'),
  partner('base', 'Base'),
  partner('arbitrum', 'Arbitrum', 'arbitrum_one'),
  partner('avalanche', 'Avalanche'),
  partner('linea', 'Linea'),
  partner('ink', 'Ink'),
  partner('plasma', 'Plasma'),
  {
    id: 'near',
    name: 'NEAR Intents',
    group: 4,
    every: 5,
    url: 'https://1click.chaindefuser.com/v0/tokens',
  },
];

/** The services to check in this minute. Services of one cadence are spread over its cycle. */
// ponytail: stateless modulo, so a cron run Cloudflare skips delays those checks by one cycle;
// ask the store which checks are overdue if that ever shows.
export function due(minute: number, services: Service[] = SERVICES): Service[] {
  const seen = new Map<number, number>();
  return services.filter((s) => {
    const offset = seen.get(s.every) ?? 0;
    seen.set(s.every, offset + 1);
    return (minute + offset) % s.every === 0;
  });
}

export const DAYS = 90;
export const BEATS = 60;
const OUTAGES = 50;
const CODE = { up: 'u', warn: 'w', down: 'd' } as const;

export interface Entry {
  id: string;
  name: string;
  g: number;
  every: number;
  st: St | ''; // '' until the first check
  ms: number;
  why: string;
  at: number; // the last check, in seconds
  since: number; // when `st` began
  h: string; // the last BEATS checks, oldest first: u, w or d
  d: [checks: number, failed: number][]; // one per UTC day, today first, DAYS at most
}

export interface Outage {
  id: string;
  name: string;
  from: number;
  to: number | null; // null while it lasts
  why: string;
}

export interface State {
  t: number; // the last round, in seconds
  day: string; // its UTC day: d[0] of every entry
  groups: string[];
  svc: Entry[];
  ev: Outage[]; // newest first
}

/** The state after one round of results at time `t` (seconds). Never changes `prev`. */
export function apply(
  prev: State | undefined,
  t: number,
  results: Result[],
  services: Service[] = SERVICES,
): State {
  if (prev && t <= prev.t) return prev; // a repeated or late cron run
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  const gap = prev ? Math.round((Date.parse(day) - Date.parse(prev.day)) / 86_400_000) : 0;
  const blank = Array.from({ length: Math.min(gap, DAYS) }, (): [number, number] => [0, 0]);
  const old = new Map(prev?.svc.map((e) => [e.id, e]));
  const got = new Map(results.map((r) => [r[0], r]));
  const ids = new Set(services.map((s) => s.id));
  // An outage of a service that left the list ends here, or it would stay open for ever.
  let ev = (prev?.ev ?? []).map((o) => (o.to === null && !ids.has(o.id) ? { ...o, to: t } : o));

  const svc = services.map((s): Entry => {
    const e = old.get(s.id);
    const d = [...blank, ...(e?.d ?? [[0, 0] as [number, number]])].slice(0, DAYS);
    const base = { id: s.id, name: s.name, g: s.group, every: s.every };
    const r = got.get(s.id);
    if (!r) return { st: '', ms: 0, why: '', at: 0, since: 0, h: '', ...e, ...base, d };

    const [, st, ms, why] = r;
    const [checks, failed] = d[0] ?? [0, 0];
    d[0] = [checks + 1, failed + (st === 'down' ? 1 : 0)];
    if (st === 'down' && e?.st !== 'down') {
      ev = [{ id: s.id, name: s.name, from: t, to: null, why }, ...ev];
    } else if (st !== 'down' && e?.st === 'down') {
      ev = ev.map((o) => (o.id === s.id && o.to === null ? { ...o, to: t } : o));
    }
    return {
      ...base,
      st,
      ms,
      why,
      at: t,
      since: e && e.st === st ? e.since : t,
      h: ((e?.h ?? '') + CODE[st]).slice(-BEATS),
      d,
    };
  });

  return { t, day, groups: GROUPS, svc, ev: ev.slice(0, OUTAGES) };
}

const TIMEOUT_MS = 8_000;
const RETRY_MS = 1_500;
const SLOW_MS = 3_000;
const MAX_BODY = 64 * 1024;

/** The body as text, refused past MAX_BODY: a health answer is small, whatever the origin sends. */
async function bounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  for (let size = 0; ; ) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new SyntaxError('body too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

// `why` is always one of these fixed words: nothing an origin sends is copied into /status.json.
async function attempt(s: Service): Promise<Result> {
  const started = Date.now();
  const result = (st: St, why = ''): Result => [s.id, st, Date.now() - started, why];
  try {
    const response = await fetch(s.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'ophis-status/1 (+https://status.ophis.fi)' },
    });
    if (response.status !== (s.expect ?? 200)) {
      await response.body?.cancel();
      return result('down', `http ${response.status}`);
    }
    if (s.indexer) {
      const health = JSON.parse(await bounded(response)) as { ok?: unknown; data_fresh?: unknown };
      if (health.ok !== true) return result('down', 'unhealthy');
      if (health.data_fresh !== true) return result('warn', 'data is stale');
    } else {
      // An unread body holds its connection, and a Worker has six.
      await response.body?.cancel();
    }
    return Date.now() - started > SLOW_MS ? result('warn', 'slow response') : result('up');
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError') return result('down', 'timeout');
    return result('down', name === 'SyntaxError' ? 'bad response' : 'unreachable');
  }
}

/** One check. Down means two failed attempts in a row, so one lost packet is not an outage. */
export async function check(s: Service, retryMs = RETRY_MS): Promise<Result> {
  const first = await attempt(s);
  if (first[1] !== 'down') return first;
  await new Promise((resolve) => setTimeout(resolve, retryMs));
  return attempt(s);
}
