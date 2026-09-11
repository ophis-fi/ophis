import type { AcrossBridgeProviderOptions } from '@cowprotocol/sdk-bridging'

/** Across integrator tag issued to Ophis. 2 bytes, public: it rides in query strings and deposit calldata. */
export const ACROSS_INTEGRATOR_ID = '0x0311'

/**
 * Across API options shared by the swap app and the explorer: the Ophis
 * integrator ID for attribution plus the API key when the build carries one
 * (empty -> undefined, so a keyless dev build sends no blank Bearer header).
 */
export function ophisAcrossApiOptions(): NonNullable<AcrossBridgeProviderOptions['apiOptions']> {
  return { apiKey: process.env.REACT_APP_ACROSS_API_KEY || undefined, integratorId: ACROSS_INTEGRATOR_ID }
}
