import { ARC_CHAIN_ID } from './arc.const'

export const BFF_BASE_URL = process.env['REACT_APP_BFF_BASE_URL'] || 'https://bff.barn.cow.fi'

// CoW's hosted BFF and permit CDN do not serve these Ophis orderbook chains.
export const COW_API_UNSUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set([10, 130, 4663, ARC_CHAIN_ID])
