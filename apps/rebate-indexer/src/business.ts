import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PartnerDashboard } from './api.js';
import type { PartnerFeeDashboard } from './partnerFees/report.js';
import { logger } from './logger.js';

// One token-gated read route for the Ophis Business console. A company wallet (a
// Safe) cannot sign the 5-minute partnerAuth message, so the console proves wallet
// control itself and reads the same two dashboards here, server to server.
// BUSINESS_API_TOKEN reads EVERY partner's dashboard: it is a secret, and the
// feature is OFF (404) unless it is set, long, and different from the admin token.

export interface BusinessDeps {
  getPartnerDashboard: (address: `0x${string}`, now: Date) => Promise<PartnerDashboard | null>;
  getPartnerFeeDashboard: (recipient: `0x${string}`, now?: Date) => Promise<PartnerFeeDashboard>;
}

export interface BusinessPartnerAnswer {
  asOf: string;
  wallets: { wallet: `0x${string}`; affiliate: PartnerDashboard | null; fees: PartnerFeeDashboard }[];
}

function businessToken(): string | null {
  const token = process.env.BUSINESS_API_TOKEN ?? '';
  if (token.length < 32 || token === process.env.REBATE_INDEXER_ADMIN_TOKEN) return null;
  return token;
}

export function registerBusinessRoutes(app: FastifyInstance, deps: BusinessDeps): void {
  app.post<{ Body: { wallets?: unknown } }>('/business/partner', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply): Promise<BusinessPartnerAnswer | undefined> => {
    const expected = businessToken();
    if (!expected) return reply.code(404).send({ error: 'not found' });
    const header = req.headers['authorization'];
    const presented = Buffer.from(typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '', 'utf8');
    const want = Buffer.from(expected, 'utf8');
    // Constant-time compare, as assertAdminAuth does.
    if (presented.length !== want.length || !timingSafeEqual(presented, want)) return reply.code(401).send({ error: 'unauthorized' });

    const raw = req.body?.wallets;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) return reply.code(400).send({ error: 'wallets must hold 1 to 10 addresses' });
    const wallets = raw.map((w) => (typeof w === 'string' ? w.toLowerCase() : ''));
    if (!wallets.every((w) => /^0x[0-9a-f]{40}$/.test(w))) return reply.code(400).send({ error: 'invalid wallet address' });
    if (new Set(wallets).size !== wallets.length) return reply.code(400).send({ error: 'duplicate wallet' });

    const now = new Date();
    logger.info({ wallets: wallets.length }, 'business partner read');
    const out: BusinessPartnerAnswer['wallets'] = [];
    // ponytail: one wallet after the other (at most 10); parallel if latency matters.
    for (const w of wallets as `0x${string}`[]) {
      out.push({ wallet: w, affiliate: await deps.getPartnerDashboard(w, now), fees: await deps.getPartnerFeeDashboard(w, now) });
    }
    return { asOf: now.toISOString(), wallets: out };
  });
}
