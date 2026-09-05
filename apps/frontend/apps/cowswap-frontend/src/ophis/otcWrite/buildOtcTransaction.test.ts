import { DAI, NATIVE_CURRENCY_ADDRESS, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'

import { OPHIS_ETHEREUM_OTC_MANIFEST, OTC_ERC20_WRITE_SELECTORS } from 'ophis/otc'
import { decodeFunctionData, toFunctionSelector, type Address } from 'viem'

import {
  buildOtcCancelTransaction,
  buildOtcCreateApproval,
  buildOtcCreateTransaction,
  buildOtcFillApproval,
  buildOtcFillTransaction,
  buildOtcRevokeCreateApproval,
  buildOtcRevokeFillApproval,
  OTC_APPROVE_SELECTOR,
  OTC_MAX_FILL_DEADLINE_SECONDS,
} from './buildOtcTransaction'
import { OTC_APPROVE_ABI, OTC_ERC20_WRITE_ABI } from './otcWrite.abi'

import type { OtcCreateDraft } from './otcWrite.types'
import type { OtcOrder } from 'ophis/otc'

const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
const TAKER = '0x1111111111111111111111111111111111111111'
const UNREVIEWED = '0x000000000000040470635EB91b7CE4D132D616eD'
const NOW = 1_755_792_000n

function draft(overrides: Partial<OtcCreateDraft> = {}): OtcCreateDraft {
  return {
    tokenA: WETH_MAINNET.address,
    amountA: 2n * 10n ** 18n,
    tokenB: USDC_MAINNET.address,
    amountB: 8_000n * 10n ** 6n,
    ...overrides,
  }
}

function order(overrides: Partial<OtcOrder> = {}): OtcOrder {
  return {
    orderId: 144n,
    maker: MAKER,
    active: true,
    ...draft(),
    ...overrides,
  }
}

describe('Milestone C transaction builders', () => {
  it('pins exactly the three ERC-20 selectors and excludes every native wrapper', () => {
    expect(OTC_ERC20_WRITE_ABI.map((fn) => toFunctionSelector(fn))).toEqual(OTC_ERC20_WRITE_SELECTORS)
    expect(OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors).toEqual(['0xfc05ca31', '0xc37dfc5b', '0x514fcac7'])
  })

  it('encodes an exact maker approval to the pinned escrow contract', () => {
    const input = draft()
    const request = buildOtcCreateApproval({ kind: 'approve-create', account: MAKER, draft: input })
    const decoded = decodeFunctionData({ abi: OTC_APPROVE_ABI, data: request.data })

    expect(request.to).toBe(WETH_MAINNET.address)
    expect(request.value).toBe(0n)
    expect(request.data.slice(0, 10)).toBe(OTC_APPROVE_SELECTOR)
    expect(decoded).toEqual({
      functionName: 'approve',
      args: [OPHIS_ETHEREUM_OTC_MANIFEST.contract.address, input.amountA],
    })
  })

  it('encodes create, exact fill approval, fill, and maker cancellation', () => {
    const current = order()
    const create = buildOtcCreateTransaction({ kind: 'create', account: MAKER, draft: draft() })
    const approveFill = buildOtcFillApproval({ kind: 'approve-fill', account: TAKER, order: current })
    const fill = buildOtcFillTransaction({ kind: 'fill', account: TAKER, order: current, deadline: NOW + 180n }, NOW)
    const cancel = buildOtcCancelTransaction({ kind: 'cancel', account: MAKER, order: current })

    expect(decodeFunctionData({ abi: OTC_ERC20_WRITE_ABI, data: create.data }).functionName).toBe('createOrder')
    expect(approveFill.to).toBe(USDC_MAINNET.address)
    expect(decodeFunctionData({ abi: OTC_APPROVE_ABI, data: approveFill.data }).args).toEqual([
      OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
      current.amountB,
    ])
    expect(decodeFunctionData({ abi: OTC_ERC20_WRITE_ABI, data: fill.data })).toEqual({
      functionName: 'fillOrder',
      args: [current.orderId, NOW + 180n],
    })
    expect(decodeFunctionData({ abi: OTC_ERC20_WRITE_ABI, data: cancel.data })).toEqual({
      functionName: 'cancelOrder',
      args: [current.orderId],
    })
    for (const request of [create, approveFill, fill, cancel]) expect(request.value).toBe(0n)
  })

  it('encodes zero-only allowance recovery for create and raced fills', () => {
    const createRevoke = buildOtcRevokeCreateApproval({ kind: 'revoke-create', account: MAKER, draft: draft() })
    const fillRevoke = buildOtcRevokeFillApproval({
      kind: 'revoke-fill',
      account: TAKER,
      order: order({ active: false }),
    })

    expect(decodeFunctionData({ abi: OTC_APPROVE_ABI, data: createRevoke.data }).args).toEqual([
      OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
      0n,
    ])
    expect(decodeFunctionData({ abi: OTC_APPROVE_ABI, data: fillRevoke.data }).args).toEqual([
      OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
      0n,
    ])
    expect(createRevoke.to).toBe(WETH_MAINNET.address)
    expect(fillRevoke.to).toBe(USDC_MAINNET.address)
  })

  it('enforces the two-leg OTC policy at every exported write sink', () => {
    const blockedDraft = draft({ tokenB: UNREVIEWED })
    const blockedOrder = order({ tokenB: UNREVIEWED })
    const calls = [
      () => buildOtcCreateApproval({ kind: 'approve-create', account: MAKER, draft: blockedDraft }),
      () => buildOtcCreateTransaction({ kind: 'create', account: MAKER, draft: blockedDraft }),
      () => buildOtcFillApproval({ kind: 'approve-fill', account: TAKER, order: blockedOrder }),
      () => buildOtcRevokeCreateApproval({ kind: 'revoke-create', account: MAKER, draft: blockedDraft }),
      () => buildOtcRevokeFillApproval({ kind: 'revoke-fill', account: TAKER, order: blockedOrder }),
      () => buildOtcFillTransaction({ kind: 'fill', account: TAKER, order: blockedOrder, deadline: NOW + 180n }, NOW),
      () => buildOtcCancelTransaction({ kind: 'cancel', account: MAKER, order: blockedOrder }),
    ]

    for (const call of calls) expect(call).toThrow(/token policy blocked/)
  })

  it('rejects the native sentinel even though local execution is fork-only', () => {
    expect(() =>
      buildOtcCreateTransaction({
        kind: 'create',
        account: MAKER,
        draft: draft({ tokenA: NATIVE_CURRENCY_ADDRESS as Address }),
      }),
    ).toThrow(/token policy blocked/)
  })

  it('accepts only positive amounts, distinct reviewed tokens, and active orders', () => {
    expect(() => buildOtcCreateTransaction({ kind: 'create', account: MAKER, draft: draft({ amountA: 0n }) })).toThrow(
      /amount must be positive/,
    )
    expect(() =>
      buildOtcCreateTransaction({
        kind: 'create',
        account: MAKER,
        draft: draft({ tokenA: DAI.address, tokenB: DAI.address }),
      }),
    ).toThrow(/token pair must differ/)
    expect(() =>
      buildOtcFillApproval({ kind: 'approve-fill', account: TAKER, order: order({ active: false }) }),
    ).toThrow(/order is inactive/)
    expect(() =>
      buildOtcCreateTransaction({ kind: 'create', account: MAKER, draft: draft({ amountA: 2n ** 256n }) }),
    ).toThrow(/amount exceeds uint256/)
  })

  it('requires a short, nonzero future fill deadline', () => {
    expect(() => buildOtcFillTransaction({ kind: 'fill', account: TAKER, order: order(), deadline: 0n }, NOW)).toThrow(
      /deadline must be in the future/,
    )
    expect(() => buildOtcFillTransaction({ kind: 'fill', account: TAKER, order: order(), deadline: NOW }, NOW)).toThrow(
      /deadline must be in the future/,
    )
    expect(() =>
      buildOtcFillTransaction(
        { kind: 'fill', account: TAKER, order: order(), deadline: NOW + OTC_MAX_FILL_DEADLINE_SECONDS + 1n },
        NOW,
      ),
    ).toThrow(/deadline is too long/)
  })

  it('rejects cancellation by anyone except the current maker', () => {
    expect(() => buildOtcCancelTransaction({ kind: 'cancel', account: TAKER, order: order() })).toThrow(
      /only the maker may cancel/,
    )
  })
})
