import { createStore } from 'jotai'

import { fetchOphisSolanaOrder, readOphisOrderAccount, type OphisSolanaOrder } from '@ophis/solana-sdk'
import { solanaConnectionAtom, type SolanaConnection } from 'entities/solana'
import { queryClientAtom } from 'jotai-tanstack-query'

import { indexedOrderAtom, orderDepositAtom, pageSize, walletActivityAtom } from './history.atoms'
import { savedNativeSolanaOrdersAtom } from './orders.atoms'

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    fetchOphisSolanaOrder: jest.fn(),
    readOphisOrderAccount: jest.fn(),
    solanaAddress: (value: string) => value,
  }),
  { virtual: true },
)
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.org', genesis: 'genesis', program: 'program', chain: 'solana:mainnet' },
  solanaConnectionAtom: jest.requireActual('jotai').atom(null),
}))
jest.mock('../services/assets.service', () => ({ balanceEndpoint: () => 'https://rpc.example.org' }))
jest.mock('../services/privateSettlement.service', () => ({ privateSettlementEnabled: false }))

const uid = '0x' + 'ab'.repeat(32)
const owner = 'owner'
const connection = (address: string): SolanaConnection => ({ account: { address } }) as SolanaConnection

const order = {
  uid,
  owner,
  createdBy: owner,
  program: 'program',
  genesis: 'genesis',
  orderPda: 'pda',
  intent: Array(213).fill(0),
  signature: null,
  reclaimed: false,
}

it('reads finalized rent for the saved order owner and stops after reclamation', async () => {
  const store = createStore()

  store.set(savedNativeSolanaOrdersAtom, { [uid]: order })
  store.set(solanaConnectionAtom, connection('other'))
  const deposit = orderDepositAtom(uid)
  expect(store.get(deposit).isEnabled).toBe(false)
  const read = jest.mocked(readOphisOrderAccount)
  expect(read).not.toHaveBeenCalled()

  read.mockResolvedValue({ account: {}, slot: 1n, lamports: 1493440n } as Awaited<
    ReturnType<typeof readOphisOrderAccount>
  >)
  store.set(solanaConnectionAtom, connection(owner))
  expect((await store.get(deposit).refetch()).data).toBe(1493440n)
  expect(read).toHaveBeenCalledWith('https://rpc.example.org', 'genesis', 'program', uid, 'pda', 'finalized')
  expect(store.get(queryClientAtom).getQueryData(['solanaOrderDeposit', 'genesis', owner, uid])).toBe(1493440n)
  store.set(solanaConnectionAtom, connection('other'))
  expect(store.get(deposit).data).toBeUndefined()

  read.mockResolvedValue({ account: null, slot: 2n })
  store.set(solanaConnectionAtom, connection(owner))
  expect((await store.get(deposit).refetch()).data).toBeNull()
  store.set(savedNativeSolanaOrdersAtom, {
    [uid]: {
      ...order,
      reclaimed: true,
      walletAction: { reclaim: true, signature: null, status: 'confirmed', lastHeight: '1' },
    },
  })
  expect(store.get(deposit).isEnabled).toBe(false)
})

it('rejects indexed receipt data belonging to another wallet', async () => {
  const store = createStore()
  store.set(solanaConnectionAtom, connection(owner))
  jest.mocked(fetchOphisSolanaOrder).mockResolvedValue({ uid, owner: 'other' } as OphisSolanaOrder)
  await expect(store.get(indexedOrderAtom(uid)).refetch({ throwOnError: true })).rejects.toThrow(
    'Indexed order identity mismatch.',
  )
})

it('merges loaded history pages with local attempts and isolates a new wallet', () => {
  const store = createStore()
  const cache = store.get(queryClientAtom)
  const seedPage = (
    who: string,
    page: number,
    rows: Array<{ orderUid: string; txSignature: string; instructionIndex: number }>,
  ): void => {
    cache.setQueryData(['ophisSolanaTrades', 'https://example.org', 'genesis', who, page], rows)
  }
  const fills = Array.from({ length: pageSize }, (_, index) => ({
    orderUid: String(index),
    txSignature: 'batch',
    instructionIndex: index,
  }))
  seedPage(owner, 0, fills)
  seedPage(owner, 1, [fills[0], { ...fills[0], orderUid: uid }])
  store.set(solanaConnectionAtom, connection(owner))
  store.set(savedNativeSolanaOrdersAtom, { [uid]: order })
  expect(store.get(walletActivityAtom(0))).toMatchObject({ trades: fills, saved: [order], hasMore: true })
  const older = store.get(walletActivityAtom(1))
  expect(older.trades.map((row) => row.orderUid)).toEqual([...fills.map((row) => row.orderUid), uid])
  expect(older.saved).toEqual([])
  expect(older.hasMore).toBe(false)
  seedPage('other', 0, [])
  store.set(solanaConnectionAtom, connection('other'))
  expect(store.get(walletActivityAtom(0))).toMatchObject({ trades: [], saved: [], hasMore: false })
})
