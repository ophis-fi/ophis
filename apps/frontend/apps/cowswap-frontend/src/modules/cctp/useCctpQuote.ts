import { useEffect, useMemo, useState } from 'react'

import { type WalletClient } from 'viem'

import { cctpClient, isCctpOwner, quoteCctp, readCctpFunds, type CctpQuote } from './cctp.service'
import { approveCctp } from './cctpWallet.service'

export type RunCctpAction = (
  label: string,
  action: (progress: (label: string) => void) => Promise<void>,
) => Promise<void>

export function useCctpQuote(
  account: string | undefined,
  wallet: WalletClient | undefined,
  run: RunCctpAction,
): {
  quote: CctpQuote | null
  approved: boolean
  clearQuote(): void
  approve(): Promise<void>
  loadQuote(source: number, destination: number, input: string): Promise<void>
} {
  const [quote, setQuote] = useState<CctpQuote | null>(null)
  const [approved, setApproved] = useState(false)
  useEffect(() => {
    setQuote(null)
  }, [account])
  return useMemo(
    () => ({
      quote: quote && isCctpOwner(quote.owner, account) ? quote : null,
      approved,
      clearQuote: () => setQuote(null),
      loadQuote: (source: number, destination: number, input: string) =>
        run('Getting bridge fee', async () => {
          setQuote(null)
          if (!account) throw new Error('Connect your wallet first')
          const next = await quoteCctp(source, destination, account, input)
          const funds = await readCctpFunds(next)
          if (funds.balance < BigInt(next.amount)) throw new Error('Insufficient USDC balance')
          setApproved(funds.allowance >= BigInt(next.amount))
          setQuote(next)
        }),
      approve: () =>
        run('Confirm USDC approval in your wallet', async (progress) => {
          if (!wallet || !quote || !isCctpOwner(quote.owner, account))
            throw new Error('Refresh the quote for your connected wallet')
          const hash = await approveCctp(wallet, quote)
          if (hash) {
            progress('Waiting for USDC approval confirmation')
            const receipt = await cctpClient(quote.source).waitForTransactionReceipt({
              hash,
              timeout: 120_000,
              pollingInterval: 10_000,
            })
            if (receipt.status !== 'success') throw new Error('USDC approval reverted')
          }
          setQuote(null)
        }),
    }),
    [account, approved, quote, run, wallet],
  )
}
