import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PartnerFeeDashboard, PartnerTraders } from './partnerFees/report.js';
import { logger } from './logger.js';

// One token-gated read route for the Ophis Business console. A company wallet (a
// Safe) cannot sign the 5-minute partnerAuth message, so the console proves wallet
// control itself and reads here, server to server, the partner-fee dashboard and the
// wallets that traded through its integration (the trades that carried its fee). It
// never reads the referral dashboard: the console's partners get no referral share.
// BUSINESS_API_TOKEN reads EVERY partner's fee dashboard and traders: it is a secret, and the
// feature is OFF (404) unless it is set, long, and different from the admin token.

export interface BusinessDeps {
  getPartnerFeeDashboard: (recipient: `0x${string}`, now?: Date) => Promise<PartnerFeeDashboard>;
  getPartnerTraders: (recipient: `0x${string}`) => Promise<PartnerTraders>;
}

export interface BusinessPartnerAnswer {
  asOf: string;
  /** fees and traders null: a contract wallet the console did not prove on its pinned chain. Nothing was read for it. */
  wallets: { wallet: `0x${string}`; fees: PartnerFeeDashboard | null; traders: PartnerTraders | null }[];
}

// The chain each contract wallet is pinned to, as POST /partner reads it (affiliate/partnerAuth.ts): the same address
// on another chain can be a contract with other owners. Unset or unreadable means no contract wallet is pinned.
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
  app.post<{ Body: { wallets?: unknown; contract?: unknown } }>('/business/partner', {
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
    const pinned = pinnedChains();
    // Chains are integers above zero, so an unpinned wallet (undefined) and a pin that is no number never match.
    const readable = (w: string) => !proved.has(w) || (proved.get(w) as unknown[]).includes(pinned[w]);

    const now = new Date();
    logger.info({ wallets: wallets.length, refused: wallets.filter((w) => !readable(w)).length }, 'business partner read');
    const out: BusinessPartnerAnswer['wallets'] = [];
    // ponytail: one wallet after the other (at most 10); parallel if latency matters.
    for (const w of wallets as `0x${string}`[]) {
      out.push(readable(w)
        ? { wallet: w, fees: await deps.getPartnerFeeDashboard(w, now), traders: await deps.getPartnerTraders(w) }
        : { wallet: w, fees: null, traders: null });
    }
    return { asOf: now.toISOString(), wallets: out };
  });
}
