import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'

import { solanaConnectionAtom } from 'entities/solana'

import {
  nativeSolanaFormAtom,
  nativeSolanaQuoteErrorAtom,
  nativeSolanaReviewAtom,
  requestNativeSolanaQuoteAtom,
} from '../state/trade.atoms'

export function useAutomaticSolanaQuote(canQuote: boolean): void {
  const form = useAtomValue(nativeSolanaFormAtom)
  const owner = useAtomValue(solanaConnectionAtom)
  const review = useAtomValue(nativeSolanaReviewAtom)
  const quoteError = useAtomValue(nativeSolanaQuoteErrorAtom)
  const request = useSetAtom(requestNativeSolanaQuoteAtom)
  useEffect(() => {
    if (!canQuote || review || quoteError) return
    const controller = new AbortController()
    const fetchQuote = (): void => {
      void request(controller.signal)
    }
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'hidden')
        document.addEventListener('visibilitychange', fetchQuote, { once: true })
      else fetchQuote()
    }, 350)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', fetchQuote)
    }
  }, [canQuote, form, owner, quoteError, request, review])
}
