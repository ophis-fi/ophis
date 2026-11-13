import { RELAY_DAPP_ID, RelayHookTerms, RelayQuote } from '@cowprotocol/common-const'
import { OrderKind, SupportedChainId } from '@cowprotocol/cow-sdk'
import { BridgeQuoteResults, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { BRIDGE_QUOTE_ACCOUNT } from 'common/constants/bridgeQuoteAccount'

import { placeConfirmed } from './ophisAcrossPlacement'
import { relayValidToLimit } from './ophisBridgeValidTo'
import { signRelayHook } from './ophisRelayHooks.service'

const OWNER = '0x1111111111111111111111111111111111111111'
const SHED = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x3333333333333333333333333333333333333333'
const NONCE = `0x${'aa'.repeat(32)}`
const mockState = { signer: OWNER, balance: 0n, signatureValid: true, shed: SHED }
const mockSignCalls = jest.fn(async () => ({
  cowShedAccount: mockState.shed,
  gasLimit: 1_200_000n,
  signedMulticall: { to: TOKEN, data: '0x1234' },
}))
jest.mock('@cowprotocol/cow-sdk', () => ({
  ...jest.requireActual('@cowprotocol/cow-sdk'),
  getGlobalAdapter: () => ({ signer: { getAddress: async () => mockState.signer } }),
}))
jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  getRpcProvider: () => ({
    getBlock: async () => ({ timestamp: 1000 }),
    call: async () => `0x${mockState.balance.toString(16)}`,
  }),
}))
jest.mock('@cowprotocol/sdk-cow-shed', () => ({
  ...jest.requireActual('@cowprotocol/sdk-cow-shed'),
  CowShedSdk: jest.fn(() => ({ signCalls: mockSignCalls })),
}))
jest.mock('./ophisAcrossSignature', () => ({ signedByOwner: async () => mockState.signatureValid }))

const request: QuoteBridgeRequest = {
  kind: OrderKind.SELL,
  account: OWNER,
  amount: 10_000n,
  sellTokenChainId: SupportedChainId.BASE,
  sellTokenAddress: TOKEN,
  sellTokenDecimals: 6,
  buyTokenChainId: SupportedChainId.ARBITRUM_ONE,
  buyTokenAddress: TOKEN,
  buyTokenDecimals: 6,
}
const quote = (): RelayQuote =>
  ({ request, depositUntil: 1300, amountsAndCosts: { afterSlippage: { buyAmount: 9900n } } }) as RelayQuote
const terms = (): RelayHookTerms => ({ owner: OWNER, shed: SHED, request, quote: quote() })
const shown = (): BridgeQuoteResults =>
  ({ ...quote(), providerInfo: { dappId: RELAY_DAPP_ID }, tradeParameters: request }) as BridgeQuoteResults
const sign = (value = terms(), deadline = 1200n): ReturnType<typeof signRelayHook> =>
  signRelayHook(
    async () => [],
    value,
    SupportedChainId.BASE,
    { to: TOKEN, data: '0x1234', value: 0n },
    NONCE,
    deadline,
    1_200_000,
  )

beforeEach(() => {
  Object.assign(mockState, { signer: OWNER, balance: 0n, signatureValid: true, shed: SHED })
  mockSignCalls.mockClear()
  localStorage.clear()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) },
  })
})

it('requires a confirmation before asking for a wallet signature', async () => {
  await expect(sign()).rejects.toThrow('changed')
  expect(mockSignCalls).not.toHaveBeenCalled()
})

it('signs the confirmed net minimum and remembers the hook before publishing', async () => {
  const hook = await placeConfirmed(shown(), OWNER, () => sign())
  expect(hook.recipient).toBe(SHED)
  expect(hook.postHook.dappId).toBe(RELAY_DAPP_ID)
  expect(localStorage.getItem(`ophisBridgeHooks:v0:${OWNER}`)).toContain(NONCE)
})

it('rejects a worse net destination minimum before signing', async () => {
  const worse = terms()
  worse.quote.amountsAndCosts.afterSlippage.buyAmount = 9899n
  await expect(placeConfirmed(shown(), OWNER, () => sign(worse))).rejects.toThrow('changed')
  expect(mockSignCalls).not.toHaveBeenCalled()
})

it.each([999n, 1301n])('rejects expired or overlong hook deadline %s before signing', async (deadline) => {
  await expect(placeConfirmed(shown(), OWNER, () => sign(terms(), deadline))).rejects.toThrow('changed')
  expect(mockSignCalls).not.toHaveBeenCalled()
})

it('rejects a changed source amount or receiver', async () => {
  for (const changed of [{ amount: 9_999n }, { receiver: TOKEN }]) {
    const value = terms()
    value.request = { ...request, ...changed }
    await expect(placeConfirmed(shown(), OWNER, () => sign(value))).rejects.toThrow('changed')
  }
})

it('rejects a switched wallet, switched proxy or invalid owner signature', async () => {
  mockState.signer = TOKEN
  await expect(placeConfirmed(shown(), OWNER, () => sign())).rejects.toThrow('wallet placing')
  mockState.signer = OWNER
  mockState.shed = TOKEN
  await expect(placeConfirmed(shown(), OWNER, () => sign())).rejects.toThrow('wallet placing')
  mockState.shed = SHED
  mockState.signatureValid = false
  await expect(placeConfirmed(shown(), OWNER, () => sign())).rejects.toThrow('wallet placing')
})

it('refuses material balances left in the proxy', async () => {
  mockState.balance = 1000n
  await expect(placeConfirmed(shown(), OWNER, () => sign())).rejects.toThrow('proxy')
  expect(mockSignCalls).not.toHaveBeenCalled()
})

it('a failed placement cannot reuse its confirmation', async () => {
  await expect(
    placeConfirmed(shown(), OWNER, async () => {
      throw new Error('declined')
    }),
  ).rejects.toThrow('declined')
  await expect(sign()).rejects.toThrow('changed')
})

it('allows a disposable quote-account signature without placement state', async () => {
  mockState.signer = BRIDGE_QUOTE_ACCOUNT
  expect((await sign()).postHook.dappId).toBe(RELAY_DAPP_ID)
  expect(localStorage.length).toBe(0)
})

it('caps swap validity at the short deposit window and fails closed on missing metadata', () => {
  expect(relayValidToLimit({ ...shown(), quoteBody: JSON.stringify({ depositUntil: 1300 }) })).toBe(1270)
  expect(relayValidToLimit(shown())).toBe(0)
  expect(relayValidToLimit(null)).toBe(Infinity)
})
