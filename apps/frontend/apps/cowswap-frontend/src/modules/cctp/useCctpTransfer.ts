import { useAtom } from 'jotai'
import { useCallback, useMemo, useRef, useState } from 'react'

import { isRejectRequestProviderError } from '@cowprotocol/common-utils'
import { useWalletInfo } from '@cowprotocol/wallet'

import { isCctpOwner, type CctpTransfer } from './cctp.service'
import { cctpTransferAtom, cctpTransferSchema } from './cctpState'
import {
  claimCctpTransfer,
  resumeCctpClaim,
  resumeCctpTransfer,
  submitCctpBurn,
  updateCctpTransfer,
} from './cctpSubmission.service'
import { switchCctpChain } from './cctpWallet.service'
import { type RunCctpAction, useCctpQuote } from './useCctpQuote'
import { useCctpStatus } from './useCctpStatus'
import { useCctpWallet } from './useCctpWallet'

function cctpErrorMessage(caught: unknown): string {
  if (isRejectRequestProviderError(caught)) return 'Request declined in your wallet.'
  return caught instanceof Error ? caught.message : 'Bridge request failed'
}

type CctpFlow = ReturnType<typeof useCctpQuote> & {
  transfer: CctpTransfer | null
  status: ReturnType<typeof useCctpStatus>['status']
  error: string | null
  busy: string
  switchNetwork(chainId: number): Promise<void>
  bridge(): Promise<void>
  claim(): Promise<void>
  resume(hash: string): Promise<void>
  resumeClaim(hash: string): Promise<void>
  finish(): void
}

export function useCctpTransfer(contextKey = ''): CctpFlow {
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
  const quoting = useCctpQuote(account, wallet, run, contextKey)
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
          await switchCctpChain(wallet, chainId)
        }),
      bridge: () =>
        run('Confirm the bridge in your wallet', async () => {
          if (!wallet || !quoting.quote || !isCctpOwner(quoting.quote.owner, account))
            throw new Error('Refresh the quote for your connected wallet')
          await submitCctpBurn(wallet, quoting.quote, setStored, quoting.assertCurrentQuote)
          quoting.clearQuote()
        }),
      claim: () =>
        run('Confirm destination claim in your wallet', async () => {
          if (!wallet || !transfer || !isCctpOwner(transfer.owner, account))
            throw new Error('Connect the wallet that started this bridge')
          await updateCctpTransfer(transfer, () => claimCctpTransfer(wallet, transfer, setStored), setStored)
        }),
      resume: (hash: string) =>
        run('Checking source transaction', async () => {
          if (!transfer) throw new Error('No transfer to resume')
          await updateCctpTransfer(transfer, () => resumeCctpTransfer(transfer, hash), setStored)
        }),
      resumeClaim: (hash: string) =>
        run('Checking destination transaction', async () => {
          if (!transfer) throw new Error('No transfer to resume')
          await updateCctpTransfer(transfer, () => resumeCctpClaim(transfer, hash), setStored)
        }),
      finish: () => {
        if (transfer && (tracking.status?.completed || tracking.status?.failed))
          void run('Finishing transfer', () => updateCctpTransfer(transfer, async () => null, setStored))
      },
    }),
    [account, busy, error, parsed, quoting, run, setStored, tracking, transfer, wallet],
  )
}
