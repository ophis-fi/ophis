import { getAddressKey } from '@cowprotocol/cow-sdk'
import type { TokenList } from '@uniswap/token-lists'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DEFAULT_TOKENS_LISTS, OPHIS_TOKENS_LIST_SOURCE } from './tokensLists'

import { isExcludedListToken } from '../utils/excludedListTokens'
import { validateTokenList } from '../utils/validateTokenList'

const shippedList = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../apps/cowswap-frontend/public/token-lists/ophis.json'), 'utf8'),
) as TokenList

describe('Ophis token list', () => {
  it('has matching saved onchain evidence for every shipped contract', () => {
    const raw = readFileSync(resolve(__dirname, '../../../../apps/cowswap-frontend/public/token-lists/ophis.json'))
    const report = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../../../../docs/development/ophis-token-list-evidence/onchain.json'),
        'utf8',
      ),
    ) as {
      listSha256: string
      chains: { chainId: number; tokens: { address: string; decimals: number; status: string }[] }[]
    }
    expect(report.listSha256).toBe(createHash('sha256').update(raw).digest('hex'))
    const results = new Map(
      report.chains.flatMap(({ chainId, tokens }) =>
        tokens.map((token) => [`${chainId}:${getAddressKey(token.address)}`, token] as const),
      ),
    )
    expect(results.size).toBe(shippedList.tokens.length)
    for (const token of shippedList.tokens) {
      expect(results.get(`${token.chainId}:${getAddressKey(token.address)}`)).toMatchObject({
        decimals: token.decimals,
        status: 'pass',
      })
    }
  })

  it('records published source corroboration for every shipped address and decimal value', () => {
    const provenance = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../../../../docs/development/ophis-token-list-evidence/provenance.json'),
        'utf8',
      ),
    ) as { tokens: { chainId: number; address: string; sources: { decimals: number }[] }[] }
    const entries = new Map(
      provenance.tokens.map((token) => [`${token.chainId}:${getAddressKey(token.address)}`, token.sources]),
    )
    expect(entries.size).toBe(shippedList.tokens.length)
    for (const token of shippedList.tokens) {
      expect(entries.get(`${token.chainId}:${getAddressKey(token.address)}`)).toContainEqual(
        expect.objectContaining({ decimals: token.decimals }),
      )
    }
  })

  it('passes the runtime validator and covers every configured chain exactly once per address', async () => {
    await expect(validateTokenList(shippedList)).resolves.toBe(shippedList)
    const chains = new Set(shippedList.tokens.map(({ chainId }) => String(chainId)))
    expect([...chains].sort()).toEqual(Object.keys(DEFAULT_TOKENS_LISTS).sort())
    const identities = shippedList.tokens.map(({ chainId, address }) => `${chainId}:${getAddressKey(address)}`)
    expect(new Set(identities).size).toBe(identities.length)
    expect(shippedList.tokens.some(({ chainId, address }) => isExcludedListToken(chainId, address))).toBe(false)
    for (const lists of Object.values(DEFAULT_TOKENS_LISTS)) {
      expect(lists?.filter(({ source }) => source === OPHIS_TOKENS_LIST_SOURCE)).toHaveLength(1)
      expect(lists?.some(({ source }) => /\/CowSwap(?:Sepolia)?\.json$/.test(source))).toBe(false)
    }
  })

  it.each([
    [8453, 'bsdETH', '0xCb327b99fF831bF8223cCEd12B1338FF3aA322Ff', 18],
    [137, 'USDT0', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6],
    [10, 'USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6],
    [130, 'USDC', '0x078d782b760474a361dda0af3839290b0ef57ad6', 6],
    [4663, 'USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6],
    [4663, 'WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 18],
    [4663, 'TINY', '0xb9CE619b168f325b4eb8C2E8E073501838C7A407', 18],
  ])('preserves the canonical %s / %s token', (chainId, symbol, address, decimals) => {
    expect(
      shippedList.tokens.find(
        (token) => token.chainId === chainId && getAddressKey(token.address) === getAddressKey(String(address)),
      ),
    ).toMatchObject({ symbol, decimals })
  })
})
