import { createStore, Provider } from 'jotai'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type SolanaConnection, solanaConnectionAtom } from 'entities/solana'
import { utils } from 'ethers'
import { MemoryRouter } from 'react-router'

import { generateKeyPairSync, sign, verify, type KeyObject } from 'crypto'

import { RefCodeCaptureUpdater } from 'modules/affiliate'

import { ProfilePage } from './Profile.container'

import { PartnerPage } from '../Partner/Partner.container'

jest.mock('@ophis/solana-sdk', () => ({}), { virtual: true })
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { chain: 'solana:mainnet' },
  solanaConnectionAtom: jest.requireActual('jotai').atom(null),
}))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: mockEvm, chainId: 1 }),
  useWalletDetails: () => ({ walletName: 'EVM wallet' }),
  walletInfoAtom: jest.requireActual('jotai').atom({}),
}))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: () => undefined }))
jest.mock('modules/nativeSolana', () => ({ SolanaWalletPicker: () => <button>Connect Solana</button> }))
jest.mock('modules/wallet', () => ({ Web3Status: () => null }))
jest.mock('legacy/state/application/hooks', () => ({ useToggleWalletModal: () => jest.fn() }))

const mockEvm = '0xabcdef0000000000000000000000000000000001'
const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
  localStorage.clear()
})

function fixture(): { address: string; publicKey: KeyObject; signMessage: jest.Mock; connected: SolanaConnection } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const address = utils.base58.encode(rawPublic)
  const account = { address, publicKey: rawPublic, features: ['solana:signMessage'], chains: ['solana:mainnet'] }
  const signMessage = jest.fn(async ({ message }: { message: Uint8Array }) => [
    { signature: sign(null, message, privateKey), signedMessage: message },
  ])
  const connected = {
    account,
    wallet: {
      name: 'Test wallet',
      accounts: [account],
      features: { 'solana:signMessage': { signMessage } },
    },
  } as unknown as SolanaConnection
  return { address, publicKey, signMessage, connected }
}

it('binds the referral and loads the selected Solana profile with both wallets connected', async () => {
  const { address, publicKey, signMessage, connected } = fixture()
  const store = createStore()
  const fetchMock = jest.fn(async (input: string, _init?: RequestInit) => {
    if (input.endsWith('/ref/bind')) {
      return { ok: true, json: async () => ({ bound: true, alreadyBound: false }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  })
  global.fetch = fetchMock as unknown as typeof fetch
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/profile?network=solana&ref=PARTNER']}>
        <RefCodeCaptureUpdater />
        <ProfilePage />
      </MemoryRouter>
    </Provider>,
  )
  await screen.findByRole('button', { name: 'Connect Solana' })
  expect(signMessage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('link', { name: 'EVM' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/affiliate/' + mockEvm)))
  fireEvent.click(screen.getByRole('link', { name: 'Solana' }))
  await screen.findByRole('button', { name: 'Connect Solana' })
  act(() => store.set(solanaConnectionAtom, connected))
  await screen.findByRole('textbox', { name: /WETH payout address/ })
  expect(screen.getByRole('link', { name: 'View on Solana Explorer' }).getAttribute('href')).toBe(
    `https://explorer.solana.com/address/${address}`,
  )
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/ref/bind'))).toBe(true))
  const init = fetchMock.mock.calls.find(([url]) => url.endsWith('/ref/bind'))?.[1]
  const body = JSON.parse(String(init?.body))
  expect(body.referredWallet).toBe(address)
  expect(body.code).toBe('partner')
  const expected = `Ophis bind referral code partner\nAddress: ${address}\nIssued: ${body.issued}\nChain: solana:mainnet`
  expect(verify(null, Buffer.from(expected), publicKey, utils.arrayify(body.signature))).toBe(true)
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/affiliate/' + address))
  expect(signMessage).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('link', { name: 'EVM' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/affiliate/' + mockEvm)))
  expect(screen.queryByRole('textbox', { name: /WETH payout address/ })).toBeNull()
  expect(signMessage).toHaveBeenCalledTimes(1)
})

it('opens a Solana partner dashboard only after signing with its selected wallet', async () => {
  const { address, publicKey, connected } = fixture()
  const store = createStore()
  store.set(solanaConnectionAtom, connected)
  const post = jest.fn(async (_url: string, _init: RequestInit) => ({
    ok: true,
    json: async () => ({
      wallet: address,
      kind: 'partner',
      activeCodes: ['solpartner'],
      referredCount: 0,
      currentCycleVolumeUsd: 0,
      lifetimeReferredVolumeUsd: 0,
      referees: [],
    }),
  }))
  global.fetch = post as unknown as typeof fetch
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/partner?network=solana']}>
        <PartnerPage />
      </MemoryRouter>
    </Provider>,
  )
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Access Partner Dashboard/i }))
  expect(await screen.findByText('https://swap.ophis.fi/?ref=solpartner#/swap?network=solana')).toBeTruthy()
  const [url, init] = post.mock.calls[0]
  expect(url).toMatch(/\/partner$/)
  const body = JSON.parse(String(init.body))
  expect(body.wallet).toBe(address)
  expect(body.chainId).toBeUndefined()
  const expected = `Ophis Partner Dashboard access\nAddress: ${address}\nIssued: ${body.issued}\nChain: solana:mainnet`
  expect(verify(null, Buffer.from(expected), publicKey, utils.arrayify(body.signature))).toBe(true)
})
