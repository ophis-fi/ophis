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
import { checkAtomicReceipt } from '../services/atomicReceipt.service'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'
import {
  checkLocalBackpackRpc,
  nativeSolanaContext,
  nativeSolanaErrorMessage,
  prepareReviewedSolanaOrder,
  type NativeSolanaReview,
} from '../services/trade.service'

function sameAllowance(reviewed: NativeSolanaReview['allowance'], current: NativeSolanaReview['allowance']): boolean {
  return reviewed?.delegate === current?.delegate && reviewed?.atoms === current?.atoms
}

const recheckAllowanceAtom = atom(
  null,
  async (get, set, rpc: string, genesis: string, review: NativeSolanaReview, replaceAllowance: boolean) => {
    if (review.atomic && review.form.sellMint === 'SOL') return
    const allowance = await readOphisSellAllowance(
      rpc,
      genesis,
      solanaAddress(review.connection.account.address),
      review.sell,
    )
    if (!sameAllowance(review.allowance, allowance)) {
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
  nativeSale: boolean,
): Promise<void> {
  const live = savedOrders.filter((saved) => {
    const intent = getOrderIntentDecoder().decode(Uint8Array.from(saved.intent))
    const sameSource =
      intent.sellTokenAccount === sellTokenAccount ||
      (nativeSale && saved.executionMode === 'walletAtomic' && BigInt(saved.walletCosts?.nativeWrapRent ?? '0') > 0n)
    return !saved.reclaimed && Date.now() < intent.validTo * 1000 && sameSource
  })
  for (const saved of live) {
    if (saved.executionMode === 'walletAtomic' && saved.creationLifetime) {
      const state = await checkAtomicReceipt(saved)
      if (state.status === 'pending')
        throw Error('Your previous swap is still pending. Check its receipt before submitting another.')
      continue
    }
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

async function prepareReceipt(
  config: OphisSolanaConfig,
  review: NativeSolanaReview,
  order: Awaited<ReturnType<typeof prepareReviewedSolanaOrder>>,
  context: Awaited<ReturnType<typeof nativeSolanaContext>>,
): Promise<SavedNativeSolanaOrder> {
  const record: SavedNativeSolanaOrder = {
    uid: order.uid,
    owner: review.connection.account.address,
    program: config.program,
    genesis: config.genesis,
    orderPda: order.orderPda,
    createdBy: order.payer,
    intent: Array.from(getOrderIntentEncoder().encode(order.intent)),
    signature: null,
    ...(review.atomic
      ? {
          executionMode: 'walletAtomic' as const,
          walletCosts: {
            networkFee: String(review.atomic.costs.networkFee),
            orderRent: String(review.atomic.costs.orderRent),
            nativeWrapRent: String(review.atomic.costs.nativeWrapRent),
          },
        }
      : {}),
    ...(config.chain === 'solana:localnet' && !review.atomic
      ? {}
      : {
          creationLifetime: {
            height: (review.atomic?.lastValidBlockHeight ?? context.lastValidBlockHeight).toString(),
            ...(review.atomic && { blockhash: review.atomic.blockhash }),
            requestedAt: Date.now(),
          },
        }),
    reclaimed: false,
  }
  if (
    !review.atomic &&
    privateSettlementEnabled &&
    (await privateAction<{ automatic: boolean }>('mode', {})).automatic
  ) {
    await privateAction('arm', { uid: order.uid, pda: order.orderPda, intent: record.intent })
  }
  return record
}

const placeNativeSolanaOrderAtom = atom(null, async (get, set, replaceAllowance: boolean) => {
  const review = get(nativeSolanaReviewAtom)
  const config = OPHIS_SOLANA_CONFIG
  if (!review || !config || get(nativeSolanaBusyAtom)) return
  let awaitingAtomicReceipt = false
  set(nativeSolanaBusyAtom, true)
  set(nativeSolanaErrorAtom, null)
  try {
    const { connection } = review
    checkLocalBackpackRpc(config, connection)
    const order = review.atomic ? review.atomic.order : await prepareReviewedSolanaOrder(config, review)
    const rpc = balanceEndpoint(config)
    if (!rpc) throw Error('Wallet balance service unavailable.')
    await set(recheckAllowanceAtom, rpc, config.genesis, review, replaceAllowance)
    await checkPendingOrders(
      rpc,
      config,
      get(visibleNativeSolanaOrdersAtom),
      order.intent.sellTokenAccount,
      review.form.sellMint === 'SOL',
    )
    const context = await nativeSolanaContext(config)
    if (!!context.walletAtomic !== !!review.atomic) throw Error('Swap execution changed. Get a fresh quote.')
    if (get(nativeSolanaReviewAtom) !== review) throw Error('The wallet or trade changed. Request a new quote.')
    const record = await prepareReceipt(config, review, order, context)
    const onBeforeBroadcast = (): void => {
      if (get(nativeSolanaReviewAtom) !== review) throw Error('The wallet or trade changed. Request a new quote.')
      set(activeSolanaReceiptAtom, order.uid)
      if (!get(savedNativeSolanaOrdersAtom)[order.uid])
        set(savedNativeSolanaOrdersAtom, { ...get(savedNativeSolanaOrdersAtom), [order.uid]: record })
      awaitingAtomicReceipt = !!review.atomic
    }
    const wallet = { ...connection, chain: config.chain, onBeforeBroadcast }
    const submission = review.atomic
      ? review.atomic.send(wallet)
      : sendOphisSolanaWalletTransaction({
          ...wallet,
          instructions: order.instructions,
          context,
          programAddress: config.program,
          expectedGenesisHash: config.genesis,
        })
    await submission.then(
      (signature) => {
        set(savedNativeSolanaOrdersAtom, { ...get(savedNativeSolanaOrdersAtom), [order.uid]: { ...record, signature } })
      },
      (error: unknown) => {
        if (awaitingAtomicReceipt && /blockhash\s*not\s*found/i.test(nativeSolanaErrorMessage(error))) return
        throw error
      },
    )
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
