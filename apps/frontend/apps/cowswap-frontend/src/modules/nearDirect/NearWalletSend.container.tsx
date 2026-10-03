import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useCallback, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { BaseError, UserRejectedRequestError } from 'viem'

import { useBridgeWallet } from 'modules/cctp'

import { markNearFundingStarted, nearTransfersAtom, readStoredNearTransfer } from './nearDirect.atoms'
import { NearTransfer } from './nearDirect.schemas'
import { submitNearDeposit } from './nearDirect.service'
import { fundNearTransfer } from './nearDirectWallet.service'
import { starknetWalletAtom } from './starknetWallet.atoms'
import { StarknetWallet } from './StarknetWallet.container'
import { fundStarknetTransfer } from './starknetWallet.service'

export function NearWalletSend({ transfer }: { transfer: NearTransfer }): ReactNode {
  const wallet = useBridgeWallet()
  const starknet = useAtomValue(starknetWalletAtom)
  const isStarknet = transfer.source.blockchain === 'starknet'
  const { account } = useWalletInfo()
  const setTransfers = useSetAtom(nearTransfersAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const signature = transfer.response.signature

  const send = useCallback(async (): Promise<void> => {
    if ((isStarknet ? !starknet : !wallet) || busy) return
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
        const hash =
          isStarknet && starknet
            ? await fundStarknetTransfer(starknet.wallet, stored, beforeSend)
            : wallet
              ? await fundNearTransfer(wallet, stored, beforeSend)
              : undefined
        if (!hash) throw new Error('Reconnect your wallet before sending.')
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
  }, [wallet, starknet, isStarknet, busy, signature, setTransfers])

  if (
    (!isStarknet && (!account || !wallet || !['monad', 'xlayer'].includes(transfer.source.blockchain))) ||
    transfer.response.quote.depositMemo
  )
    return null
  return (
    <>
      {isStarknet && <StarknetWallet source={transfer.source} disabled={busy} />}
      <button type="button" disabled={busy || (isStarknet && !starknet)} onClick={send}>
        {busy ? 'Check your wallet…' : isStarknet ? 'Send with Starknet wallet' : 'Send with connected wallet'}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
