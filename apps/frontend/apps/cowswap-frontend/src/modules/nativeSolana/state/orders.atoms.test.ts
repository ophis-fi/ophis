import { createStore } from 'jotai'

import {
  fetchOphisWalletActionReceipt,
  fetchOphisSolanaOrder,
  formatOphisSolanaAmount,
  SOLANA_NATIVE_ASSET,
  type OphisSolanaOrder,
} from '@ophis/solana-sdk'
import { solanaConnectionAtom, type SolanaConnection } from 'entities/solana'
import { queryClientAtom } from 'jotai-tanstack-query'

import { nativeSolanaOrderQueryAtom, savedNativeSolanaOrdersAtom } from './orders.atoms'

import { walletHoldingsKey } from '../services/assets.service'
import { checkAtomicReceipt, orderPollInterval } from '../services/atomicReceipt.service'
import { receiptAmount } from '../services/receipt.service'

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    fetchOphisSolanaOrder: jest.fn(),
    fetchOphisWalletActionReceipt: jest.fn(),
    formatOphisSolanaAmount: jest.fn(),
    SOLANA_NATIVE_ASSET: '11111111111111111111111111111111',
  }),
  {
    virtual: true,
  },
)
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.org', chain: 'solana:devnet', genesis: 'genesis', program: 'program' },
  solanaConnectionAtom: jest.requireActual('jotai').atom(null),
}))
jest.mock('../services/privateSettlement.service', () => ({ privateSettlementEnabled: false }))

it('uses nine SOL decimals for receipts without any wallet or catalog assets', () => {
  jest.mocked(formatOphisSolanaAmount).mockReturnValueOnce('1')
  expect(receiptAmount('1000000000', SOLANA_NATIVE_ASSET, [])).toMatchObject({
    asset: { symbol: 'SOL', decimals: 9 },
    value: '1',
  })
  expect(formatOphisSolanaAmount).toHaveBeenCalledWith(1000000000n, 9)
})

it('refreshes only the order owner’s holdings when placement or payout first appears', async () => {
  const store = createStore()
  const cache = store.get(queryClientAtom)
  const uid = '0x' + 'ab'.repeat(32)
  const key = walletHoldingsKey('genesis', 'owner')
  const other = walletHoldingsKey('genesis', 'other')
  store.set(solanaConnectionAtom, { account: { address: 'owner' } } as SolanaConnection)
  store.set(savedNativeSolanaOrdersAtom, {
    [uid]: {
      uid,
      owner: 'owner',
      createdBy: 'owner',
      orderPda: 'pda',
      program: 'program',
      genesis: 'genesis',
      intent: Array(213).fill(0),
      signature: null,
      reclaimed: false,
    },
  })
  cache.setQueryData(other, [])
  const order = { uid, owner: 'owner', orderPda: 'pda' }
  const query = store.get(nativeSolanaOrderQueryAtom(uid))
  for (const [status, changed] of [
    ['open', true],
    ['open', false],
    ['fulfilled', true],
    ['fulfilled', false],
  ] as const) {
    jest.mocked(fetchOphisSolanaOrder).mockResolvedValue({ ...order, status } as OphisSolanaOrder)
    cache.setQueryData(key, [])
    expect((await query.refetch()).data?.status).toBe(status)
    expect(cache.getQueryState(key)?.isInvalidated).toBe(changed)
    expect(cache.getQueryState(other)?.isInvalidated).toBe(false)
  }
})

it('reads the wallet-paid settlement signature even after the order account has closed', async () => {
  const store = createStore()
  const uid = '0x' + 'cd'.repeat(32)
  const tx = '1'.repeat(64)
  const blockhash = '1'.repeat(32)
  store.set(solanaConnectionAtom, { account: { address: 'owner' } } as SolanaConnection)
  store.set(savedNativeSolanaOrdersAtom, {
    [uid]: {
      uid,
      owner: 'owner',
      createdBy: 'owner',
      orderPda: 'pda',
      program: 'program',
      genesis: 'genesis',
      intent: Array(213).fill(0),
      signature: tx,
      executionMode: 'walletAtomic',
      creationLifetime: { height: '135', requestedAt: Date.now(), blockhash },
      reclaimed: false,
    },
  })
  jest.mocked(fetchOphisWalletActionReceipt).mockResolvedValue({ status: 'confirmed', slot: 21n })
  expect((await store.get(nativeSolanaOrderQueryAtom(uid)).refetch()).data?.status).toBe('fulfilled')
  expect(fetchOphisWalletActionReceipt).toHaveBeenCalledWith(
    'https://api.devnet.solana.com',
    'genesis',
    tx,
    135n,
    'confirmed',
    blockhash,
  )
  const order = store.get(savedNativeSolanaOrdersAtom)[uid]
  const unsigned = { ...order, signature: null }
  const indexed = { uid, owner: order.owner, orderPda: order.orderPda, status: 'fulfilled' } as OphisSolanaOrder
  const lookup = jest.mocked(fetchOphisSolanaOrder)
  lookup.mockResolvedValueOnce({ ...indexed, owner: 'someone-else' })
  lookup.mockResolvedValueOnce({ ...indexed, orderPda: 'another-order' })
  lookup.mockResolvedValueOnce(indexed)
  expect(await checkAtomicReceipt(unsigned)).toEqual({ status: 'pending' })
  expect(await checkAtomicReceipt(unsigned)).toEqual({ status: 'pending' })
  expect(await checkAtomicReceipt(unsigned)).toEqual(indexed)
  expect(lookup).toHaveBeenCalledWith('https://example.org', uid)
  expect(orderPollInterval('unconfirmed', unsigned, true)).toBe(60_000)
  expect(orderPollInterval('unconfirmed', order, true)).toBe(false)
})
