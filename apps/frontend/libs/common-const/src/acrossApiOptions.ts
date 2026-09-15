import type { AcrossBridgeProviderOptions } from '@cowprotocol/sdk-bridging'

/** Across integrator tag issued to Ophis. 2 bytes, public: it rides in query strings and deposit calldata. */
export const ACROSS_INTEGRATOR_ID = '0x0311'

/** Across's calldata delimiter for the on-chain integrator tag (their toolkit's DOMAIN_CALLDATA_DELIMITER). */
export const ACROSS_CALLDATA_DELIMITER = '0x1dc0de'

/**
 * Appends Across's on-chain integrator tag (delimiter + ID) to a hook's
 * calldata. Across attributes a deposit by the LAST bytes of the transaction
 * that made it (their toolkit checks with endsWith). Our deposit runs inside a
 * CoW Shed post-hook, so the transaction is the solver's settle(): its tail is
 * the last post-interaction's calldata, i.e. this hook. Zero-padding first so
 * the tagged bytes end on a 32-byte boundary means every ABI layer above
 * (HooksTrampoline, settle) adds no padding of its own and the tag stays the
 * tail. The callee ignores trailing calldata, as Across's own deposits rely on.
 *
 * ponytail: assumes the bridge hook is the settlement's last post-interaction
 * (the driver's layout). A solver appending its own post-interaction moves the
 * tag off the tail and Across simply does not attribute; nothing else changes.
 */
export function tagAcrossIntegratorCalldata(callData: string): string {
  const hex = callData.startsWith('0x') ? callData.slice(2) : callData
  const tag = ACROSS_CALLDATA_DELIMITER.slice(2) + ACROSS_INTEGRATOR_ID.slice(2)
  const padBytes = (32 - (((hex.length + tag.length) / 2) % 32)) % 32
  return `0x${hex}${'00'.repeat(padBytes)}${tag}`
}

/**
 * Across API options shared by the swap app and the explorer: the Ophis
 * integrator ID for attribution plus the API key when the build carries one
 * (empty -> undefined, so a keyless dev build sends no blank Bearer header).
 */
export function ophisAcrossApiOptions(): NonNullable<AcrossBridgeProviderOptions['apiOptions']> {
  return { apiKey: process.env.REACT_APP_ACROSS_API_KEY || undefined, integratorId: ACROSS_INTEGRATOR_ID }
}
