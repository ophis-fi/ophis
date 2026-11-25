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
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

import { balanceEndpoint, mainnetWalletRpc, walletHoldingsKey } from '../services/assets.service'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'

export interface SavedNativeSolanaOrder {
  uid: string
  owner: string
  program: string
  genesis: string
  orderPda: string
  createdBy: string
  intent: number[]
  signature: string | null
  creationLifetime?: { height: string; requestedAt: number }
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

function isSavedOrder(value: unknown): value is SavedNativeSolanaOrder {
  if (!value || typeof value !== 'object') return false
  const order = value as Partial<SavedNativeSolanaOrder>
  return (
    typeof order.uid === 'string' &&
    /^0x[0-9a-f]{64}$/.test(order.uid) &&
    (['owner', 'program', 'genesis', 'orderPda', 'createdBy'] as const).every(
      (key) => typeof order[key] === 'string',
    ) &&
    typeof order.reclaimed === 'boolean' &&
    (order.signature === null || typeof order.signature === 'string') &&
    (!order.walletAction ||
      (typeof order.walletAction.reclaim === 'boolean' &&
        (order.walletAction.signature === null || /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(order.walletAction.signature)) &&
        /^\d{1,20}$/.test(order.walletAction.lastHeight) &&
        (order.walletAction.observedSlot === undefined || /^\d{1,20}$/.test(order.walletAction.observedSlot)) &&
        ['pending', 'confirmed', 'failed', 'expired'].includes(order.walletAction.status))) &&
    isIntentBytes(order.intent)
  )
}

// Only public order data is persisted, including the exact intent needed after a reload.
export const savedNativeSolanaOrdersAtom = atomWithStorage<Record<string, SavedNativeSolanaOrder>>(
  'ophisSolanaOrders:v0',
  {},
)
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

export async function lookupMissingCreation(order: SavedNativeSolanaOrder): Promise<'pending' | 'failed' | 'unconfirmed'> {
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

function balanceState(order?: OrderWithAttempt): OphisSolanaOrder['status'] | undefined {
  return order?.payoutConfirmed ? 'fulfilled' : order?.status
}

async function getOrderStatus(uid: string, order?: SavedNativeSolanaOrder): Promise<OrderWithAttempt> {
  if (privateSettlementEnabled && order) {
    const receipt = await privateAction<OrderWithAttempt | null>('order', { uid, pda: order.orderPda })
    if (receipt) return receipt
  }
  const config = OPHIS_SOLANA_CONFIG
  if (!config || !order) throw Error('Order configuration is unavailable.')
  let result: OphisSolanaOrder
  try {
    result = await fetchOphisSolanaOrder(config.api, uid)
  } catch (error) {
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
  if (result.owner !== order.owner || result.orderPda !== order.orderPda)
    throw Error('Indexed order identity mismatch.')
  const rpc = mainnetWalletRpc(OPHIS_SOLANA_CONFIG)
  if (
    result.status === 'open' &&
    order?.creationLifetime &&
    Date.now() - order.creationLifetime.requestedAt < 300_000 &&
    OPHIS_SOLANA_CONFIG &&
    rpc
  ) {
    const chain = (
      await readOphisOrderAccount(rpc, config.genesis, config.program, uid, result.orderPda).catch(() => null)
    )?.account
    if (chain?.cancelled) return { ...result, status: 'cancelled' }
    const payoutConfirmed =
      !!chain && chain.amountWithdrawn === chain.intent.sellAmount && chain.amountReceived >= chain.intent.buyAmount
    return { ...result, payoutConfirmed }
  }
  return result
}

export const nativeSolanaOrderQueryAtom = atomFamily((uid: string) =>
  atomWithQuery<OrderWithAttempt | { status: 'failed' | 'unconfirmed' }>((get) => {
    const order = get(visibleNativeSolanaOrdersAtom).find((candidate) => candidate.uid === uid)
    return {
      queryKey: ['ophisSolanaOrder', OPHIS_SOLANA_CONFIG?.api, OPHIS_SOLANA_CONFIG?.genesis, uid],
      queryFn: async ({ client, queryKey }) => {
        try {
          const result = await getOrderStatus(uid, order)
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
      refetchInterval: (query) => {
        if (query.state.data) return query.state.data.status === 'open' ? 4000 : false
        if (!order?.signature && !order?.creationLifetime) return false
        return shouldCheckSubmission(order.creationLifetime) ? 15000 : 4000
      },
    }
  }),
)
