import { createStore } from 'jotai'

import {
  fetchOphisSolanaQuote,
  fetchOphisWalletActionContext,
  sendOphisSolanaWalletTransaction,
  solanaAddress,
} from '@ophis/solana-sdk'
import { solanaConnectionAtom, type SolanaConnection } from 'entities/solana'

import {
  manageNativeSolanaOrderAtom,
  recordOrderActionAtom,
  savedNativeSolanaOrdersAtom,
  visibleNativeSolanaOrdersAtom,
} from './orders.atoms'
import { nativeSolanaFormAtom, nativeSolanaReviewAtom, requestNativeSolanaQuoteAtom } from './trade.atoms'

import { nativeSolanaErrorMessage } from '../services/trade.service'
import { balanceEndpoint, mainnetWalletRpc } from '../services/assets.service'

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    OphisSolanaHttpError: class extends Error {},
    solanaAddress: (value: string) => value,
    OPHIS_LOCAL_WALLET_RPC: 'http://127.0.0.1:18899',
    SOLANA_NATIVE_ASSET: 'native',
    TOKEN_PROGRAM_ADDRESS: 'token',
    fetchOphisSolanaChainContext: async () => ({ programAddress: 'own-program', genesisHash: 'own-genesis' }),
    fetchOphisWalletActionContext: jest.fn().mockResolvedValue({ lastValidBlockHeight: 10n }),
    sendOphisSolanaWalletTransaction: jest.fn().mockResolvedValue('1'.repeat(64)),
    getOrderIntentDecoder: () => ({ decode: () => ({ owner: 'owner' }) }),
    prepareOphisSolanaCancellation: jest.fn(),
    prepareOphisSolanaReclaim: jest.fn(),
    fetchOphisSolanaMint: async (_api: string, address: string) => ({
      address,
      tokenProgram: 'token',
      decimals: 6,
      extensions: [],
    }),
    parseOphisSolanaAmount: () => 1000000n,
    fetchOphisSolanaQuote: jest.fn(),
    ophisSolanaWalletSigner: jest.fn(),
    prepareOphisSolanaOrderFromQuote: async () => ({ instructions: [], payer: 'owner' }),
    previewOphisLocalOrder: async () => 1n,
  }),
  { virtual: true },
)
jest.mock('../services/privateSettlement.service', () => ({ privateWalletRpc: 'http://localhost/private/wallet-rpc' }))

jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: {
    api: 'https://native.ophis.example',
    program: 'own-program',
    genesis: 'own-genesis',
    chain: 'solana:localnet',
  },
  solanaConnectionAtom: jest.requireActual<typeof import('jotai')>('jotai').atom(null),
}))

function connection(address: string): SolanaConnection {
  return { wallet: { name: 'Fixture' }, account: { address } } as SolanaConnection
}

it('uses the swap gateway for mainnet balances and payout confirmations', () => {
  const config = {
    chain: 'solana:mainnet' as const,
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    program: solanaAddress('BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h'),
    api: 'https://solana-mainnet.ophis.fi/solana-api',
  }
  for (const api of [config.api, window.location.origin + '/solana-api']) {
    expect(mainnetWalletRpc({ ...config, api: api + '/' })).toBe(api + '/wallet-rpc')
    expect(balanceEndpoint({ ...config, api })).toBe(api + '/wallet-rpc')
  }
  expect(mainnetWalletRpc({ ...config, chain: 'solana:devnet' })).toBeUndefined()
  expect(mainnetWalletRpc({ ...config, api: 'https://example.org/solana-api' })).toBeUndefined()
})

it('explains how to recover from a local blockhash simulation failure', () => {
  const error = new Error(
    'Solana RPC sendTransaction failed (-32002): Transaction simulation failed: Blockhash not found',
  )
  expect(nativeSolanaErrorMessage(error)).toMatch(/127\.0\.0\.1:18899.*fresh quote/)
  expect(nativeSolanaErrorMessage(new Error('User rejected'))).toBe('User rejected')
})

it('discards a quote if the wallet or form changed while the request was running', async () => {
  const store = createStore()
  const first = connection('CaseSensitiveOwner')
  const second = connection('caseSensitiveOwner')
  store.set(solanaConnectionAtom, first)
  store.set(nativeSolanaFormAtom, { sellMint: 'SOL', buyMint: 'mint', amount: '1', slippageBps: 50 })
  const quote = { verified: true }
  let release: (value: unknown) => void = () => undefined
  jest.mocked(fetchOphisSolanaQuote).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const request = store.set(requestNativeSolanaQuoteAtom)
  await new Promise((resolve) => setTimeout(resolve, 0))
  store.set(solanaConnectionAtom, second)
  release(quote)
  await request
  expect(store.get(nativeSolanaReviewAtom)).toBeNull()
  jest.mocked(fetchOphisSolanaQuote).mockResolvedValue(quote as Awaited<ReturnType<typeof fetchOphisSolanaQuote>>)
  await store.set(requestNativeSolanaQuoteAtom)
  expect(store.get(nativeSolanaReviewAtom)?.connection).toBe(second)
  store.set(nativeSolanaFormAtom, { ...store.get(nativeSolanaFormAtom), amount: '2' })
  expect(store.get(nativeSolanaReviewAtom)).toBeNull()
})

it('ignores malformed saved data and isolates recovered orders by exact wallet and deployment', () => {
  const store = createStore()
  store.set(solanaConnectionAtom, connection('CaseSensitiveOwner'))
  const saved = {
    uid: `0x${'12'.repeat(32)}`,
    owner: 'CaseSensitiveOwner',
    program: 'own-program',
    genesis: 'own-genesis',
    orderPda: 'order',
    createdBy: 'CaseSensitiveOwner',
    signature: null,
    reclaimed: false,
    intent: new Array<number>(213).fill(0),
  }
  store.set(savedNativeSolanaOrdersAtom, { [saved.uid]: saved })
  expect(store.get(visibleNativeSolanaOrdersAtom)).toEqual([saved])
  store.set(solanaConnectionAtom, connection('caseSensitiveOwner'))
  expect(store.get(visibleNativeSolanaOrdersAtom)).toEqual([])
  store.set(solanaConnectionAtom, connection('CaseSensitiveOwner'))
  store.set(savedNativeSolanaOrdersAtom, { [saved.uid]: { ...saved, genesis: 'another-cluster' } })
  expect(store.get(visibleNativeSolanaOrdersAtom)).toEqual([])
  store.set(savedNativeSolanaOrdersAtom, { [saved.uid]: { ...saved, intent: [300] } })
  expect(store.get(visibleNativeSolanaOrdersAtom)).toEqual([])
})

it.each([false, true])(
  'uses owner RPC for an open wallet action (reclaim=%s) and waits for finality',
  async (reclaim) => {
    const store = createStore()
    const uid = '0x' + '12'.repeat(32)
    const signature = '1'.repeat(64)
    store.set(solanaConnectionAtom, connection('owner'))
    store.set(savedNativeSolanaOrdersAtom, {
      [uid]: {
        uid,
        owner: 'owner',
        createdBy: 'owner',
        orderPda: 'pda',
        program: 'own-program',
        genesis: 'own-genesis',
        intent: Array(213).fill(0),
        signature: null,
        reclaimed: false,
      },
    })
    jest.mocked(sendOphisSolanaWalletTransaction).mockClear()
    await store.set(manageNativeSolanaOrderAtom, { uid, reclaim })
    expect(fetchOphisWalletActionContext).toHaveBeenCalledWith(
      'http://localhost/private/wallet-rpc',
      'own-program',
      'own-genesis',
    )
    expect(store.get(savedNativeSolanaOrdersAtom)[uid]).toMatchObject({
      reclaimed: false,
      walletAction: { reclaim, signature, status: 'pending' },
    })
    await store.set(manageNativeSolanaOrderAtom, { uid, reclaim })
    expect(sendOphisSolanaWalletTransaction).toHaveBeenCalledTimes(1)
    store.set(recordOrderActionAtom, { uid, signature, status: 'confirmed' })
    expect(store.get(savedNativeSolanaOrdersAtom)[uid].reclaimed).toBe(reclaim)
  },
)
