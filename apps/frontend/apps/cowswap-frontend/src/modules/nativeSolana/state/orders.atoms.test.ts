import { createStore } from 'jotai'

import { fetchOphisSolanaOrder, type OphisSolanaOrder } from '@ophis/solana-sdk'
import { solanaConnectionAtom, type SolanaConnection } from 'entities/solana'
import { queryClientAtom } from 'jotai-tanstack-query'

import { nativeSolanaOrderQueryAtom, savedNativeSolanaOrdersAtom } from './orders.atoms'

import { walletHoldingsKey } from '../services/assets.service'

jest.mock('@ophis/solana-sdk', () => ({ fetchOphisSolanaOrder: jest.fn() }), { virtual: true })
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.org', genesis: 'genesis', program: 'program' },
  solanaConnectionAtom: jest.requireActual('jotai').atom(null),
}))
jest.mock('../services/privateSettlement.service', () => ({ privateSettlementEnabled: false }))

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
