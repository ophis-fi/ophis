import { atom } from 'jotai'
import { atomFamily, atomWithStorage } from 'jotai/utils'

import {
  checkOphisSolanaCreation,
  fetchOphisSolanaOrder,
  OphisSolanaHttpError,
  readOphisOrderAccount,
  solanaAddress,
  type OphisSolanaOrder,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom, type OphisSolanaConfig } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

import { balanceEndpoint, mainnetWalletRpc, walletHoldingsKey } from '../services/assets.service'
import { checkAtomicReceipt, validAtomicOrder, orderPollInterval } from '../services/atomicReceipt.service'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'

export interface SavedNativeSolanaOrder {
  uid: string
  executionMode?: 'walletAtomic'
  walletCosts?: {
    networkFee: string
    orderRent: string
    nativeWrapRent?: string
    solverInputRent?: string
    maxProtocolFeeLamports?: string
  }
  owner: string
  program: string
  genesis: string
  orderPda: string
  createdBy: string
  intent: number[]
  signature: string | null
  creationLifetime?: { height: string; requestedAt: number; blockhash?: string }
  reclaimed: boolean
  walletAction?: {
    reclaim: boolean
    signature: string | null
    lastHeight: string
    observedSlot?: string
    status: 'pending' | 'confirmed' | 'failed' | 'expired'
  }
}

function isIntentBytes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 213 &&
    value.every((byte: unknown) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
}

function validWalletAction(action: SavedNativeSolanaOrder['walletAction']): boolean {
  if (!action) return true
  return (
    typeof action.reclaim === 'boolean' &&
    (action.signature === null || /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(action.signature)) &&
    /^\d{1,20}$/.test(action.lastHeight) &&
    (action.observedSlot === undefined || /^\d{1,20}$/.test(action.observedSlot)) &&
    ['pending', 'confirmed', 'failed', 'expired'].includes(action.status)
  )
}

function isSavedOrder(value: unknown): value is SavedNativeSolanaOrder {
  if (!value || typeof value !== 'object') return false
  const order = value as Partial<SavedNativeSolanaOrder>
  return (
    /^0x[0-9a-f]{64}$/.test(String(order.uid)) &&
    (['uid', 'owner', 'program', 'genesis', 'orderPda', 'createdBy'] as const).every(
      (key) => typeof order[key] === 'string',
    ) &&
    validAtomicOrder(order) &&
    typeof order.reclaimed === 'boolean' &&
    (order.signature === null || typeof order.signature === 'string') &&
    validWalletAction(order.walletAction) &&
    isIntentBytes(order.intent)
  )
}

// Only public order data is persisted, including the exact intent needed after a reload.
export const savedNativeSolanaOrdersAtom = atomWithStorage<Record<string, SavedNativeSolanaOrder>>(
  'ophisSolanaOrders:v0',
  {},
)
export const activeSolanaReceiptAtom = atom<string | null>(null)
export const visibleNativeSolanaOrdersAtom = atom((get) => {
  const owner = get(solanaConnectionAtom)?.account.address
  const config = OPHIS_SOLANA_CONFIG
  return Object.values(get(savedNativeSolanaOrdersAtom) || {})
    .filter(isSavedOrder)
    .filter(
      (order) =>
        order &&
        order.owner === owner &&
        order.program === config?.program &&
        order.genesis === config?.genesis &&
        (!order.reclaimed || order.walletAction?.status === 'confirmed'),
    )
})

function shouldCheckSubmission(lifetime: SavedNativeSolanaOrder['creationLifetime']): boolean {
  return !!lifetime && Date.now() - lifetime.requestedAt >= 90_000
}

export async function lookupMissingCreation(
  order: SavedNativeSolanaOrder,
): Promise<'pending' | 'failed' | 'unconfirmed'> {
  const lifetime = order.creationLifetime
  const rpc = balanceEndpoint(OPHIS_SOLANA_CONFIG)
  if (!rpc || !lifetime || !shouldCheckSubmission(lifetime) || !/^\d{1,20}$/.test(lifetime.height)) return 'pending'
  return checkOphisSolanaCreation(
    rpc,
    order.genesis,
    order.signature,
    solanaAddress(order.orderPda),
    BigInt(lifetime.height),
  )
}

export type SolverAttemptState = 'searching' | 'inactive' | 'pending' | 'confirmed' | 'failed' | 'expired' | 'unknown'
type OrderWithAttempt = OphisSolanaOrder & {
  payoutConfirmed?: boolean
  settlementAttempt?: { state: SolverAttemptState }
}

function balanceState(order?: SolanaOrderResult): SolanaOrderResult['status'] | undefined {
  return order && 'payoutConfirmed' in order && order.payoutConfirmed ? 'fulfilled' : order?.status
}

async function readOrderStatus(
  config: OphisSolanaConfig,
  order: SavedNativeSolanaOrder,
  error: unknown,
): Promise<OphisSolanaOrder> {
  const uid = order.uid
  const rpc = balanceEndpoint(config)
  if (!rpc) throw error
  const { account: chain } = await readOphisOrderAccount(
    rpc,
    config.genesis,
    config.program,
    uid,
    solanaAddress(order.orderPda),
  )
  if (!chain) throw error
  const intent = chain.intent
  const filled = chain.amountWithdrawn === intent.sellAmount && chain.amountReceived >= intent.buyAmount
  return {
    uid,
    owner: intent.owner,
    orderPda: solanaAddress(order.orderPda),
    sellToken: intent.sellMint,
    buyToken: intent.buyMint,
    sellAmount: String(intent.sellAmount),
    buyAmount: String(intent.buyAmount),
    executedSellAmount: String(chain.amountWithdrawn),
    executedBuyAmount: String(chain.amountReceived),
    status: filled
      ? 'fulfilled'
      : chain.cancelled
        ? 'cancelled'
        : intent.validTo <= Date.now() / 1000
          ? 'expired'
          : 'open',
  }
}

async function checkOrderPayout(
  rpc: string,
  config: OphisSolanaConfig,
  result: OphisSolanaOrder,
): Promise<OrderWithAttempt> {
  const chain = (
    await readOphisOrderAccount(rpc, config.genesis, config.program, result.uid, result.orderPda).catch(() => null)
  )?.account
  if (chain?.cancelled) return { ...result, status: 'cancelled' }
  const payoutConfirmed =
    !!chain && chain.amountWithdrawn === chain.intent.sellAmount && chain.amountReceived >= chain.intent.buyAmount
  return { ...result, payoutConfirmed }
}

function hasRecentOpenOrder(status: OphisSolanaOrder['status'], order: SavedNativeSolanaOrder): boolean {
  return status === 'open' && !!order.creationLifetime && Date.now() - order.creationLifetime.requestedAt < 300_000
}

async function getOrderStatus(uid: string, order?: SavedNativeSolanaOrder): Promise<OrderWithAttempt> {
  if (!order) throw Error('Order configuration is unavailable.')
  if (privateSettlementEnabled) {
    const receipt = await privateAction<OrderWithAttempt | null>('order', { uid, pda: order.orderPda })
    if (receipt) return receipt
  }
  const config = OPHIS_SOLANA_CONFIG
  if (!config) throw Error('Order configuration is unavailable.')
  let result: OphisSolanaOrder
  try {
    result = await fetchOphisSolanaOrder(config.api, uid)
  } catch (error) {
    return readOrderStatus(config, order, error)
  }
  if (result.owner !== order.owner || result.orderPda !== order.orderPda)
    throw Error('Indexed order identity mismatch.')
  const rpc = mainnetWalletRpc(config)
  if (rpc && hasRecentOpenOrder(result.status, order)) {
    return checkOrderPayout(rpc, config, result)
  }
  return result
}

export type SolanaOrderResult = OrderWithAttempt | { status: 'failed' | 'unconfirmed' | 'pending' | 'fulfilled' }

export const nativeSolanaOrderQueryAtom = atomFamily((uid: string) =>
  atomWithQuery<SolanaOrderResult>((get) => {
    const order = get(visibleNativeSolanaOrdersAtom).find((candidate) => candidate.uid === uid)
    return {
      queryKey: [
        'ophisSolanaOrder',
        OPHIS_SOLANA_CONFIG?.api,
        OPHIS_SOLANA_CONFIG?.genesis,
        uid,
        ...(order?.executionMode === 'walletAtomic' ? [order.signature] : []),
      ],
      queryFn: async ({ client, queryKey }) => {
        try {
          const result =
            order?.executionMode === 'walletAtomic' ? await checkAtomicReceipt(order) : await getOrderStatus(uid, order)
          const previous = client.getQueryData<OrderWithAttempt>(queryKey)
          if (order && balanceState(result) !== balanceState(previous)) {
            void client.invalidateQueries({ queryKey: walletHoldingsKey(order.genesis, order.owner) })
          }
          return result
        } catch (error) {
          if (error instanceof OphisSolanaHttpError && error.status === 404 && order) {
            const status = await lookupMissingCreation(order)
            if (status !== 'pending') return { status }
          }
          throw error
        }
      },
      enabled: !!OPHIS_SOLANA_CONFIG && !!order && !order.reclaimed,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (query) =>
        orderPollInterval(query.state.data?.status, order, shouldCheckSubmission(order?.creationLifetime)),
    }
  }),
)
