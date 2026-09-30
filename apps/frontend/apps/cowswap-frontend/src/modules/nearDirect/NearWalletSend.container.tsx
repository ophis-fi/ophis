import { useSetAtom } from 'jotai'
import { ReactNode, useCallback, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { BaseError, UserRejectedRequestError } from 'viem'

import { useBridgeWallet } from 'modules/cctp'

import { nearTransfersAtom, readStoredNearTransfer } from './nearDirect.atoms'
import { NearTransfer } from './nearDirect.schemas'
import { submitNearDeposit } from './nearDirect.service'
import { fundNearTransfer } from './nearDirectWallet.service'

export function NearWalletSend({ transfer }: { transfer: NearTransfer }): ReactNode {
  const wallet = useBridgeWallet()
  const { account } = useWalletInfo()
  const setTransfers = useSetAtom(nearTransfersAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const signature = transfer.response.signature

  const send = useCallback(async (): Promise<void> => {
    if (!wallet || busy) return
    setBusy(true)
    setError('')
    try {
      if (!navigator.locks) throw new Error('Use the external wallet instructions in this browser.')
      await navigator.locks.request(`nearDirect:${signature}`, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('This deposit is being funded in another tab.')
        const stored = readStoredNearTransfer(signature)
        if (!stored || stored.fundingStarted || stored.transactionHash || stored.status !== 'PENDING_DEPOSIT') {
          throw new Error('A deposit may already have been sent. Check the swap status and your wallet.')
        }
        const hash = await fundNearTransfer(wallet, stored, async (nonce) => {
          await setTransfers((current) =>
            current.map((item) =>
              item.response.signature === signature
                ? { ...item, fundingStarted: true, fundingNonce: nonce, fundingError: undefined }
                : item,
            ),
          )
        })
        await submitNearDeposit(stored, hash, () =>
          setTransfers((current) =>
            current.map((item) => (item.response.signature === signature ? { ...item, transactionHash: hash } : item)),
          ),
        )
      })
    } catch (failure) {
      // A transport error can follow broadcast. Keep the funding journal locked;
      // automatic status polling and a manually supplied hash recover the swap.
      const message = failure instanceof Error ? failure.message : 'Check your wallet before sending again.'
      const rejected =
        failure instanceof BaseError &&
        failure.walk((cause) => cause instanceof UserRejectedRequestError) instanceof UserRejectedRequestError
      await setTransfers((current) =>
        current.map((item) =>
          item.response.signature === signature
            ? { ...item, fundingStarted: rejected ? false : item.fundingStarted, fundingError: message }
            : item,
        ),
      ).catch(() => undefined)
      setError(message)
    } finally {
      setBusy(false)
    }
  }, [wallet, busy, signature, setTransfers])

  if (
    !account ||
    !wallet ||
    !['monad', 'xlayer'].includes(transfer.source.blockchain) ||
    transfer.response.quote.depositMemo
  )
    return null
  return (
    <>
      <button type="button" disabled={busy} onClick={send}>
        {busy ? 'Check your wallet…' : 'Send with connected wallet'}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
