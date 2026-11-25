import { useSetAtom } from 'jotai'
import { ReactNode, useEffect, useRef, useState } from 'react'

import { WC_PROJECT_ID, WalletConnectIcon } from '@cowprotocol/wallet'

import { Trans, useLingui } from '@lingui/react/macro'
import {
  connectSolanaWalletAtom,
  OPHIS_SOLANA_CONFIG,
  solanaPairingChain,
  type SolanaWalletNetwork,
} from 'entities/solana'
import { QRCode } from 'react-qrcode-logo'

import * as styledEl from '../pure/SwapForm.styled'
import { pairSolanaWallet } from '../services/walletConnect.service'

export function SolanaWalletConnect(): ReactNode {
  const connect = useSetAtom(connectSolanaWalletAtom)
  return <SolanaWalletPairing network={OPHIS_SOLANA_CONFIG} onConnect={connect} />
}

export function SolanaWalletPairing({
  network,
  onConnect,
}: {
  network: SolanaWalletNetwork | null
  onConnect: (wallet: Awaited<ReturnType<typeof pairSolanaWallet>>) => Promise<boolean>
}): ReactNode {
  const { t } = useLingui()
  const attempt = useRef<AbortController | null>(null)
  const [pending, setPending] = useState<'pairing' | 'connecting' | null>(null)
  const [uri, setUri] = useState('')
  const [error, setError] = useState('')
  useEffect(() => () => attempt.current?.abort(), [])

  function cancel(): void {
    attempt.current?.abort()
    attempt.current = null
    setPending(null)
    setUri('')
  }

  async function pair(): Promise<void> {
    if (!network || attempt.current) return
    const controller = new AbortController()
    attempt.current = controller
    setError('')
    setPending('pairing')
    const timer = window.setTimeout(() => {
      cancel()
      setError(t`No Solana connection was confirmed. Check that your wallet supports this network, then try again.`)
    }, 90_000)
    controller.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true })
    try {
      const wallet = await pairSolanaWallet(network, WC_PROJECT_ID, setUri, controller.signal)
      window.clearTimeout(timer)
      if (!controller.signal.aborted) {
        setUri('')
        setPending('connecting')
      }
      if (controller.signal.aborted || !(await onConnect(wallet))) {
        await wallet.features['standard:disconnect']?.disconnect()
        throw Error('Reconnect a Solana account on the selected network.')
      }
    } catch (cause: unknown) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : t`Your wallet did not confirm this Solana connection.`)
    } finally {
      window.clearTimeout(timer)
      if (!controller.signal.aborted) {
        attempt.current = null
        setPending(null)
        setUri('')
      }
    }
  }

  const publicCluster = Boolean(solanaPairingChain(network))
  return (
    <section aria-label="WalletConnect">
      <styledEl.Option
        type="button"
        disabled={!publicCluster || !WC_PROJECT_ID || !!pending}
        onClick={() => void pair()}
      >
        <styledEl.Coin src={WalletConnectIcon} alt="" />
        <span>
          WalletConnect
          <small>
            {!publicCluster ? (
              <Trans>Unavailable on this local or custom network</Trans>
            ) : !WC_PROJECT_ID ? (
              <Trans>Pairing is not configured for this site</Trans>
            ) : pending === 'connecting' ? (
              <Trans>Connecting…</Trans>
            ) : pending ? (
              <Trans>Waiting for your wallet…</Trans>
            ) : (
              <Trans>Connect a mobile wallet by QR code</Trans>
            )}
          </small>
        </span>
      </styledEl.Option>
      {uri && (
        <div>
          <QRCode value={uri} size={288} quietZone={28} style={{ maxWidth: '100%', height: 'auto' }} />
          <p>
            <Trans>
              Scan with a Solana wallet or <a href={uri}>open your wallet</a> on this device.
            </Trans>
          </p>
        </div>
      )}
      {pending === 'pairing' && (
        <styledEl.SmallButton type="button" onClick={() => cancel()}>
          <Trans>Cancel</Trans>
        </styledEl.SmallButton>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
