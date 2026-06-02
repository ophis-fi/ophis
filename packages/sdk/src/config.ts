import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_PRICE_IMPROVEMENT_BPS,
  OPHIS_MAX_VOLUME_BPS,
} from './partner-fee.js';

/** Ophis-operated chains (where Ophis runs its own stack and the partner fee accrues). */
export const OPHIS_CHAIN_IDS = Object.freeze({ optimism: 10, megaeth: 4326, hyperevm: 999 } as const);

export interface OphisDefaults {
  readonly chainId: number;
  readonly priceImprovementBps: number;
  readonly maxVolumeBps: number;
  readonly partnerRecipient: `0x${string}`;
}

/** Default config for Ophis's primary live chain (Optimism), using the real recipient + CIP-75 fee. */
export const ophisDefaults: OphisDefaults = Object.freeze({
  chainId: OPHIS_CHAIN_IDS.optimism,
  priceImprovementBps: OPHIS_PRICE_IMPROVEMENT_BPS,
  maxVolumeBps: OPHIS_MAX_VOLUME_BPS,
  partnerRecipient: OPHIS_PARTNER_FEE_RECIPIENT,
});
