// Shared by the Pages proxy, web app, and CLI. No runtime dependencies.
export const ACROSS_V5_ADAPTER = '0x794dbdbdbfd3f8a3b887f4513bf5ff29edd04a94'
export const ACROSS_V5_STORE = 'function store(bytes32 witness,address token,uint256 amount)'
export const ACROSS_V5_STORED = 'event PrefundingStored(bytes32 indexed witness,address token,uint256 amount)'
export const ACROSS_V5_ORIGINS = [1, 10, 137, 4663, 8453, 42161, 57073, 59144]
export const ACROSS_V5_DESTINATIONS = [...ACROSS_V5_ORIGINS, 56, 5042, 9745, 43114]
export const ACROSS_V5_DEADLINE_MARGIN = 300

export const acrossAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
export const acrossOrderId = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
export const acrossAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 2n ** 256n

export interface AcrossV5Request {
  originChainId: number
  destinationChainId: number
  inputToken: string
  outputToken: string
  depositor: string
  recipient: string
  amount: string
}

export interface AcrossV5Quote {
  orderId: string
  expiresAt: number
  originValidUntil: number
  expectedFillTimeMs?: number
  amount: string
  expectedOutput: string
  minimumOutput: string
  grossOutput: string
  appFee: string
  depositData: string
}

export function acrossV5Request(value: unknown): AcrossV5Request {
  const q = value as AcrossV5Request | null
  if (
    !q || !ACROSS_V5_ORIGINS.includes(q.originChainId) ||
    !ACROSS_V5_DESTINATIONS.includes(q.destinationChainId) ||
    q.originChainId === q.destinationChainId ||
    ![q.inputToken, q.outputToken, q.depositor, q.recipient].every(acrossAddress) ||
    BigInt(q.inputToken) === 0n || BigInt(q.depositor) === 0n || BigInt(q.recipient) === 0n ||
    !acrossAmount(q.amount) || q.amount === '0'
  ) throw new Error('Invalid Across bridge request')
  return q
}

const matchesAddress = (value: unknown, expected: string): boolean =>
  acrossAddress(value) && value.toLowerCase() === expected.toLowerCase()

interface TokenRef {
  chainId?: unknown
  address?: unknown
}

interface QuoteResponse {
  amountType?: unknown
  orderId?: unknown
  expiresAt?: string
  originValidUntil?: string
  expectedFillTimeMs?: number
  origin?: { token?: TokenRef; amount?: unknown; maxAmount?: unknown; depositor?: { address?: unknown } }
  destination?: { token?: TokenRef; amount?: unknown; minAmount?: unknown; grossAmount?: unknown; recipient?: { address?: unknown } }
  fee?: { appFee?: { amount?: unknown } }
  refundTo?: { token?: TokenRef; refundAddress?: { address?: unknown } }[]
  nextActions?: Record<string, unknown>[]
}

export function acrossStoreData(orderId: string, token: string, amount: string): string {
  return `0x1e04ce08${orderId.slice(2)}${token.slice(2).padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`.toLowerCase()
}

export function parseAcrossV5Quote(value: unknown, request: AcrossV5Request, appFeeBps: number): AcrossV5Quote {
  const q = value as QuoteResponse | null
  const { origin, destination, nextActions, orderId } = q ?? {}
  const expiresAt = Date.parse(q?.expiresAt ?? '') / 1000
  const originValidUntil = Date.parse(q?.originValidUntil ?? '') / 1000
  const now = Date.now() / 1000
  const appFee = q?.fee?.appFee?.amount
  if (
    q?.amountType !== 'exact_input' || !acrossOrderId(orderId) ||
    !(expiresAt > now && originValidUntil > expiresAt) ||
    origin?.token?.chainId !== request.originChainId || !matchesAddress(origin.token.address, request.inputToken) ||
    origin.amount !== request.amount || origin.maxAmount !== request.amount ||
    !matchesAddress(origin.depositor?.address, request.depositor) ||
    destination?.token?.chainId !== request.destinationChainId || !matchesAddress(destination.token.address, request.outputToken) ||
    !matchesAddress(destination.recipient?.address, request.recipient) ||
    !acrossAmount(destination.amount) || !acrossAmount(destination.minAmount) || !acrossAmount(destination.grossAmount) ||
    BigInt(destination.minAmount) <= 0n || BigInt(destination.minAmount) > BigInt(destination.amount) ||
    BigInt(destination.grossAmount) <= 0n ||
    !acrossAmount(appFee) || (appFeeBps > 0 ? appFee === '0' : appFee !== '0') ||
    !Array.isArray(q.refundTo) || q.refundTo.some((r) => {
      const chain = r?.token?.chainId
      return chain === request.originChainId
        ? !matchesAddress(r.token?.address, request.inputToken) || !matchesAddress(r.refundAddress?.address, request.depositor)
        : chain !== request.destinationChainId || !matchesAddress(r.refundAddress?.address, request.recipient)
    }) ||
    !Array.isArray(nextActions) || nextActions.length < 1 || nextActions.length > 3
  ) throw new Error('Unexpected Across quote')

  const depositData = acrossStoreData(orderId, request.inputToken, request.amount)
  const deposit = nextActions.at(-1)
  if (
    deposit?.kind !== 'send_transaction' || deposit.id !== 'prefunded-store' || deposit.ecosystem !== 'evm' ||
    deposit.chainId !== request.originChainId || !matchesAddress(deposit.to, ACROSS_V5_ADAPTER) ||
    deposit.value !== '0' || typeof deposit.data !== 'string' || deposit.data.toLowerCase() !== depositData ||
    nextActions.slice(0, -1).some((a, i, approvals) =>
      a?.kind !== 'approve_token' || a.ecosystem !== 'evm' || a.chainId !== request.originChainId ||
      !matchesAddress(a.tokenAddress, request.inputToken) || !matchesAddress(a.spender, ACROSS_V5_ADAPTER) ||
      (i === approvals.length - 1 ? a.id !== 'approval' || a.amount !== request.amount : a.id !== 'approval-reset' || a.amount !== '0'),
    )
  ) throw new Error('Unexpected Across deposit actions')

  return {
    orderId, expiresAt: Math.floor(expiresAt), originValidUntil: Math.floor(originValidUntil),
    expectedFillTimeMs: Number.isSafeInteger(q.expectedFillTimeMs) && Number(q.expectedFillTimeMs) >= 0 ? q.expectedFillTimeMs : undefined,
    amount: request.amount,
    expectedOutput: destination.amount,
    minimumOutput: destination.minAmount,
    grossOutput: destination.grossAmount,
    appFee, depositData,
  }
}

// Leave the same 0.1% margin the existing hook allows for order fees and rounding.
export const acrossV5FixedAmount = (amount: bigint): bigint => (amount * 9_990n) / 10_000n

export function checkAcrossV5Deposit(quote: AcrossV5Quote, request: AcrossV5Request, now = Date.now() / 1000): void {
  if (
    !acrossOrderId(quote?.orderId) || quote.amount !== request.amount ||
    !Number.isSafeInteger(quote.expiresAt) || !Number.isSafeInteger(quote.originValidUntil) ||
    (now > 0 && !(quote.expiresAt > now && quote.originValidUntil > quote.expiresAt)) ||
    ![quote.expectedOutput, quote.minimumOutput, quote.grossOutput, quote.appFee].every(acrossAmount) ||
    BigInt(quote.minimumOutput) <= 0n || BigInt(quote.minimumOutput) > BigInt(quote.expectedOutput) ||
    BigInt(quote.grossOutput) <= 0n ||
    quote.depositData !== acrossStoreData(quote.orderId, request.inputToken, request.amount)
  ) throw new Error('Invalid or expired Across bridge quote')
}

export interface AcrossV5Status {
  status: 'executed' | 'in_progress' | 'refund' | 'expired' | 'unknown'
  depositTxHash?: string
  fillTxHash?: string
  fillTimeInSeconds?: number
  destination?: { chainId: number; token: string; recipient: string; amount: string }
  refund?: { chainId: number; token: string; recipient: string }
}

export function parseAcrossV5Status(value: unknown, orderId: string): AcrossV5Status {
  const transfer = value as {
    orderId?: string
    status?: { state?: string; isTerminal?: boolean }
    fillTimeMs?: number
    destination?: { output?: { token?: TokenRef; amount?: unknown }; recipient?: { address?: unknown } }
    refund?: { chain?: { chainId?: unknown }; output?: { token?: TokenRef }; recipient?: { address?: unknown } }
    transactions?: { type?: string; transaction?: { txnRef?: unknown } }[]
  } | null
  if (transfer?.orderId?.toLowerCase() !== orderId.toLowerCase()) return { status: 'unknown' }
  const entries = Array.isArray(transfer.transactions) ? transfer.transactions : []
  const tx = (type: string): string | undefined => {
    const hash = entries.find((entry) => entry?.type === type)?.transaction?.txnRef
    return acrossOrderId(hash) ? hash : undefined
  }
  const state = transfer.status?.state
  const status = transfer.status?.isTerminal === true
    ? ({ completed: 'executed', refunded: 'refund', failed: 'expired' } as const)[state as 'completed' | 'refunded' | 'failed'] ?? 'unknown'
    : state === 'pending' ? 'in_progress' : 'unknown'
  const output = transfer.destination?.output
  const recipient = transfer.destination?.recipient?.address
  const destination = typeof output?.token?.chainId === 'number' && acrossAddress(output.token.address) &&
    acrossAddress(recipient) && acrossAmount(output.amount)
    ? { chainId: output.token.chainId, token: output.token.address, recipient, amount: output.amount }
    : undefined
  const refundChain = transfer.refund?.chain?.chainId
  const refundToken = transfer.refund?.output?.token?.address
  const refundRecipient = transfer.refund?.recipient?.address
  const refund = status === 'refund' && typeof refundChain === 'number' && Number.isSafeInteger(refundChain) &&
    acrossAddress(refundToken) && acrossAddress(refundRecipient)
    ? { chainId: refundChain, token: refundToken, recipient: refundRecipient }
    : undefined
  return {
    destination, refund,
    status, depositTxHash: tx('deposit'), fillTxHash: tx(state === 'refunded' ? 'refund' : 'fill'),
    fillTimeInSeconds: Number.isSafeInteger(transfer.fillTimeMs) ? Number(transfer.fillTimeMs) / 1000 : undefined,
  }
}
