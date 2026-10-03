import { useSetAtom } from 'jotai'
import { ReactNode, useCallback, useState } from 'react'

import { BaseError, UserRejectedRequestError } from 'viem'

import { useNearFundingWallet } from './hooks/useNearFundingWallet'
import { markNearFundingStarted, nearTransfersAtom, readStoredNearTransfer } from './nearDirect.atoms'
import { DIRECT_NEAR_CHAINS, SOURCE_WALLET_CHAINS } from './nearDirect.constants'
import { NearTransfer } from './nearDirect.schemas'
import { submitNearDeposit } from './nearDirect.service'
import { NearSourceWallet } from './NearSourceWallet.container'

export function NearWalletSend({ transfer }: { transfer: NearTransfer }): ReactNode {
  const chain = transfer.source.blockchain
  const fund = useNearFundingWallet(chain)
  const sourceWallet = SOURCE_WALLET_CHAINS.includes(chain)
  const setTransfers = useSetAtom(nearTransfersAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const signature = transfer.response.signature

  const send = useCallback(async (): Promise<void> => {
    if (!fund || busy) return
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
        const beforeSend = async (nonce?: number): Promise<void> => {
          await setTransfers((current) => markNearFundingStarted(current, signature, nonce))
        }
        const hash = await fund(stored, beforeSend)
        await submitNearDeposit(stored, hash, () =>
          setTransfers((current) => [
            ...current.filter((item) => item.response.signature !== signature),
            {
              ...(current.find((item) => item.response.signature === signature) ?? stored),
              fundingStarted: true,
              transactionHash: hash,
            },
          ]),
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
  }, [fund, busy, signature, setTransfers])

  if ((!sourceWallet && !fund) || transfer.response.quote.depositMemo) return null
  return (
    <>
      {sourceWallet && <NearSourceWallet source={transfer.source} disabled={busy} />}
      <button type="button" disabled={busy || !fund} onClick={send}>
        {busy
          ? 'Check your wallet…'
          : sourceWallet
            ? `Send with ${DIRECT_NEAR_CHAINS[chain]?.label} wallet`
            : 'Send with connected wallet'}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
