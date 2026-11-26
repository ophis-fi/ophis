import { createStore } from 'jotai'

import {
  readOphisOrderAccount,
  readOphisSellAllowance,
  sendOphisSolanaWalletTransaction,
  solanaAddress,
} from '@ophis/solana-sdk'
import { solanaConnectionAtom, type SolanaConnection } from 'entities/solana'

import { savedNativeSolanaOrdersAtom, type SavedNativeSolanaOrder } from './orders.atoms'
import { createNativeSolanaOrderAtom } from './placeOrder.atoms'
import {
  nativeSolanaBusyAtom,
  nativeSolanaErrorAtom,
  nativeSolanaFormAtom,
  nativeSolanaReviewAtom,
  requestNativeSolanaQuoteAtom,
} from './trade.atoms'

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    OphisSolanaHttpError: class extends Error {},
    solanaAddress: (address: string) => address,
    SOLANA_NATIVE_ASSET: 'native',
    TOKEN_PROGRAM_ADDRESS: 'token',
    fetchOphisSolanaMint: async (_api: string, address: string) => ({ address, tokenProgram: 'token', decimals: 6 }),
    fetchOphisSolanaChainContext: async () => ({
      programAddress: 'program',
      genesisHash: 'genesis',
      lastValidBlockHeight: 135n,
    }),
    verifyOphisMintMetadata: jest.fn(),
    readOphisSellAllowance: jest.fn().mockResolvedValue(null),
    parseOphisSolanaAmount: () => 1000000000n,
    fetchOphisSolanaQuote: async () => ({
      verified: true,
      quote: {},
      expiration: new Date(Date.now() + 60_000).toISOString(),
    }),
    checkedQuoteAppData: jest.fn(),
    ophisSolanaWalletSigner: jest.fn(),
    prepareOphisSolanaOrderFromQuote: async () => ({
      uid: '0x' + '12'.repeat(32),
      orderPda: 'pda',
      payer: 'owner',
      intent: { sellTokenAccount: 'sell-account' },
      instructions: [],
    }),
    getOrderIntentEncoder: () => ({ encode: () => new Uint8Array(213).fill(13) }),
    getOrderIntentDecoder: () => ({
      decode: () => ({ sellTokenAccount: 'sell-account', validTo: Math.floor(Date.now() / 1000) + 1800 }),
    }),
    readOphisOrderAccount: jest.fn().mockResolvedValue({
      account: { cancelled: false, amountWithdrawn: 0n, intent: { sellAmount: 10n } },
      slot: 8n,
    }),
    sendOphisSolanaWalletTransaction: jest.fn(),
  }),
  { virtual: true },
)
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.org', genesis: 'genesis', program: 'program', chain: 'solana:devnet' },
  solanaConnectionAtom: jest.requireActual<typeof import('jotai')>('jotai').atom(null),
}))
jest.mock('../services/privateSettlement.service', () => ({ privateSettlementEnabled: false }))

const uid = '0x' + '12'.repeat(32)
const signature = '1'.repeat(64)
const savedOrder: SavedNativeSolanaOrder = {
  uid,
  owner: 'owner',
  createdBy: 'owner',
  program: 'program',
  genesis: 'genesis',
  orderPda: 'pda',
  intent: new Array<number>(213).fill(13),
  signature: null,
  reclaimed: false,
}
const send = jest.mocked(sendOphisSolanaWalletTransaction)
const allowance = jest.mocked(readOphisSellAllowance)

async function reviewedStore(): Promise<ReturnType<typeof createStore>> {
  const store = createStore()
  store.set(solanaConnectionAtom, { wallet: { name: 'Fixture' }, account: { address: 'owner' } } as SolanaConnection)
  store.set(nativeSolanaFormAtom, { sellMint: 'SOL', buyMint: 'buy', amount: '1', slippageBps: 50 })
  await store.set(requestNativeSolanaQuoteAtom)
  expect(store.get(nativeSolanaReviewAtom)).toBeTruthy()
  return store
}

function ordersAfterReload(): Record<string, SavedNativeSolanaOrder> {
  const store = createStore()
  const unsubscribe = store.sub(savedNativeSolanaOrdersAtom, () => {})
  const orders = store.get(savedNativeSolanaOrdersAtom)
  unsubscribe()
  return orders
}

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
})

it('persists the unsigned recovery record at broadcast and replaces it with the signed receipt on success', async () => {
  const store = await reviewedStore()
  const snapshots: ReturnType<typeof ordersAfterReload>[] = []
  send.mockImplementationOnce(async ({ onBeforeBroadcast }) => {
    snapshots.push(ordersAfterReload())
    onBeforeBroadcast?.()
    snapshots.push(ordersAfterReload())
    return signature
  })
  await store.set(createNativeSolanaOrderAtom)
  const record = { ...savedOrder, creationLifetime: { height: '135', requestedAt: expect.any(Number) } }
  expect(snapshots).toEqual([{}, { [uid]: record }])
  expect(ordersAfterReload()).toEqual({ [uid]: { ...record, signature } })
  expect(store.get(nativeSolanaErrorAtom)).toBeNull()
  expect(store.get(nativeSolanaReviewAtom)).toBeNull()
  expect(store.get(nativeSolanaBusyAtom)).toBe(false)
})

it('leaves no recovery record when the wallet rejects before broadcast', async () => {
  const store = await reviewedStore()
  const review = store.get(nativeSolanaReviewAtom)
  send.mockRejectedValueOnce(new Error('User rejected'))
  await store.set(createNativeSolanaOrderAtom)
  expect(store.get(nativeSolanaErrorAtom)).toBe('User rejected')
  expect(ordersAfterReload()).toEqual({})
  expect(store.get(nativeSolanaReviewAtom)).toBe(review)
  expect(store.get(nativeSolanaBusyAtom)).toBe(false)
})

it('recovers an ambiguous broadcast and blocks a duplicate while its order account is missing', async () => {
  const store = await reviewedStore()
  send.mockImplementationOnce(async ({ onBeforeBroadcast }) => {
    onBeforeBroadcast?.()
    throw new Error('RPC timed out')
  })
  await store.set(createNativeSolanaOrderAtom)
  expect(store.get(nativeSolanaErrorAtom)).toBe('RPC timed out')
  const saved = ordersAfterReload()
  expect(saved[uid]).toMatchObject({ signature: null, creationLifetime: { height: '135' } })
  const reloaded = await reviewedStore()
  const unsubscribe = reloaded.sub(savedNativeSolanaOrdersAtom, () => {})
  jest.mocked(readOphisOrderAccount).mockResolvedValueOnce({ account: null, slot: 8n })
  await reloaded.set(createNativeSolanaOrderAtom)
  unsubscribe()
  expect(readOphisOrderAccount).toHaveBeenCalledWith('https://api.devnet.solana.com', 'genesis', 'program', uid, 'pda')
  expect(reloaded.get(nativeSolanaErrorAtom)).toMatch(/has a pending order/)
  expect(send).toHaveBeenCalledTimes(1)
  expect(ordersAfterReload()).toEqual(saved)
})

it('blocks a new order when the same sell token account still has an open on-chain order', async () => {
  const store = await reviewedStore()
  const openUid = '0x' + '34'.repeat(32)
  const open = { ...savedOrder, uid: openUid, orderPda: 'other-pda', signature }
  store.set(savedNativeSolanaOrdersAtom, { [openUid]: open })
  await store.set(createNativeSolanaOrderAtom)
  expect(readOphisOrderAccount).toHaveBeenCalledWith(
    'https://api.devnet.solana.com',
    'genesis',
    'program',
    openUid,
    'other-pda',
  )
  expect(store.get(nativeSolanaErrorAtom)).toMatch(/has a pending order/)
  expect(send).not.toHaveBeenCalled()
  expect(ordersAfterReload()).toEqual({ [openUid]: open })
})

it('stops before asking the wallet to send if the wallet disconnects during preparation', async () => {
  const store = await reviewedStore()
  const placement = store.set(createNativeSolanaOrderAtom)
  expect(store.get(nativeSolanaBusyAtom)).toBe(true)
  store.set(solanaConnectionAtom, null)
  await placement
  expect(store.get(nativeSolanaErrorAtom)).toMatch(/wallet or trade changed/)
  expect(store.get(nativeSolanaReviewAtom)).toBeNull()
  expect(store.get(nativeSolanaBusyAtom)).toBe(false)
  expect(send).not.toHaveBeenCalled()
  expect(ordersAfterReload()).toEqual({})
})

it.each([
  { reviewed: 10n, current: 11n, replace: true, error: /allowance changed/ },
  { reviewed: 10n, current: 10n, replace: false, error: /Review the existing token allowance/ },
])(
  'checks the reviewed allowance ($reviewed → $current, replace=$replace)',
  async ({ reviewed, current, replace, error }) => {
    const delegate = solanaAddress('delegate')
    allowance.mockResolvedValueOnce({ delegate, atoms: reviewed }).mockResolvedValueOnce({ delegate, atoms: current })
    const store = await reviewedStore()
    await store.set(createNativeSolanaOrderAtom, replace)
    expect(store.get(nativeSolanaErrorAtom)).toMatch(error)
    if (reviewed !== current) {
      expect(store.get(nativeSolanaReviewAtom)).toBeNull()
      allowance.mockResolvedValueOnce({ delegate, atoms: current })
      await store.set(requestNativeSolanaQuoteAtom)
      expect(store.get(nativeSolanaReviewAtom)?.allowance?.atoms).toBe(current)
    } else {
      expect(store.get(nativeSolanaReviewAtom)?.allowance?.atoms).toBe(reviewed)
    }
    expect(send).not.toHaveBeenCalled()
    expect(ordersAfterReload()).toEqual({})
  },
)
