import { solanaPairingChain, type OphisSolanaConfig } from 'entities/solana'
import { utils } from 'ethers'

import { pairSolanaWallet } from './walletConnect.service'

jest.mock('@cowprotocol/wallet', () => ({ walletConnectSvg: '<svg/>' }))
jest.mock('@ophis/solana-sdk', () => ({ solanaAddress: (value: string) => value }), { virtual: true })
jest.mock('entities/solana', () => jest.requireActual('entities/solana/solana.constants'))
jest.mock('@walletconnect/sign-client', () => ({
  __esModule: true,
  default: { init: jest.fn(async () => mockClient) },
}))

const config: OphisSolanaConfig = {
  chain: 'solana:devnet',
  genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  api: 'https://example.invalid',
  program: '11111111111111111111111111111111' as OphisSolanaConfig['program'],
}
const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const method = 'solana_signAndSendTransaction'
const feature = 'solana:signAndSendTransaction'
const address = config.program
const session = {
  expiry: Math.floor(Date.now() / 1000) + 300,
  namespaces: { solana: { methods: [method], accounts: [chainId + ':' + address] } },
}
const mockClient = {
  core: { pairing: { disconnect: jest.fn(async () => undefined) } },
  connect: jest.fn(async () => ({
    uri: 'wc:fixture@2?relay-protocol=irn',
    approval: async () => ({ topic: 'fixture' }),
  })),
  session: { get: jest.fn(() => session) },
  disconnect: jest.fn(),
  request: jest.fn(async () => ({ signature: utils.base58.encode(new Uint8Array(64)) })),
  on: jest.fn(),
  off: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockClient.session.get.mockReturnValue(session)
})

it('offers pairing only for matching public cluster and genesis, without contacting a relay on localnet', async () => {
  const local = { ...config, chain: 'solana:localnet' } as const
  expect(solanaPairingChain(local)).toBeUndefined()
  expect(solanaPairingChain({ ...config, chain: 'solana:mainnet' })).toBeUndefined()
  await expect(pairSolanaWallet(local, 'test', jest.fn(), new AbortController().signal)).rejects.toThrow('unavailable')
  expect(mockClient.connect).not.toHaveBeenCalled()
})

it('requests only the selected Solana chain and submits through the approved session', async () => {
  const onUri = jest.fn()
  const wallet = await pairSolanaWallet(config, 'test', onUri, new AbortController().signal)
  expect(mockClient.connect).toHaveBeenCalledWith({
    requiredNamespaces: { solana: { chains: [chainId], methods: [method], events: [] } },
    optionalNamespaces: { solana: { chains: [chainId], methods: ['solana_signMessage'], events: [] } },
  })
  expect(onUri).toHaveBeenCalledWith(expect.stringMatching(/^wc:/))
  const [account] = wallet.accounts
  expect(account).toMatchObject({ address, features: [feature], chains: [config.chain] })
  const send = wallet.features[feature].signAndSendTransaction
  const options = { preflightCommitment: 'confirmed' as const, skipPreflight: false }
  const input = { account, chain: config.chain, transaction: new Uint8Array([1, 2, 3]), options }
  await expect(send({ ...input, chain: 'solana:mainnet' })).rejects.toThrow('Reconnect')
  expect(mockClient.request).not.toHaveBeenCalled()
  expect((await send(input))[0].signature).toHaveLength(64)
  expect(mockClient.request).toHaveBeenCalledWith({
    topic: 'fixture',
    chainId,
    request: { method, params: { transaction: 'AQID', options } },
  })
  mockClient.session.get.mockReturnValueOnce({ ...session, expiry: 0 })
  await expect(send(input)).rejects.toThrow('Reconnect')
  expect(mockClient.request).toHaveBeenCalledTimes(1)
  const listener = jest.fn()
  const unsubscribe = wallet.features['standard:events'].on('change', listener)
  const changed = mockClient.on.mock.calls.find(([name]) => name === 'session_delete')?.[1]
  changed({ topic: 'different' })
  expect(listener).not.toHaveBeenCalled()
  changed({ topic: 'fixture' })
  expect(listener).toHaveBeenCalledWith({ accounts: [] })
  unsubscribe()
  expect(mockClient.off).toHaveBeenCalledWith('session_delete', changed)
})

it('disconnects late approvals after cancellation and rejects wallets approving the wrong cluster or method', async () => {
  const abort = new AbortController()
  await expect(pairSolanaWallet(config, 'test', () => abort.abort(), abort.signal)).rejects.toThrow()
  expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'fixture' })
  for (const namespace of [
    { methods: [method], accounts: ['solana:wrong:' + address] },
    { methods: ['solana_signMessage'], accounts: [chainId + ':' + address] },
  ]) {
    mockClient.session.get.mockReturnValueOnce({ ...session, namespaces: { solana: namespace } })
    await expect(pairSolanaWallet(config, 'test', jest.fn(), new AbortController().signal)).rejects.toThrow(
      'must approve',
    )
  }
  expect(mockClient.disconnect).toHaveBeenCalledTimes(3)
})

it('uses base58 message signing only with an approved account and method', async () => {
  const wallet = await pairSolanaWallet(config, 'test', jest.fn(), new AbortController().signal)
  expect(wallet.features['solana:signMessage']).toBeUndefined()
  const approved = {
    ...session,
    namespaces: { solana: { methods: [method, 'solana_signMessage'], accounts: [chainId + ':' + address] } },
  }
  mockClient.session.get.mockReturnValue(approved)
  const approvedWallet = await pairSolanaWallet(config, 'test', jest.fn(), new AbortController().signal)
  const sign = approvedWallet.features['solana:signMessage']!.signMessage
  const message = new Uint8Array([1, 2, 3])
  const account = approvedWallet.accounts[0]
  mockClient.session.get.mockReturnValueOnce(session)
  await expect(sign({ account, message })).rejects.toThrow('supports Solana message signing')
  const [signed] = await sign({ account, message })
  expect(signed.signedMessage).toEqual(message)
  expect(signed.signature).toHaveLength(64)
  expect(mockClient.request).toHaveBeenCalledWith({
    topic: 'fixture',
    chainId,
    request: { method: 'solana_signMessage', params: { pubkey: address, message: utils.base58.encode(message) } },
  })
})
