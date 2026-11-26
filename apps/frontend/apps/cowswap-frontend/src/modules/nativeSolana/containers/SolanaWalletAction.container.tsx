import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useId, useRef, useState } from 'react'

import { ButtonPrimary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import {
  connectSolanaWalletAtom,
  disconnectSolanaWalletAtom,
  solanaConnectionAtom,
  solanaWalletBusyAtom,
  solanaWalletErrorAtom,
  solanaWalletsAtom,
} from 'entities/solana'

import { SolanaWalletConnect } from './SolanaWalletConnect.container'

import * as styledEl from '../pure/SwapForm.styled'
import { shortMint } from '../services/assets.service'

export function SolanaWalletAction({
  canQuote,
  busy,
  reviewReady,
  quoteFailed,
}: {
  canQuote: boolean
  busy: boolean
  reviewReady: boolean
  quoteFailed: boolean
}): ReactNode {
  const connection = useAtomValue(solanaConnectionAtom)
  const disconnect = useSetAtom(disconnectSolanaWalletAtom)
  if (!connection) return <SolanaWalletPicker />

  return (
    <>
      <styledEl.Line>
        <styledEl.Helper>
          <styledEl.Coin src={connection.wallet.icon} alt="" />
          {connection.wallet.name}
          <code title={connection.account.address}>{shortMint(connection.account.address)}</code>
        </styledEl.Helper>
        <styledEl.SmallButton type="button" disabled={busy} onClick={() => void disconnect()}>
          <Trans>Disconnect wallet</Trans>
        </styledEl.SmallButton>
      </styledEl.Line>
      <ButtonPrimary type="submit" disabled={!canQuote || (!reviewReady && !quoteFailed)} aria-live="polite">
        {quoteFailed ? (
          <Trans>Refresh quote</Trans>
        ) : canQuote && !reviewReady ? (
          <Trans>Getting quote…</Trans>
        ) : (
          <Trans>Swap</Trans>
        )}
      </ButtonPrimary>
    </>
  )
}

export function SolanaWalletPicker(): ReactNode {
  const wallets = useAtomValue(solanaWalletsAtom)
  const connecting = useAtomValue(solanaWalletBusyAtom)
  const error = useAtomValue(solanaWalletErrorAtom)
  const connect = useSetAtom(connectSolanaWalletAtom)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const availableToInstall = [
    { name: 'Phantom', url: 'https://phantom.com/download' },
    { name: 'Solflare', url: 'https://www.solflare.com/download/' },
  ].filter(({ name }) => !wallets.some((wallet) => wallet.name.toLowerCase() === name.toLowerCase()))

  return (
    <>
      <ButtonPrimary
        type="button"
        aria-haspopup="dialog"
        disabled={connecting}
        onClick={() => {
          setOpen(true)
          dialog.current?.showModal()
        }}
      >
        {connecting ? <Trans>Connecting…</Trans> : <Trans>Connect wallet</Trans>}
      </ButtonPrimary>
      {error && <p role="alert">{error}</p>}
      <styledEl.Dialog ref={dialog} aria-labelledby={titleId} onClose={() => setOpen(false)}>
        <styledEl.Line>
          <h2 id={titleId}>
            <Trans>Connect a Solana wallet</Trans>
          </h2>
          <styledEl.SmallButton type="button" onClick={() => dialog.current?.close()}>
            <Trans>Close</Trans>
          </styledEl.SmallButton>
        </styledEl.Line>
        {wallets.length > 0 ? (
          <styledEl.Caption>
            <Trans>Detected in this browser</Trans>
          </styledEl.Caption>
        ) : (
          <p>
            <Trans>Open this page in a Solana wallet browser or install a compatible wallet extension.</Trans>
          </p>
        )}
        {wallets.map((wallet) => (
          <styledEl.Option
            key={wallet.name}
            type="button"
            onClick={() => {
              dialog.current?.close()
              void connect(wallet)
            }}
          >
            <styledEl.Coin src={wallet.icon} alt="" />
            {wallet.name}
          </styledEl.Option>
        ))}
        {open && <SolanaWalletConnect />}
        {availableToInstall.length > 0 && (
          <section>
            <styledEl.Caption>
              <Trans>Get a wallet</Trans>
            </styledEl.Caption>
            <styledEl.Helper>
              {availableToInstall.map(({ name, url }) => (
                <a href={url} target="_blank" rel="noopener noreferrer" key={name}>
                  {name}
                </a>
              ))}
            </styledEl.Helper>
          </section>
        )}
      </styledEl.Dialog>
    </>
  )
}
