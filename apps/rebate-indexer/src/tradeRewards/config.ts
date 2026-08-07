export const TRADE_REWARDS_CAMPAIGN_ID = 'ophis-winning-tickets-v1';
export const TRADE_REWARDS_CHAIN_ID = 4663;
export const TRADE_REWARDS_DISTRIBUTOR_SAFE =
  '0xB13Ab19F5FeC601813a46D877398B5Eb89eF10Da' as const;
export const TRADE_REWARDS_SIGNER =
  '0x9a9DC48DA629a1370d8c50821F65da3587739042' as const;
export const TRADE_REWARDS_RELAYER =
  '0x143D404003556Ca6A653084F54D2bcC491C05B26' as const;
export const ROBINHOOD_USDG =
  '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;

export const TRADE_REWARDS_MINIMUM_SWAP_USD = 100;
export const TRADE_REWARDS_WALLET_AGE_DAYS = 180;
export const ONE_USDG = 1_000_000n;
export const TEN_USDG = 10_000_000n;
export const TRADE_REWARDS_MAX_TICKETS = 105;
export const TRADE_REWARDS_MAX_PAYOUT = 150_000_000n;

/** Exact production chains approved for this campaign. Linea is intentionally excluded. */
export const TRADE_REWARDS_ELIGIBLE_CHAIN_IDS = Object.freeze([
  1,      // Ethereum
  56,     // BNB Chain
  42161,  // Arbitrum
  10,     // Optimism
  8453,   // Base
  4663,   // Robinhood Chain
  130,    // Unichain
  9745,   // Plasma
  57073,  // Ink
  100,    // Gnosis Chain
  43114,  // Avalanche
  137,    // Polygon
] as const);

export const TRADE_REWARDS_ELIGIBLE_CHAIN_ID_SET: ReadonlySet<number> =
  new Set<number>(TRADE_REWARDS_ELIGIBLE_CHAIN_IDS);
