import { atom } from 'jotai'

import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'

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

export const clearNativeSolanaReviewAtom = atom(null, (_get, set) => set(reviewAtom, null))

export const requestNativeSolanaQuoteAtom = atom(null, async (get, set) => {
  const config = OPHIS_SOLANA_CONFIG
  const connection = get(solanaConnectionAtom)
  const form = get(nativeSolanaFormAtom)
  if (!config || !connection || get(nativeSolanaBusyAtom)) return
  set(nativeSolanaBusyAtom, true)
  set(nativeSolanaErrorAtom, null)
  set(reviewAtom, null)
  try {
    const review = await loadNativeSolanaQuote(config, connection, form)
    if (get(nativeSolanaFormAtom) === form && get(solanaConnectionAtom) === connection) set(reviewAtom, review)
  } catch (error: unknown) {
    if (get(nativeSolanaFormAtom) === form && get(solanaConnectionAtom) === connection)
      set(nativeSolanaErrorAtom, nativeSolanaErrorMessage(error))
  } finally {
    set(nativeSolanaBusyAtom, false)
  }
})
