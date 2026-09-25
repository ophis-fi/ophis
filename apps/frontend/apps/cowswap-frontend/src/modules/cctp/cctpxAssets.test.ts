import { decodeFunctionData, isAddress } from 'viem'

import { cctpBurnData, parseCctpAmount, type CctpTransfer } from './cctp.service'
import { CCTPX_ABI, CCTP_ASSETS, cctpAssetRoute, cctpSpender, cctpAsset, cctpToken } from './cctpAssets.const'
import { cctpTransferSchema } from './cctpState'
import { CCTPX_ASSETS } from './cctpxAssets.const'

const now = Date.now()
const transfer: CctpTransfer = {
  asset: 'EURC',
  source: 8453,
  destination: 5042,
  owner: '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A',
  amount: '10000000',
  maxFee: '0',
  quotedAt: now,
  expanded: {
    signedQuote: `0x${'11'.repeat(100)}`,
    feeTotalAmount: '20000000000000',
    issuedAt: Math.floor(now / 1000),
    expiry: { mode: 'BLOCK_NUMBER', expiresAtBlock: 5000, blockEstimatedAt: Math.floor(now / 1000) + 120 },
  },
}

it('preserves 18-decimal transfers and validates every reviewed registry route across refresh', () => {
  expect(new Set(CCTP_ASSETS).size).toBe(CCTP_ASSETS.length)
  expect(CCTP_ASSETS.length).toBe(40)
  for (const asset of CCTP_ASSETS.filter((item) => item !== 'USDC')) {
    const entry = CCTPX_ASSETS[asset]
    expect(entry.tokenId).toMatch(/^0x[0-9a-fA-F]{64}$/)
    expect(isAddress(entry.manager, { strict: false })).toBe(true)
    expect(Number.isInteger(entry.decimals) && entry.decimals >= 0 && entry.decimals <= 18).toBe(true)
    for (const address of Object.values(entry.addresses)) expect(isAddress(address || '', { strict: false })).toBe(true)
    if (entry.homeChainId) expect(entry.addresses[entry.homeChainId]).toBeDefined()
    const route = cctpAssetRoute(asset, 5042, 1)
    const quote = { ...transfer, asset, ...route, amount: parseCctpAmount('1.25', asset).toString() }
    expect(cctpTransferSchema.parse(JSON.parse(JSON.stringify(quote)))).toEqual(quote)
    const decoded = decodeFunctionData({ abi: CCTPX_ABI, data: cctpBurnData(quote) })
    expect(decoded.args?.[0]).toBe(cctpAsset(asset).tokenId)
    expect(decoded.args?.[1]).toBe(BigInt(quote.amount))
    expect(cctpSpender(asset)).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(cctpToken(quote.source, asset)).not.toBe(cctpToken(quote.destination, asset))
  }
  expect(parseCctpAmount('1.250000000000000001', 'WETH')).toBe(1250000000000000001n)
  expect(() => parseCctpAmount('0.0000000000000000001', 'WETH')).toThrow()
  const weth = { ...transfer, asset: 'WETH', source: 5042, destination: 1, amount: '1250000000000000001' }
  for (const amount of ['0', '-1', '01', '0x10', '1e18', '9'.repeat(78)]) {
    expect(cctpTransferSchema.safeParse({ ...weth, amount }).success).toBe(false)
  }
  expect(cctpTransferSchema.safeParse({ ...transfer, amount: '10000000000001' }).success).toBe(false)
  expect(cctpTransferSchema.safeParse({ ...weth, source: 10 }).success).toBe(false)
})
