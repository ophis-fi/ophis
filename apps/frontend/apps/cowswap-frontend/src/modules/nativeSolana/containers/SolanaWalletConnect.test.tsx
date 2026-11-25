import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { SolanaWalletConnect } from './SolanaWalletConnect.container'

import { pairSolanaWallet } from '../services/walletConnect.service'

jest.mock('@cowprotocol/wallet', () => ({ WC_PROJECT_ID: 'fixture', WalletConnectIcon: 'wallet.svg' }))
jest.mock('entities/solana', () => ({
  connectSolanaWalletAtom: jest.requireActual<typeof import('jotai')>('jotai').atom(null),
  OPHIS_SOLANA_CONFIG: { chain: 'solana:devnet' },
  solanaPairingChain: () => 'solana:devnet-fixture',
}))
jest.mock('../services/walletConnect.service', () => ({ pairSolanaWallet: jest.fn() }))
jest.mock('react-qrcode-logo', () => ({ QRCode: ({ value }: { value: string }) => <output>{value}</output> }))

it('opens pairing only on demand, presents the same URI for QR and mobile, and cancels on close', async () => {
  const uri = 'wc:fixture@2?relay-protocol=irn'
  jest.mocked(pairSolanaWallet).mockImplementation((_config, _project, onUri) => {
    onUri(uri)
    return new Promise(() => undefined)
  })
  const { unmount } = render(
    <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
      <SolanaWalletConnect />
    </I18nProvider>,
  )
  expect(pairSolanaWallet).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /walletconnect/i }))
  expect((await screen.findByText(uri)).textContent).toBe(uri)
  expect(screen.getByRole('link', { name: 'open your wallet' }).getAttribute('href')).toBe(uri)
  expect(screen.getByRole('button', { name: /walletconnect/i }).hasAttribute('disabled')).toBe(true)
  const signal = jest.mocked(pairSolanaWallet).mock.calls[0][3]
  unmount()
  expect(signal.aborted).toBe(true)
})

it('clears unanswered and cancelled QR codes and keeps an older response from changing the next attempt', async () => {
  jest.useFakeTimers()
  try {
    const reject: Array<(error: Error) => void> = []
    const signals: AbortSignal[] = []
    jest.mocked(pairSolanaWallet).mockImplementation((_config, _project, onUri, signal) => {
      signals.push(signal)
      onUri('wc:attempt' + signals.length)
      return new Promise((_resolve, fail) => reject.push(fail))
    })
    render(
      <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
        <SolanaWalletConnect />
      </I18nProvider>,
    )
    const start = screen.getByRole('button', { name: /WalletConnect/ })
    fireEvent.click(start)
    act(() => {
      jest.advanceTimersByTime(90_000)
    })
    expect(screen.getByRole('alert').textContent).toContain('No Solana connection was confirmed')
    expect(screen.queryByRole('link')).toBeNull()
    expect(signals[0].aborted).toBe(true)
    fireEvent.click(start)
    await act(async () => reject[0](Error('Expired proposal')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('link').getAttribute('href')).toBe('wc:attempt2')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signals[1].aborted).toBe(true)
    expect(screen.queryByRole('link')).toBeNull()
    expect(start.hasAttribute('disabled')).toBe(false)
  } finally {
    jest.useRealTimers()
  }
})
