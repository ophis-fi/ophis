export type AtomicBatchCapabilityStatus = 'ready' | 'supported' | 'unsupported'

export interface WalletCapabilities {
  readonly atomic?: {
    readonly status: AtomicBatchCapabilityStatus
  }
}

export type WalletCallsStatusCode = 100 | 200 | 400 | 500 | 600
export type WalletCallsStatusCategory = 'pending' | 'confirmed' | 'offchainFailure' | 'reverted' | 'partialFailure'

export interface WalletCallsStatus {
  readonly id: string
  readonly chainId: number
  readonly status: WalletCallsStatusCode
  readonly category: WalletCallsStatusCategory
  readonly atomic: boolean
  readonly transactionHashes: readonly string[]
}

export interface WalletCallInput {
  readonly to: string
  readonly data: string
  readonly value: string
  readonly operation?: number
}

export interface WalletSendCallsRequest {
  readonly version: '2.0.0'
  readonly from: string
  readonly chainId: string
  readonly atomicRequired: true
  readonly calls: readonly {
    readonly to: string
    readonly data: string
    readonly value: string
  }[]
}

const MAX_UINT256 = (1n << 256n) - 1n

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonzeroAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value)
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

function parseWalletCallsStatusCode(value: unknown): WalletCallsStatusCode | undefined {
  return value === 100 || value === 200 || value === 400 || value === 500 || value === 600 ? value : undefined
}

function parseExpectedWalletCallsId(value: unknown, expectedId: string): string | undefined {
  if (value === undefined) return getWalletCallsId(expectedId)

  return typeof value === 'string' && value === expectedId ? getWalletCallsId(value) : undefined
}

function parseExpectedWalletCallsChainId(value: unknown, expectedChainId: number): number | undefined {
  const chainId = typeof value === 'string' ? parseChainIdKey(value) : undefined

  return chainId === expectedChainId ? chainId : undefined
}

function parseAtomicExecution(value: unknown): true | undefined {
  return value === true ? true : undefined
}

function requireParsedValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Wallet returned an invalid batch status')

  return value
}

function getWalletCallsStatusCategory(status: WalletCallsStatusCode): WalletCallsStatusCategory {
  if (status === 100) return 'pending'
  if (status === 200) return 'confirmed'
  if (status === 400) return 'offchainFailure'
  if (status === 500) return 'reverted'

  return 'partialFailure'
}

interface WalletReceiptSummary {
  readonly transactionHashes: readonly string[]
  readonly allSuccessful: boolean
  readonly anySuccessful: boolean
}

function parseWalletReceipts(value: unknown): WalletReceiptSummary | undefined {
  if (value === undefined) return { transactionHashes: [], allSuccessful: false, anySuccessful: false }
  if (!Array.isArray(value)) return undefined

  const receipts = value.map((receipt) => {
    if (!isRecord(receipt)) return undefined

    const { transactionHash, status } = receipt

    return typeof transactionHash === 'string' &&
      /^0x[0-9a-f]+$/i.test(transactionHash) &&
      (status === '0x0' || status === '0x1')
      ? { transactionHash, successful: status === '0x1' }
      : undefined
  })

  if (
    !receipts.every(
      (receipt): receipt is { readonly transactionHash: string; readonly successful: boolean } => receipt !== undefined,
    )
  ) {
    return undefined
  }

  return {
    transactionHashes: receipts.map(({ transactionHash }) => transactionHash),
    allSuccessful: receipts.every(({ successful }) => successful),
    anySuccessful: receipts.some(({ successful }) => successful),
  }
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
  const id = isRecord(value) ? value.id : value

  if (typeof id === 'string' && /^0x[0-9a-f]+$/i.test(id) && id.length <= 8194) return id

  throw new Error('Wallet returned an invalid batch identifier')
}

/**
 * Validate a wallet_getCallsStatus response against the request that produced it.
 * Unknown status codes and mismatched identifiers/chains fail closed.
 */
export function parseWalletCallsStatus(value: unknown, expectedId: string, expectedChainId: number): WalletCallsStatus {
  if (!isRecord(value)) throw new Error('Wallet returned an invalid batch status')

  if (value.version !== '2.0.0') throw new Error('Wallet returned an invalid batch status')

  // EIP-5792 does not require wallet_getCallsStatus to echo the batch id. Bind
  // the parsed status to the validated request id, while rejecting a wallet
  // that does return a conflicting id as a non-standard extension.
  const id = requireParsedValue(parseExpectedWalletCallsId(value.id, expectedId))
  const chainId = requireParsedValue(parseExpectedWalletCallsChainId(value.chainId, expectedChainId))
  const status = requireParsedValue(parseWalletCallsStatusCode(value.status))
  const atomic = requireParsedValue(parseAtomicExecution(value.atomic))
  const receipts = requireParsedValue(parseWalletReceipts(value.receipts))

  if (status === 200 && (receipts.transactionHashes.length === 0 || !receipts.allSuccessful)) {
    throw new Error('Wallet returned an invalid confirmed batch receipt')
  }
  if ((status === 400 && receipts.transactionHashes.length > 0) || (status === 500 && receipts.anySuccessful)) {
    throw new Error('Wallet returned an unsafe retry batch receipt')
  }

  return {
    id,
    chainId,
    status,
    category: getWalletCallsStatusCategory(status),
    atomic,
    transactionHashes: receipts.transactionHashes,
  }
}

/** A stepped retry is safe only when the original batch cannot have partial effects. */
export function canSafelyRetryWalletCalls(status: WalletCallsStatus): boolean {
  return status.status === 400 || status.status === 500
}

export function buildWalletSendCallsRequest(
  calls: readonly WalletCallInput[],
  account: string,
  chainId: number,
): WalletSendCallsRequest {
  if (!isNonzeroAddress(account) || !Number.isSafeInteger(chainId) || chainId <= 0 || calls.length === 0) {
    throw new Error('Cannot build an invalid wallet call batch')
  }

  const normalizedCalls = calls.map(({ to, data, value, operation }) => {
    if (
      !isNonzeroAddress(to) ||
      !/^0x([0-9a-f]{2})*$/i.test(data) ||
      !/^(0x[0-9a-f]+|[0-9]+)$/i.test(value) ||
      (operation !== undefined && operation !== 0)
    ) {
      throw new Error('Wallet call batch supports direct calls only')
    }

    const parsedValue = BigInt(value)
    if (parsedValue > MAX_UINT256) throw new Error('Wallet call value exceeds uint256')

    return { to, data, value: `0x${parsedValue.toString(16)}` }
  })

  return {
    version: '2.0.0',
    from: account,
    chainId: `0x${chainId.toString(16)}`,
    atomicRequired: true,
    calls: normalizedCalls,
  }
}
