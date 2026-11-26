import { atom } from 'jotai'

import {
  getOrderIntentDecoder,
  getOrderIntentEncoder,
  readOphisOrderAccount,
  readOphisSellAllowance,
  sendOphisSolanaWalletTransaction,
  solanaAddress,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom, type OphisSolanaConfig } from 'entities/solana'

import {
  activeSolanaReceiptAtom,
  lookupMissingCreation,
  savedNativeSolanaOrdersAtom,
  visibleNativeSolanaOrdersAtom,
  type SavedNativeSolanaOrder,
} from './orders.atoms'
import {
  clearNativeSolanaReviewAtom,
  nativeSolanaBusyAtom,
  nativeSolanaErrorAtom,
  nativeSolanaReviewAtom,
} from './trade.atoms'

import { balanceEndpoint } from '../services/assets.service'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'
import {
  checkLocalBackpackRpc,
  nativeSolanaContext,
  nativeSolanaErrorMessage,
  prepareReviewedSolanaOrder,
  type NativeSolanaReview,
} from '../services/trade.service'

const recheckAllowanceAtom = atom(
  null,
  async (get, set, rpc: string, genesis: string, review: NativeSolanaReview, replaceAllowance: boolean) => {
    const allowance = await readOphisSellAllowance(
      rpc,
      genesis,
      solanaAddress(review.connection.account.address),
      review.sell,
    )
    if (allowance?.delegate !== review.allowance?.delegate || allowance?.atoms !== review.allowance?.atoms) {
      if (get(nativeSolanaReviewAtom) === review) set(clearNativeSolanaReviewAtom)
      throw Error('Your token spending allowance changed. Review the updated quote before continuing.')
    }
    if (allowance && !replaceAllowance) throw Error('Review the existing token allowance before continuing.')
  },
)

async function checkPendingOrders(
  rpc: string,
  config: OphisSolanaConfig,
  savedOrders: readonly SavedNativeSolanaOrder[],
  sellTokenAccount: string,
): Promise<void> {
  const live = savedOrders.filter((saved) => {
    const intent = getOrderIntentDecoder().decode(Uint8Array.from(saved.intent))
    return !saved.reclaimed && Date.now() < intent.validTo * 1000 && intent.sellTokenAccount === sellTokenAccount
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
}

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
    await set(recheckAllowanceAtom, rpc, config.genesis, review, replaceAllowance)
    await checkPendingOrders(rpc, config, get(visibleNativeSolanaOrdersAtom), order.intent.sellTokenAccount)
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
        set(activeSolanaReceiptAtom, order.uid)
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
