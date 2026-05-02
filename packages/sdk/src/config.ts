export const GREG_CHAIN_IDS = { gnosis: 100 } as const;

export const GREG_PARTNER_FEE_BPS = 5;
export const GREG_PARTNER_RECIPIENT =
  '0x0000000000000000000000000000000000000000' as const;

export interface GregDefaults {
  readonly chainId: number;
  readonly partnerFeeBps: number;
  readonly partnerRecipient: `0x${string}`;
}

export const gregDefaults: GregDefaults = {
  chainId: GREG_CHAIN_IDS.gnosis,
  partnerFeeBps: GREG_PARTNER_FEE_BPS,
  partnerRecipient: GREG_PARTNER_RECIPIENT,
};
