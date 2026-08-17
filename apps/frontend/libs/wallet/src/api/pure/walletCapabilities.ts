export type AtomicBatchCapabilityStatus = 'ready' | 'supported' | 'unsupported'

export interface WalletCapabilities {
  readonly atomic?: {
    readonly status: AtomicBatchCapabilityStatus
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAtomicStatus(value: unknown): AtomicBatchCapabilityStatus | undefined {
  if (!isRecord(value)) return undefined

  const { status } = value

  return status === 'ready' || status === 'supported' || status === 'unsupported' ? status : undefined
}

function hasLegacyAtomicBatchCapability(value: unknown): boolean {
  return isRecord(value) && value.supported === true
}

function parseChainIdKey(value: string): number | undefined {
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) return undefined

  const chainId = Number(value)

  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : undefined
}

/**
 * Parse the capability object for one already-selected account and chain.
 * Unknown capability fields are ignored and malformed atomic data fails closed.
 */
export function parseWalletCapabilities(value: unknown): WalletCapabilities | undefined {
  if (!isRecord(value)) return undefined

  const atomicStatus = parseAtomicStatus(value.atomic)

  if (atomicStatus) return { atomic: { status: atomicStatus } }

  return hasLegacyAtomicBatchCapability(value.atomicBatch) ? { atomic: { status: 'supported' } } : {}
}

/**
 * Select one chain's entry from a raw wallet_getCapabilities response.
 * There is intentionally no "first entry" fallback: a response for another
 * chain must never enable batching on the active chain.
 */
export function getWalletCapabilitiesForChain(value: unknown, chainId: number): WalletCapabilities | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(chainId) || chainId <= 0) return undefined

  const matchingEntries = Object.entries(value).filter(([key]) => parseChainIdKey(key) === chainId)

  if (matchingEntries.length !== 1) return undefined

  return parseWalletCapabilities(matchingEntries[0][1])
}

export function hasAtomicBatchCapability(capabilities: WalletCapabilities | undefined): boolean {
  const status = capabilities?.atomic?.status

  return status === 'ready' || status === 'supported'
}

/** Validate wallet_sendCalls responses before exposing a batch identifier. */
export function getWalletCallsId(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value

  if (isRecord(value) && typeof value.id === 'string' && value.id.length > 0) return value.id

  throw new Error('Wallet returned an invalid batch identifier')
}
