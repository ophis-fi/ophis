import { ReactNode, useState } from 'react'

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { supportsOphisSolanaAccount, type OphisSolanaWallet } from '@ophis/solana-sdk'
import { SOLANA_DEVNET_GENESIS } from 'entities/solana'
import { createRoot } from 'react-dom/client'

import { SolanaWalletPairing } from 'modules/nativeSolana'

const network = { chain: 'solana:devnet', genesis: SOLANA_DEVNET_GENESIS } as const

const target = document.getElementById('test')
const root =
  import.meta.env.DEV && target && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
    ? createRoot(target)
    : null

export function DevnetWalletTest(): ReactNode {
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState('')

  async function check(wallet: OphisSolanaWallet): Promise<boolean> {
    const { accounts } = await wallet.features['standard:connect'].connect()
    const approved = accounts.find((candidate) => supportsOphisSolanaAccount(wallet, candidate, network.chain))
    if (!approved) return false
    setAddress(approved.address)
    const disconnect = wallet.features['standard:disconnect']
    if (disconnect) {
      setStatus('Devnet account verified. Disconnecting…')
      try {
        await disconnect.disconnect()
        setStatus('Devnet account verified and disconnected.')
        return true
      } catch {
        // The account check succeeded even if the wallet could not acknowledge disconnection.
      }
    }
    setStatus('Devnet account verified. Disconnect Ophis in your wallet.')
    return true
  }

  return (
    <>
      {address ? (
        <output>{address}</output>
      ) : (
        <SolanaWalletPairing network={network} onConnect={(wallet) => check(wallet)} />
      )}
      <p role="status">{status}</p>
    </>
  )
}
root?.render(
  <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
    <DevnetWalletTest />
  </I18nProvider>,
)
