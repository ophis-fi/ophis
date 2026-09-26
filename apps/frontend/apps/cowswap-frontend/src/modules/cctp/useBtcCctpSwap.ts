import { useAtom } from 'jotai'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { formatUnits } from 'viem'

import { useQuoteParams } from 'modules/tradeQuote'

import { quoteBtcSwap, type BtcSwapQuote } from './btcSwapQuote.service'
import { parseBtcSwap, type BtcSwapPending } from './btcSwapState'
import { recoverBtcSwap, finishBtcSwap } from './btcSwapStatus.service'
import { approveBtcSwap, readBtcSwapFunds, submitBtcSwap, updateBtcSwap } from './btcSwapSubmission.service'
import { isCctpOwner } from './cctp.service'
import { cctpTransferAtom } from './cctpState'
import { useBtcSwapStatus } from './useBtcSwapStatus'
import { type useCctpTransfer } from './useCctpTransfer'
import { useCctpWallet } from './useCctpWallet'

interface BtcCctpSwapState {
  quote: BtcSwapQuote | null
  pending: ReturnType<typeof parseBtcSwap>
  tracking: ReturnType<typeof useBtcSwapStatus>
  approved: boolean
  review(): Promise<void>
  approve(): Promise<void>
  swap(): Promise<void>
  continueBridge(): Promise<void>
  finish(): Promise<void>
  recover(hash: string): Promise<void>
}

export function useBtcCctpSwap(
  flow: ReturnType<typeof useCctpTransfer>,
  routeKey: string,
  amount: string | undefined,
  rawAmount: string | undefined,
): BtcCctpSwapState {
  const { account } = useWalletInfo()
  const wallet = useCctpWallet()
  const params = useQuoteParams(rawAmount)
  const contextKey = JSON.stringify([routeKey, params?.quoteParams?.swapSlippageBps, params?.appData])
  const [stored, persist] = useAtom(cctpTransferAtom)
  const pending = useMemo(() => parseBtcSwap(stored), [stored])
  const tracking = useBtcSwapStatus(pending)
  const run = flow.run
  useSaveBtcSwapHash(pending, tracking.status?.settlementHash, persist, flow)
  const [result, setResult] = useState<{ key: string; quote: BtcSwapQuote; approved: boolean } | null>(null)
  const current = useRef(contextKey)
  useLayoutEffect(() => {
    current.current = contextKey
    return () => {
      current.current = ''
    }
  }, [contextKey])
  const quote = result?.key === contextKey ? result.quote : null
  return useMemo(() => {
    const assertCurrent = (): void => {
      if (current.current !== contextKey) throw new Error('Wallet or route changed. Review again.')
    }
    return {
      quote,
      pending,
      tracking,
      approved: !!quote && !!result?.approved,
      review: () =>
        flow.run('Getting swap and bridge quote', async () => {
          setResult(null)
          if (!account || !params || !amount) throw new Error('Connect your wallet and enter a WBTC amount first.')
          const quote = await quoteBtcSwap(params, account, amount)
          const funds = await readBtcSwapFunds(quote)
          if (!funds.funded) throw new Error('Insufficient WBTC balance')
          assertCurrent()
          setResult({ key: contextKey, quote, approved: funds.approved })
        }),
      approve: () =>
        flow.run('Confirm WBTC approval in your wallet', async () => {
          if (!wallet || !quote) throw new Error('Review the route first')
          await approveBtcSwap(wallet, quote, assertCurrent)
          setResult(null)
        }),
      swap: () =>
        flow.run('Confirm the WBTC swap in your wallet', async () => {
          if (!wallet || !quote) throw new Error('Review the route first')
          await submitBtcSwap(wallet, quote, persist, assertCurrent)
          setResult(null)
        }),
      continueBridge: () => {
        if (!pending || !tracking.status?.amount || !isCctpOwner(pending.owner, account)) return Promise.resolve()
        return flow.loadQuote(1, 5042, formatUnits(BigInt(tracking.status.amount), 8), 'cirBTC', pending.orderUid)
      },
      recover: (hash: string) =>
        run('Checking Ethereum swap', async () => {
          if (!pending) return
          await updateBtcSwap(pending, () => recoverBtcSwap(pending, hash), persist)
        }),
      finish: () =>
        run('Checking completed swap', async () => {
          if (!pending || !isCctpOwner(pending.owner, account))
            throw new Error('Connect the wallet that started this route')
          await updateBtcSwap(pending, () => finishBtcSwap(pending), persist)
        }),
    }
  }, [quote, pending, tracking, result, account, params, amount, contextKey, flow, wallet, persist, run])
}

function useSaveBtcSwapHash(
  pending: BtcSwapPending | null,
  settlementHash: BtcSwapPending['settlementHash'],
  persist: (value: BtcSwapPending | null) => void,
  { run, busy }: ReturnType<typeof useCctpTransfer>,
): void {
  const attempted = useRef('')
  useEffect(() => {
    const key = `${pending?.orderUid}:${settlementHash}`
    if (busy || !pending || pending.settlementHash || !settlementHash || attempted.current === key) return
    attempted.current = key
    void run('Saving swap recovery', () =>
      updateBtcSwap(pending, async () => ({ ...pending, settlementHash }), persist),
    )
  }, [pending, settlementHash, persist, run, busy])
}
