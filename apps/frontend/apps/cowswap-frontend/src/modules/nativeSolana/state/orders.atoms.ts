import { atom } from 'jotai'
import { atomFamily, atomWithStorage } from 'jotai/utils'

import {
  fetchOphisSolanaOrder,
  identifyOphisSolanaOrder,
  readOphisOrderAccount,
  readOphisSellAllowance,
  getOrderIntentDecoder,
  getOrderIntentEncoder,
  ophisSolanaWalletSigner,
  prepareOphisSolanaCancellation,
  prepareOphisSolanaReclaim,
  sendOphisSolanaWalletTransaction,
  solanaAddress,
  OphisSolanaHttpError,
  checkOphisSolanaCreation,
  fetchOphisWalletActionContext,
  checkOphisWalletAction,
  type OphisSolanaOrder,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { atomWithQuery, queryClientAtom } from 'jotai-tanstack-query'

import {
  clearNativeSolanaReviewAtom,
  nativeSolanaBusyAtom,
  nativeSolanaErrorAtom,
  nativeSolanaReviewAtom,
} from './trade.atoms'

import { balanceEndpoint, mainnetWalletRpc } from '../services/assets.service'
import { privateAction, privateSettlementEnabled, privateWalletRpc } from '../services/privateSettlement.service'
import {
  checkLocalBackpackRpc,
  nativeSolanaContext,
  nativeSolanaErrorMessage,
  prepareReviewedSolanaOrder,
} from '../services/trade.service'

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

async function lookupMissingCreation(order: SavedNativeSolanaOrder): Promise<'pending' | 'failed' | 'unconfirmed'> {
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
      queryFn: async () => {
        try {
          return await getOrderStatus(uid, order)
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

const placeNativeSolanaOrderAtom = atom(null, async (get, set, replaceAllowance: boolean) => {
  const review = get(nativeSolanaReviewAtom)
  const config = OPHIS_SOLANA_CONFIG
  if (!review || !config || get(nativeSolanaBusyAtom)) return
  set(nativeSolanaBusyAtom, true)
  set(nativeSolanaErrorAtom, null)
  try {
    const { connection } = review
    checkLocalBackpackRpc(config, connection)
    const order = await prepareReviewedSolanaOrder(config, review)
    const rpc = balanceEndpoint(config)
    if (!rpc) throw Error('Wallet balance service unavailable.')
    const allowance = await readOphisSellAllowance(
      rpc,
      config.genesis,
      solanaAddress(connection.account.address),
      review.sell,
    )
    if (allowance?.delegate !== review.allowance?.delegate || allowance?.atoms !== review.allowance?.atoms)
      throw Error('Your token spending allowance changed. Request a new quote.')
    if (allowance && !replaceAllowance) throw Error('Review the existing token allowance before continuing.')
    const live = get(visibleNativeSolanaOrdersAtom).filter((saved) => {
      const intent = getOrderIntentDecoder().decode(Uint8Array.from(saved.intent))
      return (
        !saved.reclaimed &&
        Date.now() < intent.validTo * 1000 &&
        intent.sellTokenAccount === order.intent.sellTokenAccount
      )
    })
    for (const saved of live) {
      const { account: current } = await readOphisOrderAccount(
        rpc,
        config.genesis,
        config.program,
        saved.uid,
        solanaAddress(saved.orderPda),
      )
      const pending = current
        ? !current.cancelled && current.amountWithdrawn < current.intent.sellAmount
        : saved.creationLifetime && (await lookupMissingCreation(saved)) === 'pending'
      if (pending)
        throw Error('This token account has a pending order. Let it finish or cancel it before placing another.')
    }
    const context = await nativeSolanaContext(config)
    if (get(nativeSolanaReviewAtom) !== review) throw Error('The wallet or trade changed. Request a new quote.')
    const record: SavedNativeSolanaOrder = {
      uid: order.uid,
      owner: connection.account.address,
      program: config.program,
      genesis: config.genesis,
      orderPda: order.orderPda,
      createdBy: order.payer,
      intent: Array.from(getOrderIntentEncoder().encode(order.intent)),
      signature: null,
      ...(config.chain === 'solana:localnet'
        ? {}
        : {
            creationLifetime: { height: context.lastValidBlockHeight.toString(), requestedAt: Date.now() },
          }),
      reclaimed: false,
    }
    if (privateSettlementEnabled && (await privateAction<{ automatic: boolean }>('mode', {})).automatic) {
      await privateAction('arm', { uid: order.uid, pda: order.orderPda, intent: record.intent })
    }
    const signature = await sendOphisSolanaWalletTransaction({
      ...connection,
      chain: config.chain,
      instructions: order.instructions,
      onBeforeBroadcast: () => {
        if (!get(savedNativeSolanaOrdersAtom)[order.uid])
          set(savedNativeSolanaOrdersAtom, { ...get(savedNativeSolanaOrdersAtom), [order.uid]: record })
      },
      context,
      programAddress: config.program,
      expectedGenesisHash: config.genesis,
    })
    set(savedNativeSolanaOrdersAtom, { ...get(savedNativeSolanaOrdersAtom), [order.uid]: { ...record, signature } })
    set(clearNativeSolanaReviewAtom)
  } catch (error: unknown) {
    set(nativeSolanaErrorAtom, nativeSolanaErrorMessage(error))
  } finally {
    set(nativeSolanaBusyAtom, false)
  }
})

export const createNativeSolanaOrderAtom = atom(null, async (get, set, replaceAllowance: boolean = false) => {
  const wallet = get(solanaConnectionAtom)
  if (!wallet || !navigator.locks) return set(placeNativeSolanaOrderAtom, replaceAllowance)
  await navigator.locks.request('ophis-solana-place:' + wallet.account.address, { ifAvailable: true }, async (lock) => {
    if (lock) await set(placeNativeSolanaOrderAtom, replaceAllowance)
    else set(nativeSolanaErrorAtom, 'Another tab is already placing an order for this wallet.')
  })
})

export const orderActionMessageAtom = atomFamily((_uid: string) => atom<{ text: string; error?: boolean } | null>(null))

const ownerRpc = () => privateWalletRpc ?? balanceEndpoint(OPHIS_SOLANA_CONFIG)

export const orderActionReceiptAtom = atomFamily((uid: string) =>
  atomWithQuery((get) => {
    const order = get(visibleNativeSolanaOrdersAtom).find((record) => record.uid === uid)
    const action = order?.walletAction
    return {
      queryKey: ['ophisSolanaAction', order?.genesis, uid, action?.signature, action?.lastHeight, action?.reclaim],
      enabled: action?.status === 'pending',
      queryFn: async () => {
        const rpc = ownerRpc()
        if (!rpc || !action || !order) throw Error('Reconnect to check the transaction.')
        const status = await checkOphisWalletAction(rpc, order.genesis, action.signature, BigInt(action.lastHeight))
        if (action.signature && status !== 'confirmed') return status
        const { account, slot } = await readOphisOrderAccount(
          rpc,
          order.genesis,
          solanaAddress(order.program),
          uid,
          solanaAddress(order.orderPda),
          'finalized',
        )
        if (action.observedSlot && slot < BigInt(action.observedSlot)) return 'pending'
        const canProveClosure = !!action.observedSlot || (action.signature !== null && status === 'confirmed')
        if (action.reclaim ? account === null && canProveClosure : account?.cancelled) return 'confirmed'
        return status === 'confirmed' ? 'failed' : status
      },
      refetchInterval: 5000,
      retry: false,
    }
  }),
)

export const recordOrderActionAtom = atom(
  null,
  (
    get,
    set,
    result: {
      uid: string
      signature: string | null
      lastHeight: string
      status: 'confirmed' | 'failed' | 'expired'
    },
  ) => {
    const all = get(savedNativeSolanaOrdersAtom)
    const order = all[result.uid]
    const action = order?.walletAction
    if (
      !action ||
      action.signature !== result.signature ||
      action.lastHeight !== result.lastHeight ||
      action.status !== 'pending'
    )
      return
    set(savedNativeSolanaOrdersAtom, {
      ...all,
      [result.uid]: {
        ...order,
        walletAction: { ...action, status: result.status },
        reclaimed: action.reclaim && result.status === 'confirmed',
      },
    })
    if (result.status === 'confirmed')
      void get(queryClientAtom).invalidateQueries({
        queryKey: ['ophisSolanaOrder', OPHIS_SOLANA_CONFIG?.api, order.genesis, result.uid],
      })
  },
)

export const manageNativeSolanaOrderAtom = atom(null, async (get, set, action: { uid: string; reclaim: boolean }) => {
  const config = OPHIS_SOLANA_CONFIG
  const connection = get(solanaConnectionAtom)
  const order = get(visibleNativeSolanaOrdersAtom).find((candidate) => candidate.uid === action.uid)
  if (
    !config ||
    !connection ||
    !order ||
    order.reclaimed ||
    order.walletAction?.status === 'pending' ||
    get(nativeSolanaBusyAtom)
  )
    return
  set(nativeSolanaBusyAtom, true)
  const message = orderActionMessageAtom(order.uid)
  set(message, { text: 'Preparing your wallet request…' })
  try {
    checkLocalBackpackRpc(config, connection)
    const intent = getOrderIntentDecoder().decode(new Uint8Array(order.intent))
    if (intent.owner !== connection.account.address) throw Error('Reconnect the order owner.')
    const identity = await identifyOphisSolanaOrder(config.program, intent)
    if (identity.uid !== order.uid || identity.orderPda !== order.orderPda)
      throw Error('Saved order identity mismatch.')
    const rpc = ownerRpc()
    if (!rpc) throw Error('Order recovery RPC is unavailable.')
    const { account: chain, slot: observedSlot } = await readOphisOrderAccount(
      rpc,
      config.genesis,
      config.program,
      identity.uid,
      identity.orderPda,
      'finalized',
    )
    if (!chain) throw Error('The order is unavailable at finality. Refresh its status before retrying.')
    const owner = ophisSolanaWalletSigner(connection.account)
    const instruction = action.reclaim
      ? prepareOphisSolanaReclaim({
          programAddress: config.program,
          owner,
          orderPda: identity.orderPda,
          createdBy: chain.createdBy,
        })
      : await prepareOphisSolanaCancellation({ programAddress: config.program, owner, intent, existingOnly: true })
    const context = await fetchOphisWalletActionContext(rpc, config.program, config.genesis)
    if (get(solanaConnectionAtom) !== connection) throw Error('The wallet changed. Try again.')
    set(message, {
      text: action.reclaim ? 'Review the storage refund in your wallet.' : 'Review the cancellation in your wallet.',
    })
    const saveAction = (signature: string | null) => {
      set(savedNativeSolanaOrdersAtom, (all) => ({
        ...all,
        [order.uid]: {
          ...all[order.uid],
          walletAction: {
            reclaim: action.reclaim,
            signature,
            lastHeight: String(context.lastValidBlockHeight),
            observedSlot: String(observedSlot),
            status: 'pending',
          },
        },
      }))
    }
    const signature = await sendOphisSolanaWalletTransaction({
      onBeforeBroadcast: () => saveAction(null),
      ...connection,
      chain: config.chain,
      instructions: [instruction],
      context,
      programAddress: config.program,
      expectedGenesisHash: config.genesis,
    })
    saveAction(signature)
    set(message, null)
  } catch (error: unknown) {
    set(message, { text: nativeSolanaErrorMessage(error), error: true })
  } finally {
    set(nativeSolanaBusyAtom, false)
  }
})
