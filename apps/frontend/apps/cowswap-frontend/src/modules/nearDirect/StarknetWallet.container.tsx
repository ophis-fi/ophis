import { useAtom } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import { isStarknetAddress } from '@cowprotocol/common-utils'
import { ButtonSecondary } from '@cowprotocol/ui'

import { NearToken } from './nearDirect.schemas'
import { nearErrorMessage } from './nearDirect.service'
import { starknetWalletAtom } from './starknetWallet.atoms'
import { STARKNET_MAINNET } from './starknetWallet.service'

export function StarknetWallet({
  source,
  onConnect,
  disabled = false,
}: {
  source: NearToken | undefined
  onConnect?: (address: string) => void
  disabled?: boolean
}): ReactNode {
  const [connection, setConnection] = useAtom(starknetWalletAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const wallet = connection?.wallet
  useEffect(() => {
    if (!wallet) return
    // Reconnect explicitly after account/network changes; never reuse a stale refund account.
    const reset = (): void => setConnection(undefined)
    wallet.on('accountsChanged', reset)
    wallet.on('networkChanged', reset)
    return () => {
      wallet.off('accountsChanged', reset)
      wallet.off('networkChanged', reset)
    }
  }, [wallet, setConnection])

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const sdk = await import('@starknet-io/get-starknet')
      const selected = await sdk.connect({ modalMode: 'alwaysAsk' })
      if (!selected) return
      const [addresses, chainId] = await Promise.all([
        selected.request({ type: 'wallet_requestAccounts', params: { silent_mode: true } }),
        selected.request({ type: 'wallet_requestChainId' }),
      ])
      const address = addresses[0]
      if (!address || !isStarknetAddress(address)) throw new Error('Unlock your Starknet wallet and try again.')
      if (BigInt(chainId) !== STARKNET_MAINNET) throw new Error('Select Starknet mainnet in your wallet and reconnect.')
      setConnection({ wallet: selected, address })
      onConnect?.(address)
    } catch (failure) {
      setError(nearErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  if (source?.blockchain !== 'starknet') return null
  return (
    <>
      {connection && (
        <small>
          {wallet?.name}: {connection.address.slice(0, 8)}…{connection.address.slice(-6)}
        </small>
      )}
      <ButtonSecondary disabled={disabled || busy} onClick={connection ? () => setConnection(undefined) : connect}>
        {busy ? 'Check your Starknet wallet…' : connection ? 'Disconnect Starknet wallet' : 'Connect Starknet wallet'}
      </ButtonSecondary>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
