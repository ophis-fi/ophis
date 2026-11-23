import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PartnerBreakdown, PartnerFeeDashboard, PartnerSanctioned, PartnerTraders } from './partnerFees/report.js';
import { z } from 'zod';
import type { getPartnerStatement } from './partnerFees/statement.js';
import { logger } from './logger.js';

// One token-gated read route for the Ophis Business console. A company wallet (a
// Safe) cannot sign the 5-minute partnerAuth message, so the console proves wallet
// control itself and reads here, server to server, the partner-fee dashboard, the
// wallets that traded through its integration (the trades that carried its fee), and its
// flow by day, chain and fee token with the payouts made to it (the breakdown). It
// never reads the referral dashboard: the console's partners get no referral share. The console also sends the addresses
// of the sanctions lists it holds (listed): each wallet's answer names those of them that traded through its integration.
// BUSINESS_API_TOKEN reads EVERY partner's fee dashboard and traders: it is a secret, and the
// feature is OFF (404) unless it is set, long, and different from the admin token.

export const statementQuery = z.object({
  from: z.iso.date(), to: z.iso.date(), after: z.string().regex(/^[A-Za-z0-9:-]{1,700}$/).optional(),
}).refine(q => q.from <= q.to);
export type StatementQuery = z.infer<typeof statementQuery>;

export interface BusinessDeps {
  getPartnerStatement?: typeof getPartnerStatement;
  getPartnerFeeDashboard: (recipient: `0x${string}`, now?: Date) => Promise<PartnerFeeDashboard>;
  getPartnerTraders: (recipient: `0x${string}`) => Promise<PartnerTraders>;
  getPartnerBreakdown: (recipient: `0x${string}`, now?: Date) => Promise<PartnerBreakdown>;
  getPartnerSanctioned: (recipient: `0x${string}`, listed: readonly string[]) => Promise<PartnerSanctioned>;
}

export interface BusinessPartnerAnswer {
  asOf: string;
  /** fees, traders, breakdown and sanctioned null: a contract wallet the console did not prove on its pinned chain. Nothing was read for it. */
  wallets: { wallet: `0x${string}`; fees: PartnerFeeDashboard | null; traders: PartnerTraders | null; breakdown: PartnerBreakdown | null; sanctioned: PartnerSanctioned | null }[];
}

// The chain each contract wallet is pinned to, as POST /partner reads it (affiliate/partnerAuth.ts): the same address
// on another chain can be a contract with other owners. Unset or unreadable means no contract wallet is pinned.
// listed: at most what the console's three lists can hold (20,000 addresses each), about 2.7 MB of JSON.
export const MAX_LISTED = 60_000;

function pinnedChains(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(process.env.CONTRACT_WALLET_AUTH_CHAINS || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function businessToken(): string | null {
  const token = process.env.BUSINESS_API_TOKEN ?? '';
  if (token.length < 32 || token === process.env.REBATE_INDEXER_ADMIN_TOKEN) return null;
  return token;
}

export function registerBusinessRoutes(app: FastifyInstance, deps: BusinessDeps): void {
  app.post<{ Body: { wallets?: unknown; contract?: unknown; listed?: unknown; statement?: unknown } }>('/business/partner', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, bodyLimit: 3_000_000,
  }, async (req, reply) => {
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

    // contract: for each wallet the console proved by a CONTRACT signature (not by the wallet's own key), the chains it
    // proved it on. Required, so that a caller cannot leave the rule out by leaving the field out.
    const contract = req.body?.contract;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return reply.code(400).send({ error: 'contract must be an object' });
    const proved = new Map(Object.entries(contract as Record<string, unknown>));
    for (const [wallet, chains] of proved) {
      if (!wallets.includes(wallet) || !Array.isArray(chains) || chains.length < 1 || chains.length > 10 || !chains.every((c) => Number.isSafeInteger(c) && c > 0)) {
        return reply.code(400).send({ error: 'invalid contract wallet chains' });
      }
    }
    // listed: the addresses on the sanctions lists the console holds. Required, as contract: an empty list says none is loaded.
    const rawListed = req.body?.listed;
    if (!Array.isArray(rawListed) || rawListed.length > MAX_LISTED) return reply.code(400).send({ error: `listed must hold at most ${MAX_LISTED} addresses` });
    const listed = rawListed.map((a) => (typeof a === 'string' ? a.toLowerCase() : ''));
    if (!listed.every((a) => /^0x[0-9a-f]{40}$/.test(a))) return reply.code(400).send({ error: 'invalid listed address' });
    if (new Set(listed).size !== listed.length) return reply.code(400).send({ error: 'duplicate listed address' });

    const pinned = pinnedChains();
    // Chains are integers above zero, so an unpinned wallet (undefined) and a pin that is no number never match.
    const readable = (w: string) => !proved.has(w) || (proved.get(w) as unknown[]).includes(pinned[w]);

    if (req.body?.statement !== undefined) {
      const query = statementQuery.safeParse(req.body.statement);
      if (!query.success || wallets.length !== 1) return reply.code(400).send({ error: 'invalid statement range or wallet' });
      if (!readable(wallets[0]!)) return reply.code(403).send({ error: 'wallet proof required' });
      if (!deps.getPartnerStatement) return reply.code(503).send({ error: 'statement unavailable' });
      return { wallet: wallets[0], ...await deps.getPartnerStatement(wallets[0]!, query.data) };
    }

    const now = new Date();
    logger.info({ wallets: wallets.length, refused: wallets.filter((w) => !readable(w)).length }, 'business partner read');
    const out: BusinessPartnerAnswer['wallets'] = [];
    // ponytail: one wallet after the other (at most 10); parallel if latency matters.
    for (const w of wallets as `0x${string}`[]) {
      out.push(readable(w)
        ? { wallet: w, fees: await deps.getPartnerFeeDashboard(w, now), traders: await deps.getPartnerTraders(w), breakdown: await deps.getPartnerBreakdown(w, now), sanctioned: await deps.getPartnerSanctioned(w, listed) }
        : { wallet: w, fees: null, traders: null, breakdown: null, sanctioned: null });
    }
    return { asOf: now.toISOString(), wallets: out };
  });
}
