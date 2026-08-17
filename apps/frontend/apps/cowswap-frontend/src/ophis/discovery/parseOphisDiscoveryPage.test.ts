import { OPHIS_DISCOVERY_EXCLUDED_ADDRESSES, OPHIS_DISCOVERY_MAX_RESULTS } from './ophisDiscovery.const'
import { parseOphisDiscoveryPage } from './parseOphisDiscoveryPage'

import type { Address, Hex } from 'viem'

const TOKEN_A = '0x1111111111111111111111111111111111111111' as Address
const TOKEN_B = '0x2222222222222222222222222222222222222222' as Address

function account(address: Address): Hex {
  return `0x${address.slice(2).padStart(64, '0')}` as Hex
}

function row(address: Address, overrides: Partial<Record<number, unknown>> = {}): unknown[] {
  const result: unknown[] = [
    BigInt(address),
    account(address),
    1n,
    18,
    0,
    2,
    true,
    false,
    true,
    0,
    1_000,
    false,
    'Token Alpha',
    'ALPHA',
  ]

  Object.entries(overrides).forEach(([index, value]) => {
    result[Number(index)] = value
  })
  return result
}

describe('parseOphisDiscoveryPage', () => {
  it('accepts only a synced, deployed Ethereum ERC-20 summary', () => {
    expect(parseOphisDiscoveryPage([row(TOKEN_A)], 1)).toEqual([
      {
        id: BigInt(TOKEN_A).toString(),
        address: TOKEN_A,
        chainId: 1,
        decimals: 18,
        name: 'Token Alpha',
        symbol: 'ALPHA',
        rank: 1_000,
      },
    ])
  })

  it.each([
    ['wrong chain', { 2: 10n }],
    ['foreign account kind', { 4: 1 }],
    ['native asset', { 5: 1 }],
    ['collection', { 5: 3 }],
    ['reservation', { 6: false }],
    ['owner-authored metadata', { 8: false }],
    ['hostile decimals', { 3: 255 }],
    ['invalid rank', { 10: -1 }],
    ['zero address', { 1: `0x${'0'.repeat(64)}` }],
    ['non-EVM bytes32 account', { 1: `0x01${'0'.repeat(62)}` }],
  ])('drops %s rows', (_, overrides) => {
    expect(parseOphisDiscoveryPage([row(TOKEN_A, overrides)], 1)).toEqual([])
  })

  it('drops the explicit display-policy exclusion without exposing source metadata', () => {
    const excluded = OPHIS_DISCOVERY_EXCLUDED_ADDRESSES[0]
    expect(excluded).toBeDefined()
    expect(parseOphisDiscoveryPage([row(excluded)], 1)).toEqual([])
  })

  it('sanitizes markup, controls, bidi controls, whitespace, and length', () => {
    const [token] = parseOphisDiscoveryPage(
      [
        row(TOKEN_A, {
          12: `  Safe<script>\u0000\u202ename  ${'x'.repeat(50)}`,
          13: ` A<LP>\u200bHA${'Z'.repeat(20)}`,
        }),
      ],
      1,
    )

    expect(token?.name).not.toMatch(/[<>\u0000\u202e]/)
    expect(token?.symbol).not.toMatch(/[<>\u200b]/)
    expect(Array.from(token?.name ?? '')).toHaveLength(40)
    expect(Array.from(token?.symbol ?? '')).toHaveLength(12)
  })

  it('deduplicates by chain and normalized address while preserving the first row', () => {
    const duplicate = row(TOKEN_A, { 12: 'Duplicate', 13: 'DUP' })
    expect(parseOphisDiscoveryPage([row(TOKEN_A), duplicate, row(TOKEN_B)], 1).map((token) => token.symbol)).toEqual([
      'ALPHA',
      'ALPHA',
    ])
  })

  it('caps output and fails closed for malformed values', () => {
    const many = Array.from({ length: OPHIS_DISCOVERY_MAX_RESULTS + 5 }, (_, index) => {
      const address = `0x${(index + 1).toString(16).padStart(40, '0')}` as Address
      return row(address)
    })
    expect(parseOphisDiscoveryPage(many, 1)).toHaveLength(OPHIS_DISCOVERY_MAX_RESULTS)

    for (const malformed of [null, undefined, 'bad', 1, {}, [null], [[1n]], [{ length: 14 }]]) {
      expect(() => parseOphisDiscoveryPage(malformed, 1)).not.toThrow()
      expect(parseOphisDiscoveryPage(malformed, 1)).toEqual([])
    }
  })
})
