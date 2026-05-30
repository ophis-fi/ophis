import { z } from 'zod';

// CoW orderbook API: GET /api/v1/trades?app_data_hash=<hash>
// Schema: https://docs.cow.fi/cow-protocol/reference/apis/orderbook (Trade)
export const CowTrade = z.object({
  blockNumber: z.number().int().nonnegative(),
  logIndex: z.number().int().nonnegative(),
  orderUid: z.string().regex(/^0x[0-9a-f]{112}$/i),                  // 56 bytes = 112 hex chars
  owner: z.string().regex(/^0x[0-9a-f]{40}$/i),
  sellToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
  buyToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
  sellAmount: z.string().regex(/^\d+$/),                              // uint256 as string
  buyAmount: z.string().regex(/^\d+$/),
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  // The trade endpoint exposes appData only via the linked order — we fetch it lazily.
});
export type CowTrade = z.infer<typeof CowTrade>;

// GET /api/v1/orders/<uid> — used to confirm appCode and grab settlement timestamp.
export const CowOrder = z.object({
  uid: z.string(),
  owner: z.string(),
  sellToken: z.string(),
  buyToken: z.string(),
  sellAmount: z.string(),
  buyAmount: z.string(),
  appData: z.string(),                                                // IPFS-hash hex
  fullAppData: z.string().nullable().optional(),                      // JSON string, when CoW resolved it
  creationDate: z.string(),                                           // ISO 8601 (informational)
  status: z.string().optional(),                                      // 'fulfilled' | 'open' | 'cancelled' | 'expired' | ...
  // Total filled across ALL fills (surplus-inclusive on the buy side). We
  // record these instead of a single trade-fill's amount so partial-fill / TWAP
  // orders don't undercount a wallet's volume (and therefore its rebate).
  executedSellAmount: z.string().optional(),
  executedBuyAmount: z.string().optional(),
});
export type CowOrder = z.infer<typeof CowOrder>;

// POST /api/v1/quote — used by pricer.ts to denominate volume in USD.
// We use the "sell-amount-from-quote" form to ask: what's $1 worth of <token>?
// then compute trade USD value from sellAmount / quote.buyAmount.
// Schema: https://docs.cow.fi/cow-protocol/reference/apis/orderbook
export const CowQuoteResponse = z.object({
  quote: z.object({
    sellToken: z.string(),
    buyToken: z.string(),
    sellAmount: z.string(),
    buyAmount: z.string(),
  }),
  expiration: z.string(),
});
export type CowQuoteResponse = z.infer<typeof CowQuoteResponse>;

export const APP_CODES = ['ophis', 'greg'] as const;                  // greg tolerated for pre-rebrand history
export type AppCode = (typeof APP_CODES)[number];
