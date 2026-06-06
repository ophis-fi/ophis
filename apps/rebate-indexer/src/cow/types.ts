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

// GET /api/v1/token/{token}/native_price — CoW's price oracle, used by pricer.ts to
// denominate volume in USD. Returns the token's price as native-token wei per 1 ATOM
// of the token. Unlike /quote it takes NO from/receiver, so it cannot trip CoW's
// zero-address deny-list (which broke the old /quote-based pricer, 2026-06-05).
// Schema: https://docs.cow.fi/cow-protocol/reference/apis/orderbook
export const NativePriceResponse = z.object({
  price: z.number(),
});
export type NativePriceResponse = z.infer<typeof NativePriceResponse>;

export const APP_CODES = ['ophis', 'greg'] as const;                  // greg tolerated for pre-rebrand history
export type AppCode = (typeof APP_CODES)[number];

// POST /api/v1/quote response (#360 fee conversion). We read the canonical order
// parameters CoW computes (incl. appData/appDataHash) and reuse them verbatim in
// the order POST, so we never hand-construct the fragile order fields ourselves.
export const QuoteResponse = z.object({
  quote: z.object({
    sellToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
    buyToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
    receiver: z.string().nullable().optional(),
    sellAmount: z.string().regex(/^\d+$/),
    buyAmount: z.string().regex(/^\d+$/),
    validTo: z.number().int().nonnegative(),
    appData: z.string(),
    appDataHash: z.string().optional(),
    feeAmount: z.string().regex(/^\d+$/),
    kind: z.string(),
    partiallyFillable: z.boolean(),
    sellTokenBalance: z.string().optional(),
    buyTokenBalance: z.string().optional(),
  }),
});
export type QuoteResponse = z.infer<typeof QuoteResponse>;

// GET /api/v1/account/{owner}/orders — used for conversion idempotency (skip a
// token that already has an open sell→WETH order so we don't re-propose monthly).
export const AccountOrder = z.object({
  uid: z.string(),
  sellToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
  buyToken: z.string().regex(/^0x[0-9a-f]{40}$/i),
  status: z.string().optional(),                                       // 'open' | 'fulfilled' | 'expired' | 'cancelled' | ...
});
export type AccountOrder = z.infer<typeof AccountOrder>;
