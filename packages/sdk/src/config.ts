import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_VOLUME_FEE_BPS,
} from './partner-fee.js';

/** Ophis-operated chains (where Ophis runs its own stack and the partner fee accrues). */
export const OPHIS_CHAIN_IDS = Object.freeze({ optimism: 10, unichain: 130, megaeth: 4326, hyperevm: 999 } as const);

export interface OphisDefaults {
  readonly chainId: number;
  readonly volumeBps: number;
  readonly partnerRecipient: `0x${string}`;
}

/** Default config for Ophis's primary live chain (Optimism), using the real recipient + CIP-75 volume fee. */
export const ophisDefaults: OphisDefaults = Object.freeze({
  chainId: OPHIS_CHAIN_IDS.optimism,
  volumeBps: OPHIS_VOLUME_FEE_BPS,
  partnerRecipient: OPHIS_PARTNER_FEE_RECIPIENT,
});
