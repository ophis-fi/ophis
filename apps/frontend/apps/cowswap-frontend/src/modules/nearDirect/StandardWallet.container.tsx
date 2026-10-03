import { useAtom } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { useStandardWallets } from './hooks/useStandardWallets'
import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { nearErrorMessage } from './nearDirect.service'
import { SourceStandardWallet, StandardSourceChain, standardWalletsAtom } from './standardWallet.atoms'
import { sourceWalletAccounts } from './standardWallet.service'

export function StandardWallet({
  chain,
  onConnect,
  disabled = false,
}: {
  chain: StandardSourceChain
  onConnect?: (address: string) => void
  disabled?: boolean
}): ReactNode {
  const wallets = useStandardWallets(chain)
  const [connections, setConnections] = useAtom(standardWalletsAtom)
  const connection = connections[chain]
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const name = DIRECT_NEAR_CHAINS[chain]?.label
  useEffect(() => {
    if (!connection) return
    onConnect?.(connection.account.address)
    return connection.wallet.features['standard:events'].on('change', () =>
      setConnections((current) => ({ ...current, [chain]: undefined })),
    )
  }, [connection, chain, setConnections, onConnect])
  const connect = async (wallet: SourceStandardWallet): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await wallet.features['standard:connect'].connect()
      const account = sourceWalletAccounts(wallet, chain)[0]
      if (!account) throw new Error(`Select a ${name} mainnet account in your wallet.`)
      setConnections((current) => ({ ...current, [chain]: { wallet, account } }))
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
          {connection.wallet.name}: {connection.account.address.slice(0, 8)}…{connection.account.address.slice(-6)}
        </small>
      )}
      <ButtonSecondary
        disabled={disabled || busy}
        onClick={() =>
          connection ? setConnections((current) => ({ ...current, [chain]: undefined })) : setOpen(!open)
        }
      >
        {busy ? 'Check your wallet…' : `${connection ? 'Disconnect' : 'Connect'} ${name} wallet`}
      </ButtonSecondary>
      {open && !connection && (
        <div aria-label={`${name} wallets`}>
          {wallets.map((wallet) => (
            <ButtonSecondary key={wallet.name} disabled={disabled || busy} onClick={() => connect(wallet)}>
              {wallet.name}
            </ButtonSecondary>
          ))}
          {!wallets.length && (
            <p>
              No compatible {name} wallet detected. Open Ophis in your wallet’s browser or enable its browser extension.
            </p>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  )
}
