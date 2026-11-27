import { createStore } from 'jotai'

import {
  fetchOphisSolanaChainContext,
  fetchOphisSolanaQuote,
  OphisSolanaHttpError,
  readOphisOrderAccount,
  fetchOphisWalletActionContext,
  fetchOphisWalletActionReceipt,
  sendOphisSolanaWalletTransaction,
  solanaAddress,
} from '@ophis/solana-sdk'
import { solanaConnectionAtom, type SolanaConnection } from 'entities/solana'
import { queryClientAtom } from 'jotai-tanstack-query'

import { manageNativeSolanaOrderAtom, orderActionReceiptAtom, recordOrderActionAtom } from './orderActions.atoms'
import { savedNativeSolanaOrdersAtom, visibleNativeSolanaOrdersAtom } from './orders.atoms'
import { nativeSolanaFormAtom, nativeSolanaReviewAtom, requestNativeSolanaQuoteAtom } from './trade.atoms'

import { balanceEndpoint, mainnetWalletRpc, walletHoldingsKey } from '../services/assets.service'
import { nativeSolanaErrorMessage } from '../services/trade.service'

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    OphisSolanaHttpError: class extends Error {},
    solanaAddress: (value: string) => value,
    OPHIS_LOCAL_WALLET_RPC: 'http://127.0.0.1:18899',
    SOLANA_NATIVE_ASSET: 'native',
    TOKEN_PROGRAM_ADDRESS: 'token',
    fetchOphisSolanaChainContext: jest
      .fn()
      .mockResolvedValue({ programAddress: 'own-program', genesisHash: 'own-genesis' }),
    fetchOphisWalletActionReceipt: jest.fn().mockResolvedValue({ status: 'pending' }),
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
    checkedQuoteAppData: jest.fn(),
    readOphisSellAllowance: async () => null,
    verifyOphisMintMetadata: async () => undefined,
    identifyOphisSolanaOrder: async () => ({ uid: '0x' + '12'.repeat(32), orderPda: 'pda' }),
    readOphisOrderAccount: jest.fn().mockResolvedValue({ account: { createdBy: 'owner' }, slot: 93n }),
    prepareOphisSolanaOrderFromQuote: async () => ({ instructions: [], payer: 'owner' }),
    previewOphisLocalOrder: async () => 1n,
  }),
  { virtual: true },
)
jest.mock('../services/privateSettlement.service', () => ({ privateWalletRpc: 'http://localhost/private/wallet-rpc' }))

jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_MAINNET_API: 'https://solana-mainnet.ophis.fi/solana-api',
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

it('distinguishes unsupported transfer rules and absent liquidity, and refuses an indicative price', async () => {
  const unsupported = Object.assign(new OphisSolanaHttpError(400), { errorType: 'UnsupportedToken' })
  const noLiquidity = Object.assign(new OphisSolanaHttpError(400), { errorType: 'NoLiquidity' })
  expect(nativeSolanaErrorMessage(unsupported)).toMatch(/transfer rules/)
  expect(nativeSolanaErrorMessage(noLiquidity)).toMatch(/no route for this pair and amount/)
  const noFeePrice = Object.assign(new OphisSolanaHttpError(409), { errorType: 'NativeFeePriceUnavailable' })
  const insufficientSol = Object.assign(new OphisSolanaHttpError(400), { errorType: 'InsufficientSolForFees' })
  expect(nativeSolanaErrorMessage(noFeePrice)).toMatch(/price its fee in SOL/)
  expect(nativeSolanaErrorMessage(insufficientSol)).toMatch(/needs more SOL for swap fees and deposits/)
  const a = '11111111111111111111111111111112'
  const b = '11111111111111111111111111111113'
  const store = createStore()
  store.set(solanaConnectionAtom, connection('CaseSensitiveOwner'))
  store.set(nativeSolanaFormAtom, { sellMint: a, buyMint: b, amount: '1', slippageBps: 125 })
  const context = await fetchOphisSolanaChainContext('https://native.ophis.example')
  jest.mocked(fetchOphisSolanaChainContext).mockResolvedValueOnce({ ...context, walletAtomic: true })
  jest
    .mocked(fetchOphisSolanaQuote)
    .mockResolvedValueOnce({ verified: false } as Awaited<ReturnType<typeof fetchOphisSolanaQuote>>)
  await store.set(requestNativeSolanaQuoteAtom)
  expect(fetchOphisSolanaQuote).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      sellToken: a,
      buyToken: b,
      slippageBps: 125,
      priceQuality: 'verified',
    }),
  )
  expect(store.get(nativeSolanaReviewAtom)).toBeNull()
})

it('discards a quote if the wallet or form changed while the request was running', async () => {
  const store = createStore()
  const first = connection('CaseSensitiveOwner')
  const second = connection('caseSensitiveOwner')
  store.set(solanaConnectionAtom, first)
  store.set(nativeSolanaFormAtom, { sellMint: 'SOL', buyMint: 'mint', amount: '1', slippageBps: 50 })
  const quote = { verified: true, expiration: new Date(Date.now() + 60_000).toISOString() }
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
    store.set(savedNativeSolanaOrdersAtom, (all) => ({ [uid]: { ...all[uid], orderPda: 'another-pda' } }))
    jest.mocked(sendOphisSolanaWalletTransaction).mockClear()
    await store.set(manageNativeSolanaOrderAtom, { uid, reclaim })
    expect(sendOphisSolanaWalletTransaction).not.toHaveBeenCalled()
    store.set(savedNativeSolanaOrdersAtom, (all) => ({ [uid]: { ...all[uid], orderPda: 'pda' } }))
    jest.mocked(sendOphisSolanaWalletTransaction).mockClear()
    await store.set(manageNativeSolanaOrderAtom, { uid, reclaim })
    expect(readOphisOrderAccount).toHaveBeenCalledWith(
      'http://localhost/private/wallet-rpc',
      'own-genesis',
      'own-program',
      uid,
      'pda',
      'finalized',
    )
    expect(fetchOphisWalletActionContext).toHaveBeenCalledWith(
      'http://localhost/private/wallet-rpc',
      'own-program',
      'own-genesis',
    )
    expect(store.get(savedNativeSolanaOrdersAtom)[uid]).toMatchObject({
      reclaimed: false,
      walletAction: { reclaim, signature, observedSlot: '93', status: 'pending' },
    })
    await store.set(manageNativeSolanaOrderAtom, { uid, reclaim })
    expect(sendOphisSolanaWalletTransaction).toHaveBeenCalledTimes(1)
    const cache = store.get(queryClientAtom)
    const key = walletHoldingsKey('own-genesis', 'owner')
    cache.setQueryData(key, [])
    store.set(recordOrderActionAtom, { uid, signature, lastHeight: '10', status: 'confirmed' })
    expect(store.get(savedNativeSolanaOrdersAtom)[uid].reclaimed).toBe(reclaim)
    expect(cache.getQueryState(key)?.isInvalidated).toBe(true)
  },
)

it('requires a finalized absence at or after the previously observed live account slot to confirm a refund', async () => {
  const store = createStore()
  const uid = '0x' + '41'.repeat(32)
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
      walletAction: { reclaim: true, signature: null, lastHeight: '300', observedSlot: '200', status: 'pending' },
    },
  })
  const read = jest.mocked(readOphisOrderAccount)
  read.mockResolvedValue({ account: null, slot: 199n })
  const query = store.get(orderActionReceiptAtom(uid))
  expect((await query.refetch()).data).toBe('pending')
  read.mockResolvedValue({ account: null, slot: 201n })
  expect((await query.refetch()).data).toBe('confirmed')

  store.set(savedNativeSolanaOrdersAtom, (all) => ({
    [uid]: { ...all[uid], walletAction: { ...all[uid].walletAction!, signature: '1'.repeat(64) } },
  }))
  jest.mocked(fetchOphisWalletActionReceipt).mockResolvedValue({ status: 'confirmed', slot: 250n })
  read.mockResolvedValue({ account: { cancelled: false }, slot: 225n } as Awaited<
    ReturnType<typeof readOphisOrderAccount>
  >)
  const signed = store.get(orderActionReceiptAtom(uid))
  expect((await signed.refetch()).data).toBe('pending')
  read.mockResolvedValue({ account: null, slot: 250n })
  expect((await signed.refetch()).data).toBe('confirmed')
})
