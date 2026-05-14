export const OPHIS_CHAIN_IDS = { gnosis: 100 } as const;

export const OPHIS_PARTNER_FEE_BPS = 5;
export const OPHIS_PARTNER_RECIPIENT =
  '0x0000000000000000000000000000000000000000' as const;

export interface OphisDefaults {
  readonly chainId: number;
  readonly partnerFeeBps: number;
  readonly partnerRecipient: `0x${string}`;
}

export const ophisDefaults: OphisDefaults = {
  chainId: OPHIS_CHAIN_IDS.gnosis,
  partnerFeeBps: OPHIS_PARTNER_FEE_BPS,
  partnerRecipient: OPHIS_PARTNER_RECIPIENT,
};
