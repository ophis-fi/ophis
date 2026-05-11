import { sql } from './db/index.js';
import { assignTier, TIERS, type Tier } from './tiers.js';

export interface WalletStatus {
  wallet: `0x${string}`;
  volume_30d_usd: number;
  trade_count_30d: number;
  tier: Tier;
  next_tier: Tier | null;                                              // null at Platinum
  usd_to_next_tier: number;                                            // 0 at Platinum
}

export async function getWalletStatus(wallet: `0x${string}`): Promise<WalletStatus> {
  const walletBuf = Buffer.from(wallet.slice(2), 'hex');
  const rows = await sql<{ volume_30d_usd: string; trade_count_30d: string }[]>`
    SELECT volume_30d_usd::text, trade_count_30d::text
    FROM wallets
    WHERE wallet = ${walletBuf}
  `;
  const volume = rows.length > 0 ? parseFloat(rows[0]!.volume_30d_usd) : 0;
  const count = rows.length > 0 ? parseInt(rows[0]!.trade_count_30d, 10) : 0;

  const tier = assignTier(volume);
  const tier_idx = TIERS.findIndex((t) => t.name === tier.name);
  const next_tier = tier_idx < TIERS.length - 1 ? TIERS[tier_idx + 1]! : null;
  const usd_to_next_tier = next_tier ? Math.max(0, next_tier.min_usd - volume) : 0;

  return { wallet, volume_30d_usd: volume, trade_count_30d: count, tier, next_tier, usd_to_next_tier };
}
