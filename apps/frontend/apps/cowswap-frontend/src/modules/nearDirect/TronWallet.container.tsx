import { useAtom } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { useTronWallets } from './hooks/useTronWallets'
import { nearErrorMessage } from './nearDirect.service'
import { TronProvider, tronWalletAtom } from './tronWallet.atoms'

export function TronWallet({
  onConnect,
  disabled = false,
}: {
  onConnect?: (address: string) => void
  disabled?: boolean
}): ReactNode {
  const wallets = useTronWallets()
  const [connection, setConnection] = useAtom(tronWalletAtom)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!connection) return
    onConnect?.(connection.address)
    const reset = (): void => setConnection(undefined)
    const events = ['accountsChanged', 'chainChanged', 'disconnect']
    events.forEach((event) => connection.provider.on(event, reset))
    return () => {
      events.forEach((event) => connection.provider.removeListener(event, reset))
    }
  }, [connection, setConnection, onConnect])
  const connect = async (name: string, provider: TronProvider): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await provider.request({ method: 'eth_requestAccounts' })
      const { assertTronWallet } = await import('./tronWallet.service')
      const address = await assertTronWallet(provider)
      setConnection({ provider, address, name })
      setOpen(false)
    } catch (failure) {
      setError(nearErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {connection && (
        <small>
          {connection.name}: {connection.address.slice(0, 8)}…{connection.address.slice(-6)}
        </small>
      )}
      <ButtonSecondary
        disabled={disabled || busy}
        onClick={() => (connection ? setConnection(undefined) : setOpen(!open))}
      >
        {busy ? 'Check your Tron wallet…' : `${connection ? 'Disconnect' : 'Connect'} Tron wallet`}
      </ButtonSecondary>
      {open && !connection && (
        <div aria-label="Tron wallets">
          {wallets.map(({ name, provider }) => (
            <ButtonSecondary key={name} disabled={disabled || busy} onClick={() => connect(name, provider)}>
              {name}
            </ButtonSecondary>
          ))}
          {!wallets.length && (
            <p>
              No compatible Tron wallet detected. Open Ophis in your wallet’s browser or enable its browser extension.
            </p>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  )
}
