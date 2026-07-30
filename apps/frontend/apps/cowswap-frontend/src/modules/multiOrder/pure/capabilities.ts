/**
 * EIP-5792 capability detection + batch call assembly for the smart-account
 * basket tier.
 *
 * The default tier steps through one EIP-712 signature per leg. A smart account
 * (EIP-5792 wallet) can instead submit ONE `wallet_sendCalls` batch of
 * `setPreSignature(orderUid, true)` calls against the settlement contract (the
 * presign signing scheme), so all legs are pre-signed in a single wallet
 * interaction. This is BEST-EFFORT same-batch, NEVER atomic: even when the
 * wallet lands the calls in one transaction, the legs settle as independent CoW
 * orders (Phase A has no settler contract). We therefore never advertise
 * atomicity, and per-leg status + cancel-of-unfilled remain mandatory.
 *
 * Pure: no wallet client, no network. The React hook (useBatchPresign) feeds
 * these helpers a capabilities object and an encoder.
 */

/** Loosely-typed EIP-5792 capabilities map: chainId (hex or number key) -> caps. */
export type Eip5792Capabilities = Record<string, unknown> | undefined | null

/**
 * True when the wallet reports atomic-batch support for `chainId`. Handles both
 * the current spec shape (`atomic: { status: 'supported' | 'ready' }`) and the
 * older `atomicBatch: { supported: true }` shape, and both hex (`0xa`) and
 * decimal (`10`) chain-id keys. Unknown / missing => false (fall back to the
 * stepped tier). Never throws on a malformed object.
 */
export function detectAtomicBatchCapability(caps: Eip5792Capabilities, chainId: number): boolean {
  if (!caps || typeof caps !== 'object') return false
  const entry = readChainEntry(caps as Record<string, unknown>, chainId)
  if (!entry || typeof entry !== 'object') return false
  const e = entry as { atomic?: { status?: unknown }; atomicBatch?: { supported?: unknown } }
  const status = e.atomic?.status
  if (status === 'supported' || status === 'ready') return true
  if (e.atomicBatch?.supported === true) return true
  return false
}

function readChainEntry(caps: Record<string, unknown>, chainId: number): unknown {
  // Try the common key spellings a wallet might use for the chain id.
  const hex = `0x${chainId.toString(16)}`
  return (
    caps[hex] ??
    caps[hex.toLowerCase()] ??
    caps[String(chainId)] ??
    caps[chainId as unknown as string]
  )
}

/** One call in an EIP-5792 `wallet_sendCalls` batch. */
export interface Eip5792Call {
  readonly to: string
  readonly data: string
  readonly value: string
}

/**
 * Build the `wallet_sendCalls` batch that pre-signs every basket leg: one
 * `setPreSignature(orderUid, true)` call per leg, all to the settlement
 * contract. `encodeSetPreSignature` is injected (viem `encodeFunctionData` in
 * the hook) so this stays pure and testable. Order is preserved (leg order).
 * Throws on an empty uid list or a missing settlement address.
 */
export function buildSetPreSignatureCalls(
  orderUids: readonly string[],
  settlement: string,
  encodeSetPreSignature: (orderUid: string) => string,
): Eip5792Call[] {
  if (!settlement) throw new Error('buildSetPreSignatureCalls: missing settlement address')
  if (orderUids.length === 0) throw new Error('buildSetPreSignatureCalls: no order uids')
  return orderUids.map((uid) => ({
    to: settlement,
    data: encodeSetPreSignature(uid),
    value: '0x0',
  }))
}

/** The `setPreSignature(bytes,bool)` ABI fragment (viem-compatible human-readable form). */
export const SET_PRE_SIGNATURE_ABI = [
  {
    name: 'setPreSignature',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderUid', type: 'bytes' },
      { name: 'signed', type: 'bool' },
    ],
    outputs: [],
  },
] as const
