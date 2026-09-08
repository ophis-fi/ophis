import { OPHIS_MAX_PARTNER_REQUEST_BPS } from 'ophis/partnerFeeDefault'

// A host's own fee is STACKED with the Ophis policy (1 bp base + capped price
// improvement, up to 100 bps on a volatile pair), so the ceiling is the
// registered-integrator request cap: 90 + 100 = OPHIS_AGGREGATE_PARTNER_FEE_CAP_BPS
// (190) on Ophis-operated chains, and CoW-hosted chains clamp their 100 bps
// aggregate in array order with the host entry first.
export const PARTNER_FEE_MAX_BPS = OPHIS_MAX_PARTNER_REQUEST_BPS // 0.9%
