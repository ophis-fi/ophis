import type { OtcCanaryPolicy } from './otcCanaryPolicy'

/** Populate only in the reviewed release that receives explicit mainnet-write approval. */
export const OTC_CANARY_POLICY: OtcCanaryPolicy = Object.freeze({
  accounts: Object.freeze([]),
  pairs: Object.freeze([]),
  expiresAt: 0n,
})
