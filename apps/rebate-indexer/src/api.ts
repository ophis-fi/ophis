import Fastify, { type FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { sql, db, schema } from './db/index.js';
import { getWalletStatus } from './tierer.js';
import { logger } from './logger.js';

export async function buildApiServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });                              // we use pino directly

  // CORS — the swap page (ophis.fi + *.pages.dev) calls /tier directly.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    const allowed = ['https://ophis.fi', 'https://www.ophis.fi', 'https://greg.pages.dev', 'https://ophis.pages.dev'];
    if (origin && allowed.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
  });
  app.options('*', async (_req, reply) => reply.code(204).send());

  app.get('/health', async () => {
    const healthRows = await sql<{ last_fetch: string | null }[]>`
      SELECT MAX(fetched_at)::text AS last_fetch FROM trades
    `;
    const pendingRows = await sql<{ pending: string }[]>`
      SELECT COUNT(*)::text AS pending FROM rebate_batches WHERE status IN ('computing','proposed')
    `;
    const last_fetch = healthRows[0]?.last_fetch ?? null;
    const pending = pendingRows[0]?.pending ?? '0';
    return { ok: true, last_fetch, pending_batches: parseInt(pending, 10) };
  });

  app.get('/status', async () => {
    const lastRows = await sql<{ cycle_month: string; status: string; pool_weth_wei: string }[]>`
      SELECT cycle_month::text, status, pool_weth_wei::text
      FROM rebate_batches ORDER BY id DESC LIMIT 1
    `;
    const walletsRows = await sql<{ total_wallets: string }[]>`SELECT COUNT(*)::text AS total_wallets FROM wallets`;
    const volumeRows = await sql<{ total_volume: string | null }[]>`SELECT COALESCE(SUM(volume_30d_usd)::text, '0') AS total_volume FROM wallets`;
    const total_wallets = walletsRows[0]?.total_wallets ?? '0';
    const total_volume = volumeRows[0]?.total_volume ?? '0';
    return {
      ok: true,
      last_batch: lastRows[0] ?? null,
      total_wallets: parseInt(total_wallets, 10),
      total_volume_30d_usd: total_volume,
      next_batch_cycle: nextFirstOfMonth().toISOString(),
    };
  });

  app.get<{ Params: { wallet: string } }>('/tier/:wallet', async (req, reply) => {
    const raw = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) return reply.code(400).send({ error: 'invalid wallet address' });
    const status = await getWalletStatus(raw as `0x${string}`);
    return status;
  });

  app.get('/batches', async () => {
    const rows = await db.select().from(schema.rebateBatches).orderBy(desc(schema.rebateBatches.id)).limit(100);
    return rows;
  });

  app.get<{ Params: { id: string } }>('/batches/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' });
    const [batch] = await db.select().from(schema.rebateBatches).where(eq(schema.rebateBatches.id, id));
    if (!batch) return reply.code(404).send({ error: 'not found' });
    const entries = await db.select().from(schema.rebateBatchEntries).where(eq(schema.rebateBatchEntries.batchId, id));
    return { batch, entries };
  });

  return app;
}

function nextFirstOfMonth(): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  d.setUTCHours(2, 0, 0, 0);
  return d;
}

export async function startApi(): Promise<FastifyInstance> {
  const app = await buildApiServer();
  const port = parseInt(process.env.API_PORT ?? '8080', 10);
  await app.listen({ host: '0.0.0.0', port });
  logger.info({ port }, 'api listening');
  return app;
}
