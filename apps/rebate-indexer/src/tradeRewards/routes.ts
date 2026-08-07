import type { FastifyInstance } from 'fastify';
import { getTradeRewardStatus, sponsorTradeRewardClaim } from './service.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function walletAddress(raw: unknown): `0x${string}` | null {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return ADDRESS_RE.test(normalized) ? normalized as `0x${string}` : null;
}

export function registerTradeRewardRoutes(app: FastifyInstance): void {
  app.get<{ Params: { wallet: string } }>(
    '/trade-rewards/:wallet',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const wallet = walletAddress(req.params.wallet);
      if (!wallet) return reply.code(400).send({ error: 'invalid wallet address' });
      reply.header('cache-control', 'no-store');
      return getTradeRewardStatus(wallet);
    },
  );

  app.post<{ Body: { wallet?: string } }>(
    '/trade-rewards/claim',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const wallet = walletAddress(req.body?.wallet);
      if (!wallet) return reply.code(400).send({ error: 'invalid wallet address' });
      try {
        const transactionHash = await sponsorTradeRewardClaim(wallet);
        reply.header('cache-control', 'no-store');
        return { wallet, ...(transactionHash ? { transactionHash } : {}), status: 'claimed' as const };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'claim failed';
        return reply.code(409).send({ error: message });
      }
    },
  );
}
