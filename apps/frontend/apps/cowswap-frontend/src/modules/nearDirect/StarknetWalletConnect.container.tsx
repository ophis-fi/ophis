import { ReactNode, useEffect, useRef, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { useStarknetWallet } from './hooks/useStarknetWallet'
import { Stack } from './nearDirect.styled'
import { getStarknetAccount, StarknetWallet } from './starknetWallet.service'

export function StarknetWalletConnect({
  onConnect,
  disabled = false,
}: {
  onConnect?(address: string): void
  disabled?: boolean
}): ReactNode {
  const { connection, setConnection } = useStarknetWallet()
  const attempt = useRef(0)
  useEffect(
    () => () => {
      attempt.current += 1
    },
    [],
  )
  const [wallets, setWallets] = useState<StarknetWallet[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const discover = async (): Promise<void> => {
    const id = ++attempt.current
    setBusy(true)
    setError('')
    try {
      const { default: core } = await import('@starknet-io/get-starknet-core')
      const available = await core.getAvailableWallets()
      if (id === attempt.current) setWallets(available)
    } catch {
      if (id === attempt.current) setError('Unable to find Starknet wallets. Unlock your wallet and try again.')
    } finally {
      if (id === attempt.current) setBusy(false)
    }
  }
  const connect = async (candidate: StarknetWallet): Promise<void> => {
    const id = ++attempt.current
    setBusy(true)
    setError('')
    try {
      const { default: core } = await import('@starknet-io/get-starknet-core')
      const wallet = await core.enable(candidate)
      const address = await getStarknetAccount(wallet, true)
      if (id !== attempt.current) return
      setConnection({ wallet, address })
      onConnect?.(address)
      setWallets(null)
    } catch (failure) {
      if (id === attempt.current)
        setError(failure instanceof Error ? failure.message : 'Wallet connection was declined. Try again when ready.')
    } finally {
      if (id === attempt.current) setBusy(false)
    }
  }
  return (
    <Stack aria-label="Starknet wallet">
      {connection ? (
        <>
          <small>
            Starknet · {connection.wallet.name} · {connection.address.slice(0, 8)}…{connection.address.slice(-6)}
          </small>
          <ButtonSecondary disabled={disabled || busy} onClick={() => setConnection(null)}>
            Disconnect Starknet wallet
          </ButtonSecondary>
        </>
      ) : (
        <ButtonSecondary disabled={disabled || busy} onClick={discover}>
          {busy ? 'Check your Starknet wallet…' : 'Connect Starknet wallet'}
        </ButtonSecondary>
      )}
      {!connection &&
        wallets?.map((wallet) => (
          <ButtonSecondary key={wallet.id} disabled={disabled || busy} onClick={() => connect(wallet)}>
            Connect {wallet.name}
          </ButtonSecondary>
        ))}
      {!connection && wallets?.length === 0 && (
        <small>
          No Starknet wallet detected. Open this page with a Starknet wallet extension such as Ready or Braavos, or use
          an external wallet and enter its refund address below.
        </small>
      )}
      {error && <small role="alert">{error}</small>}
    </Stack>
  )
}
