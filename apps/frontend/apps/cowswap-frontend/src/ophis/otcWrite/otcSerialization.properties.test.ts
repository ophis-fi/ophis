import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'

import {
  fetchOtcIndexedOrders,
  formatOtcAmount,
  OPHIS_ETHEREUM_OTC_MANIFEST,
  parseOtcOrders,
  type OtcOrder,
} from 'ophis/otc'
import { decodeFunctionData, type Address, type Hex } from 'viem'

import { createHash } from 'crypto'

import { assertOtcTransactionRequest } from './assertOtcTransactionRequest'
import { buildOtcTransaction } from './buildOtcTransaction'
import { OTC_APPROVE_ABI, OTC_ERC20_WRITE_ABI } from './otcWrite.abi'
import { OTC_REVIEWED_TOKENS, parseOtcCreateDraft, parseOtcHumanAmount } from './otcWriteForm'

import type { OtcCreateDraft, OtcTransactionRequest, OtcWriteIntent } from './otcWrite.types'

const SEED = 'ophis-otc-serialization-2026-09-06'
const UINT256_MAX = 2n ** 256n - 1n
const AMOUNTS = [
  1n,
  9n,
  10n,
  11n,
  999_999n,
  10n ** 18n - 1n,
  UINT256_MAX - 1n,
  UINT256_MAX,
  ...Array.from({ length: 256 }, (_, index) =>
    BigInt(`0x${createHash('sha256').update(`${SEED}:${index}`).digest('hex')}`),
  ),
]
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222'
const NOW = 1_755_792_000n

function draftAt(index: number): OtcCreateDraft {
  return {
    tokenA: OTC_REVIEWED_TOKENS[index % 3].address,
    amountA: AMOUNTS[index],
    tokenB: OTC_REVIEWED_TOKENS[(index + 1 + (index % 2)) % 3].address,
    amountB: AMOUNTS[AMOUNTS.length - index - 1],
  }
}

function intentsFor(draft: OtcCreateDraft, orderId: bigint): OtcWriteIntent[] {
  const order: OtcOrder = { ...draft, orderId, maker: ACCOUNT, active: true }
  return [
    { kind: 'approve-create', account: ACCOUNT, draft },
    { kind: 'create', account: ACCOUNT, draft },
    { kind: 'approve-fill', account: ACCOUNT, order },
    { kind: 'fill', account: ACCOUNT, order, deadline: NOW + 180n },
    { kind: 'cancel', account: ACCOUNT, order },
    { kind: 'revoke-create', account: ACCOUNT, draft },
    { kind: 'revoke-fill', account: ACCOUNT, order: { ...order, active: false } },
  ]
}

function expectedCall(intent: OtcWriteIntent): { functionName: string; args: readonly unknown[] } {
  switch (intent.kind) {
    case 'create':
      return { functionName: 'createOrder', args: Object.values(intent.draft) }
    case 'fill':
      return { functionName: 'fillOrder', args: [intent.order.orderId, intent.deadline] }
    case 'cancel':
      return { functionName: 'cancelOrder', args: [intent.order.orderId] }
    default:
      return {
        functionName: 'approve',
        args: [
          OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
          intent.kind === 'approve-create'
            ? intent.draft.amountA
            : intent.kind === 'approve-fill'
              ? intent.order.amountB
              : 0n,
        ],
      }
  }
}

function mutatedRequests(request: OtcTransactionRequest): OtcTransactionRequest[] {
  const lastByte = request.data.endsWith('00') ? '01' : '00'
  return [
    { ...request, account: OTHER_ACCOUNT },
    { ...request, to: OTHER_ACCOUNT },
    { ...request, data: `${request.data.slice(0, -2)}${lastByte}` as Hex },
    { ...request, data: `${request.data}00` },
    { ...request, data: request.data.slice(0, -2) as Hex },
    { ...request, kind: request.kind === 'create' ? 'cancel' : 'create' },
    { ...request, chainId: 10 } as unknown as OtcTransactionRequest,
    { ...request, value: 1n } as unknown as OtcTransactionRequest,
  ]
}

function indexedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const draft = draftAt(0)
  return {
    orderId: '1',
    maker: ACCOUNT,
    active: true,
    tokenA: { id: draft.tokenA },
    amountA: '1',
    tokenB: { id: draft.tokenB },
    amountB: '1',
    createdAt: '1755792000',
    createdTx: `0x${'1'.repeat(64)}`,
    ...overrides,
  }
}

function fetchRows(orders: Record<string, unknown>[]): ReturnType<typeof fetchOtcIndexedOrders> {
  const fetchImpl = jest.fn(async () => ({
    ok: true,
    json: async () => ({ data: { _meta: { block: { number: 1 } }, orders } }),
  })) as unknown as typeof fetch
  return fetchOtcIndexedOrders(fetchImpl)
}

describe('OTC deterministic serialization properties', () => {
  it.each([0, 6, 18])('roundtrips all uint256 samples exactly with %i decimals', (decimals) => {
    for (const amount of AMOUNTS) {
      const formatted = formatOtcAmount(amount, decimals)
      expect(parseOtcHumanAmount(formatted, decimals)).toBe(amount)
      expect(parseOtcHumanAmount(` ${formatted} `, decimals)).toBe(amount)
      expect(parseOtcHumanAmount(formatOtcAmount(UINT256_MAX + amount, decimals), decimals)).toBeNull()
    }
  })

  it.each(OTC_REVIEWED_TOKENS)('canonicalizes equivalent human inputs for $symbol without rounding', (token) => {
    const other = OTC_REVIEWED_TOKENS.find((candidate) => candidate !== token)
    if (!other) throw new Error('The OTC policy requires distinct tokens')
    for (const value of [1n, 9n, 10n, 123_456_789n]) {
      const common = { tokenA: token, tokenB: other, amountB: '1' }
      const integer = value.toString()
      expect(parseOtcCreateDraft({ ...common, amountA: integer })).toEqual(
        parseOtcCreateDraft({ ...common, amountA: `${integer}.${'0'.repeat(token.decimals)}` }),
      )
      expect(parseOtcHumanAmount(`${integer}.${'0'.repeat(token.decimals)}1`, token.decimals)).toBeNull()
    }
  })

  it.each(['', '0', '-1', '+1', '01', '.1', '1.', '1e3', '0x10', '1,000', 'NaN', 'Infinity', '١', '1\u0000'])(
    'rejects noncanonical unsigned decimal input %j',
    (value) => {
      for (const decimals of [0, 6, 18]) expect(parseOtcHumanAmount(value, decimals)).toBeNull()
    },
  )

  it('preserves every reviewed field and rejects every single-field or calldata-boundary mutation', () => {
    for (const [index, orderId] of AMOUNTS.entries()) {
      for (const intent of intentsFor(draftAt(index), orderId)) {
        const request = buildOtcTransaction(intent, NOW)
        const abi = expectedCall(intent).functionName === 'approve' ? OTC_APPROVE_ABI : OTC_ERC20_WRITE_ABI
        expect(decodeFunctionData({ abi, data: request.data })).toEqual(expectedCall(intent))
        expect(request.account).toBe(ACCOUNT)
        expect(request.chainId).toBe(1)
        expect(request.value).toBe(0n)
        expect(() => assertOtcTransactionRequest(request, intent, NOW)).not.toThrow()
        for (const mutation of mutatedRequests(request)) {
          expect(() => assertOtcTransactionRequest(mutation, intent, NOW)).toThrow()
        }
      }
    }
  })

  it('rejects unsupported tokens on either leg at all seven sinks', () => {
    for (const token of [NATIVE_CURRENCY_ADDRESS, OTHER_ACCOUNT] as Address[]) {
      for (const leg of ['tokenA', 'tokenB'] as const) {
        for (const intent of intentsFor({ ...draftAt(0), [leg]: token }, 1n)) {
          expect(() => buildOtcTransaction(intent, NOW)).toThrow(/token policy blocked/)
        }
      }
    }
  })

  it.each(['amountA', 'amountB'] as const)('rejects decoded %s beyond uint256', (field) => {
    const order: OtcOrder = { ...draftAt(0), orderId: 1n, maker: ACCOUNT, active: true }
    expect(() => parseOtcOrders([{ ...order, [field]: UINT256_MAX }], [1n])).not.toThrow()
    expect(() => parseOtcOrders([{ ...order, [field]: UINT256_MAX + 1n }], [1n])).toThrow()
  })
})

describe('OTC index uint256 and page invariants', () => {
  it.each(['orderId', 'amountA', 'amountB'])('drops indexed %s outside bounded uint256 text', async (field) => {
    for (const invalid of [(UINT256_MAX + 1n).toString(), '9'.repeat(10_000), '-1']) {
      const result = await fetchRows([indexedRow({ [field]: invalid })])
      expect(result.orders).toHaveLength(0)
      expect(result.droppedRows).toBe(1)
    }
    for (const valid of ['0', UINT256_MAX.toString()]) {
      const result = await fetchRows([indexedRow({ [field]: valid })])
      expect(result.orders).toHaveLength(1)
      expect(result.orders[0][field as 'orderId' | 'amountA' | 'amountB']).toBe(BigInt(valid))
    }
  })

  it('rejects contradictory duplicate IDs, including equivalent decimal spellings', async () => {
    await expect(fetchRows([indexedRow(), indexedRow({ orderId: '01', amountA: '2' })])).rejects.toThrow()
  })

  it('accepts exactly one bounded page and rejects an oversized response', async () => {
    const page = Array.from({ length: 1_000 }, (_, index) => indexedRow({ orderId: index.toString() }))
    expect((await fetchRows(page)).orders).toHaveLength(1_000)
    await expect(fetchRows([...page, indexedRow({ orderId: '1000' })])).rejects.toThrow()
  })
})
