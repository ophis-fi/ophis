import { atom } from 'jotai'

import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom, type SolanaConnection } from 'entities/solana'

import { privateSettlementEnabled } from '../services/privateSettlement.service'
import {
  loadNativeSolanaQuote,
  nativeSolanaErrorMessage,
  type NativeSolanaForm,
  type NativeSolanaReview,
} from '../services/trade.service'

export const privateUsdcToSol: NativeSolanaForm = {
  sellMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  buyMint: 'SOL',
  amount: '0.10',
  slippageBps: 50,
}

export const nativeSolanaFormAtom = atom<NativeSolanaForm>(
  privateSettlementEnabled && new URLSearchParams(window.location.search).get('review') === 'solfi'
    ? privateUsdcToSol
    : { sellMint: 'SOL', buyMint: '', amount: '', slippageBps: 50 },
)
export const nativeSolanaBusyAtom = atom(false)
export const nativeSolanaErrorAtom = atom<string | null>(null)
const reviewAtom = atom<NativeSolanaReview | null>(null)
export const nativeSolanaReviewAtom = atom((get) => {
  const review = get(reviewAtom)
  return review?.form === get(nativeSolanaFormAtom) && review?.connection === get(solanaConnectionAtom) ? review : null
})

const quoteFailureAtom = atom<{ form: NativeSolanaForm; connection: SolanaConnection; message: string } | null>(null)
export const nativeSolanaQuoteErrorAtom = atom((get) => {
  const failure = get(quoteFailureAtom)
  return failure?.form === get(nativeSolanaFormAtom) && failure.connection === get(solanaConnectionAtom)
    ? failure.message
    : null
})

export const clearNativeSolanaReviewAtom = atom(null, (_get, set) => {
  set(reviewAtom, null)
  set(quoteFailureAtom, null)
})

export const requestNativeSolanaQuoteAtom = atom(null, async (get, set, signal?: AbortSignal) => {
  const config = OPHIS_SOLANA_CONFIG
  const connection = get(solanaConnectionAtom)
  const form = get(nativeSolanaFormAtom)
  if (!config || !connection || get(nativeSolanaBusyAtom)) return
  const isCurrent = (): boolean =>
    !signal?.aborted && get(nativeSolanaFormAtom) === form && get(solanaConnectionAtom) === connection
  set(clearNativeSolanaReviewAtom)
  try {
    const review = await loadNativeSolanaQuote(config, connection, form, signal)
    if (!(Date.parse(review.quote.expiration) > Date.now()))
      throw Error('The quote expired. Refresh the quote to continue.')
    if (isCurrent()) set(reviewAtom, review)
  } catch (error: unknown) {
    if (isCurrent()) set(quoteFailureAtom, { form, connection, message: nativeSolanaErrorMessage(error) })
  }
})
