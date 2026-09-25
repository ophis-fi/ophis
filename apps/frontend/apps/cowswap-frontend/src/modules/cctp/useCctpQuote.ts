import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { type WalletClient } from 'viem'

import { cctpClient, isCctpOwner, quoteCctp, readCctpFunds, type CctpQuote } from './cctp.service'
import { type CctpAsset } from './cctpAssets.const'
import { approveCctp } from './cctpWallet.service'

export type RunCctpAction = (
  label: string,
  action: (progress: (label: string) => void) => Promise<void>,
) => Promise<void>

export function useCctpQuote(
  account: string | undefined,
  wallet: WalletClient | undefined,
  run: RunCctpAction,
  contextKey = '',
): {
  quote: CctpQuote | null
  approved: boolean
  clearQuote(): void
  assertCurrentQuote(): void
  approve(): Promise<void>
  loadQuote(source: number, destination: number, input: string, asset?: CctpAsset): Promise<void>
} {
  const [result, setResult] = useState<{ key: string; generation: number; quote: CctpQuote } | null>(null)
  const quote = result?.key === contextKey ? result.quote : null
  const generation = useRef(0)
  const clearQuote = useCallback(() => {
    generation.current += 1
    setResult(null)
  }, [])
  const [approved, setApproved] = useState(false)
  useLayoutEffect(() => {
    clearQuote()
    return () => {
      generation.current += 1
    }
  }, [account, contextKey, clearQuote])
  const assertCurrentQuote = useCallback(() => {
    if (!quote || result?.generation !== generation.current)
      throw new Error('Bridge details changed. Review the bridge again.')
  }, [quote, result])
  return useMemo(
    () => ({
      quote: quote && isCctpOwner(quote.owner, account) ? quote : null,
      approved,
      clearQuote,
      assertCurrentQuote,
      loadQuote: (source: number, destination: number, input: string, asset: CctpAsset = 'USDC') =>
        run('Getting bridge fee', async () => {
          clearQuote()
          const request = generation.current
          if (!account) throw new Error('Connect your wallet first')
          const next = await quoteCctp(source, destination, account, input, asset)
          const funds = await readCctpFunds(next)
          if (funds.balance < BigInt(next.amount)) throw new Error('Insufficient token balance')
          if (request !== generation.current) return
          setApproved(funds.allowance >= BigInt(next.amount))
          setResult({ key: contextKey, generation: request, quote: next })
        }),
      approve: () =>
        run('Confirm token approval in your wallet', async (progress) => {
          if (!wallet || !quote || !isCctpOwner(quote.owner, account))
            throw new Error('Refresh the quote for your connected wallet')
          const hash = await approveCctp(wallet, quote, assertCurrentQuote)
          if (hash) {
            progress('Waiting for token approval confirmation')
            const receipt = await cctpClient(quote.source).waitForTransactionReceipt({
              hash,
              timeout: 120_000,
              pollingInterval: 10_000,
            })
            if (receipt.status !== 'success') throw new Error('Token approval reverted')
          }
          clearQuote()
        }),
    }),
    [account, approved, quote, run, wallet, contextKey, clearQuote, assertCurrentQuote],
  )
}
