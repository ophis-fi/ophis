import { useAtom } from 'jotai'
import { useCallback, useMemo, useRef, useState } from 'react'

import { isRejectRequestProviderError } from '@cowprotocol/common-utils'
import { useWalletInfo } from '@cowprotocol/wallet'

import { isCctpOwner, type CctpTransfer } from './cctp.service'
import { cctpTransferAtom, cctpTransferSchema } from './cctpState'
import { claimCctpTransfer, resumeCctpTransfer, submitCctpBurn } from './cctpSubmission.service'
import { type RunCctpAction, useCctpQuote } from './useCctpQuote'
import { useCctpStatus } from './useCctpStatus'
import { useCctpWallet } from './useCctpWallet'

function cctpErrorMessage(caught: unknown): string {
  if (isRejectRequestProviderError(caught)) return 'Request declined in your wallet.'
  return caught instanceof Error ? caught.message : 'Bridge request failed'
}

export function useCctpTransfer(): ReturnType<typeof useCctpQuote> & {
  transfer: CctpTransfer | null
  status: ReturnType<typeof useCctpStatus>['status']
  error: string | null
  busy: string
  switchNetwork(chainId: number): Promise<void>
  bridge(): Promise<void>
  claim(): Promise<void>
  resume(hash: string): Promise<void>
  finish(): void
} {
  const { account } = useWalletInfo()
  const wallet = useCctpWallet()
  const [stored, setStored] = useAtom(cctpTransferAtom)
  const parsed = useMemo(() => (stored ? cctpTransferSchema.safeParse(stored) : null), [stored])
  const transfer = parsed?.success ? parsed.data : null
  const tracking = useCctpStatus(transfer)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const inFlight = useRef(false)
  const run = useCallback<RunCctpAction>(async (label, action) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(label)
    setError(null)
    try {
      await action(setBusy)
    } catch (caught) {
      setError(cctpErrorMessage(caught))
    } finally {
      inFlight.current = false
      setBusy('')
    }
  }, [])
  const quoting = useCctpQuote(account, wallet, run)
  return useMemo(
    () => ({
      ...quoting,
      transfer,
      status: tracking.status,
      busy,
      error:
        parsed && !parsed.success
          ? 'Saved bridge data is invalid. Keep your source transaction hash for recovery.'
          : error || tracking.error,
      switchNetwork: (chainId: number) =>
        run('Switch network in your wallet', async () => {
          if (!wallet) throw new Error('Connect your wallet first')
          await wallet.switchChain({ id: chainId })
        }),
      bridge: () =>
        run('Confirm the bridge in your wallet', async () => {
          if (!wallet || !quoting.quote || !isCctpOwner(quoting.quote.owner, account))
            throw new Error('Refresh the quote for your connected wallet')
          await submitCctpBurn(wallet, quoting.quote, setStored)
          quoting.clearQuote()
        }),
      claim: () =>
        run('Confirm destination claim in your wallet', async () => {
          if (!wallet || !transfer || !isCctpOwner(transfer.owner, account))
            throw new Error('Connect the wallet that started this bridge')
          setStored(await claimCctpTransfer(wallet, transfer))
        }),
      resume: (hash: string) =>
        run('Checking source transaction', async () => {
          if (!transfer) throw new Error('No transfer to resume')
          setStored(await resumeCctpTransfer(transfer, hash))
        }),
      finish: () => {
        if (tracking.status?.completed || tracking.status?.failed) setStored(null)
      },
    }),
    [account, busy, error, parsed, quoting, run, setStored, tracking, transfer, wallet],
  )
}
