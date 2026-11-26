import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'

import {
  fetchOphisWalletActionReceipt,
  fetchOphisWalletActionContext,
  getOrderIntentDecoder,
  identifyOphisSolanaOrder,
  ophisSolanaWalletSigner,
  prepareOphisSolanaCancellation,
  prepareOphisSolanaReclaim,
  readOphisOrderAccount,
  sendOphisSolanaWalletTransaction,
  solanaAddress,
  type OphisSolanaChainContext,
} from '@ophis/solana-sdk'
import {
  OPHIS_SOLANA_CONFIG,
  solanaConnectionAtom,
  type OphisSolanaConfig,
  type SolanaConnection,
} from 'entities/solana'
import { atomWithQuery, queryClientAtom } from 'jotai-tanstack-query'

import { savedNativeSolanaOrdersAtom, visibleNativeSolanaOrdersAtom, type SavedNativeSolanaOrder } from './orders.atoms'
import { nativeSolanaBusyAtom } from './trade.atoms'

import { balanceEndpoint, walletHoldingsKey } from '../services/assets.service'
import { privateWalletRpc } from '../services/privateSettlement.service'
import { checkLocalBackpackRpc, nativeSolanaErrorMessage } from '../services/trade.service'

export const orderActionMessageAtom = atomFamily((_uid: string) => atom<{ text: string; error?: boolean } | null>(null))

const ownerRpc = (): string | undefined => privateWalletRpc ?? balanceEndpoint(OPHIS_SOLANA_CONFIG)

type WalletAction = NonNullable<SavedNativeSolanaOrder['walletAction']>

function snapshotIsCurrent(slot: bigint, action: WalletAction, receiptSlot?: bigint): boolean {
  return slot >= (receiptSlot ?? 0n) && slot >= BigInt(action.observedSlot ?? 0)
}

async function checkWalletActionAccount(
  rpc: string,
  order: SavedNativeSolanaOrder,
  action: WalletAction,
  status: WalletAction['status'],
  receiptSlot?: bigint,
): Promise<WalletAction['status']> {
  const { account, slot } = await readOphisOrderAccount(
    rpc,
    order.genesis,
    solanaAddress(order.program),
    order.uid,
    solanaAddress(order.orderPda),
    'finalized',
  )
  if (!snapshotIsCurrent(slot, action, receiptSlot)) return 'pending'
  const canProveClosure = !!action.observedSlot || status === 'confirmed'
  if (action.reclaim ? account === null && canProveClosure : account?.cancelled) return 'confirmed'
  return status === 'confirmed' ? 'failed' : status
}

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
        const { status, slot: receiptSlot } = await fetchOphisWalletActionReceipt(
          rpc,
          order.genesis,
          action.signature,
          BigInt(action.lastHeight),
        )
        if (action.signature && status !== 'confirmed') return status
        return checkWalletActionAccount(rpc, order, action, status, receiptSlot)
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
    if (result.status === 'confirmed') {
      const client = get(queryClientAtom)
      void client.invalidateQueries({ queryKey: walletHoldingsKey(order.genesis, order.owner) })
      void client.invalidateQueries({
        queryKey: ['ophisSolanaOrder', OPHIS_SOLANA_CONFIG?.api, order.genesis, result.uid],
      })
    }
  },
)

async function prepareOrderAction(
  config: OphisSolanaConfig,
  connection: SolanaConnection,
  order: SavedNativeSolanaOrder,
  reclaim: boolean,
): Promise<{
  instruction: Parameters<typeof sendOphisSolanaWalletTransaction>[0]['instructions'][number]
  context: OphisSolanaChainContext
  observedSlot: bigint
}> {
  if (order.executionMode === 'walletAtomic') throw Error('This swap returns its order deposit automatically.')
  const intent = getOrderIntentDecoder().decode(new Uint8Array(order.intent))
  if (intent.owner !== connection.account.address) throw Error('Reconnect the order owner.')
  const identity = await identifyOphisSolanaOrder(config.program, intent)
  if (identity.uid !== order.uid || identity.orderPda !== order.orderPda) throw Error('Saved order identity mismatch.')
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
  const instruction = reclaim
    ? prepareOphisSolanaReclaim({
        programAddress: config.program,
        owner,
        orderPda: identity.orderPda,
        createdBy: chain.createdBy,
      })
    : await prepareOphisSolanaCancellation({ programAddress: config.program, owner, intent, existingOnly: true })
  const context = await fetchOphisWalletActionContext(rpc, config.program, config.genesis)
  return { instruction, context, observedSlot }
}

export const manageNativeSolanaOrderAtom = atom(null, async (get, set, action: { uid: string; reclaim: boolean }) => {
  const config = OPHIS_SOLANA_CONFIG
  const connection = get(solanaConnectionAtom)
  const order = get(visibleNativeSolanaOrdersAtom).find(
    (candidate) => candidate.uid === action.uid && !candidate.reclaimed && candidate.walletAction?.status !== 'pending',
  )
  if (!config || !connection || !order || get(nativeSolanaBusyAtom)) return
  set(nativeSolanaBusyAtom, true)
  const message = orderActionMessageAtom(order.uid)
  set(message, { text: 'Preparing your wallet request…' })
  try {
    checkLocalBackpackRpc(config, connection)
    const { instruction, context, observedSlot } = await prepareOrderAction(config, connection, order, action.reclaim)
    if (get(solanaConnectionAtom) !== connection) throw Error('The wallet changed. Try again.')
    set(message, {
      text: action.reclaim ? 'Review the storage refund in your wallet.' : 'Review the cancellation in your wallet.',
    })
    const saveAction = (signature: string | null): void => {
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
