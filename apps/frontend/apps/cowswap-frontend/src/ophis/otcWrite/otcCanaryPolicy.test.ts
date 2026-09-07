import { USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'

import { maxUint256, zeroAddress } from 'viem'

import { OTC_CANARY_POLICY } from './otcCanary.const'
import { getOtcCanaryRestriction, isOtcCanaryAccount } from './otcCanaryPolicy'
import { MAKER, mockOtcOrder, NOW } from './prepareOtcTransactionTest.utils'

import type { OtcCanaryPolicy } from './otcCanaryPolicy'
import type { OtcWriteIntent } from './otcWrite.types'

const order = mockOtcOrder()
const policy: OtcCanaryPolicy = {
  accounts: [MAKER],
  pairs: [{ tokenA: order.tokenA, tokenB: order.tokenB, maxAmountA: order.amountA, maxAmountB: order.amountB }],
  expiresAt: NOW + 300n,
}
const intents: OtcWriteIntent[] = [
  { kind: 'approve-create', account: MAKER, draft: order },
  { kind: 'create', account: MAKER, draft: order },
  { kind: 'approve-fill', account: MAKER, order },
  { kind: 'fill', account: MAKER, order, deadline: NOW + 180n },
  { kind: 'cancel', account: MAKER, order },
  { kind: 'revoke-create', account: MAKER, draft: order },
  { kind: 'revoke-fill', account: MAKER, order },
]

describe('OTC canary admission and exposure limits', () => {
  it.each(intents)('ships closed and rejects unlisted accounts for $kind', (intent) => {
    expect(getOtcCanaryRestriction(intent, NOW, OTC_CANARY_POLICY)).toMatch(/wallet/)
    expect(getOtcCanaryRestriction({ ...intent, account: zeroAddress }, NOW, policy)).toMatch(/wallet/)
    expect(getOtcCanaryRestriction(intent, NOW, policy)).toBeNull()
  })

  it('normalizes wallet addresses and rejects a disconnected wallet', () => {
    expect(isOtcCanaryAccount(MAKER.toLowerCase() as typeof MAKER, policy)).toBe(true)
    expect(isOtcCanaryAccount(undefined, policy)).toBe(false)
  })

  it.each(intents.slice(0, 4))('limits both legs before $kind, including approvals', (intent) => {
    const mutate = (amountA: bigint, amountB: bigint): OtcWriteIntent =>
      'draft' in intent
        ? { ...intent, draft: { ...order, amountA, amountB } }
        : { ...intent, order: { ...order, amountA, amountB } }
    expect(getOtcCanaryRestriction(mutate(order.amountA + 1n, order.amountB), NOW, policy)).toMatch(/limit/)
    expect(getOtcCanaryRestriction(mutate(order.amountA, order.amountB + 1n), NOW, policy)).toMatch(/limit/)
    expect(getOtcCanaryRestriction(intent, policy.expiresAt, policy)).toMatch(/window/)
    expect(getOtcCanaryRestriction(intent, -1n, policy)).toMatch(/window/)
    expect(getOtcCanaryRestriction(intent, NOW, { ...policy, pairs: [] })).toMatch(/pair/)
  })

  it('applies each cap to its token when maker and payment legs are reversed', () => {
    const draft = {
      tokenA: USDC_MAINNET.address,
      amountA: order.amountB,
      tokenB: WETH_MAINNET.address,
      amountB: order.amountA,
    }
    const intent = { kind: 'create' as const, account: MAKER, draft }
    expect(getOtcCanaryRestriction(intent, NOW, policy)).toBeNull()
    expect(
      getOtcCanaryRestriction({ ...intent, draft: { ...draft, amountA: draft.amountA + 1n } }, NOW, policy),
    ).toMatch(/limit/)
    expect(
      getOtcCanaryRestriction({ ...intent, draft: { ...draft, amountB: draft.amountB + 1n } }, NOW, policy),
    ).toMatch(/limit/)
  })

  it.each([0n, -1n, maxUint256 + 1n])('rejects an invalid configured cap: %s', (limit) => {
    for (const field of ['maxAmountA', 'maxAmountB']) {
      expect(
        getOtcCanaryRestriction(intents[0], NOW, {
          ...policy,
          pairs: [{ ...policy.pairs[0], [field]: limit }],
        }),
      ).toMatch(/limit/)
    }
  })

  it.each(intents.slice(4))('preserves $kind after trading closes or its pair is removed', (intent) => {
    expect(getOtcCanaryRestriction(intent, policy.expiresAt, { ...policy, pairs: [] })).toBeNull()
  })
})
