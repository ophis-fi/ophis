import { expect, it, vi } from 'vitest'

import { registerOphisTools } from '../src/tools.js'

it.each([
  { chainId: 5042, referrerCode: undefined, expectedCode: undefined, rejected: false },
  { chainId: 5042, referrerCode: 'caller-code', expectedCode: undefined, rejected: true },
  { chainId: 5042, referrerCode: '', expectedCode: undefined, rejected: false },
  { chainId: 10, referrerCode: undefined, expectedCode: 'server-code', rejected: false },
  { chainId: 10, referrerCode: 'caller-code', expectedCode: 'caller-code', rejected: false },
])('build_order applies referral defaults on chain $chainId with code $referrerCode', async ({ chainId, referrerCode, expectedCode, rejected }) => {
  const registerTool = vi.fn()
  registerOphisTools({ registerTool } as never, { defaultReferrerCode: 'server-code' })
  const build = registerTool.mock.calls.find(([name]) => name === 'build_order')?.[2]
  expect(build).toBeTypeOf('function')
  const fetchQuote = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    quote: { sellAmount: '1000000', buyAmount: '1000000', feeAmount: '0' },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    const result = await build({
      chainId,
      owner: '0x0000000000000000000000000000000000000123',
      sellToken: chainId === 5042 ? '0x3600000000000000000000000000000000000000' : '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      buyToken: chainId === 5042 ? '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' : '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
      sellAmount: '1000000',
      buyAmount: '990000',
      kind: 'sell',
      referrerCode,
    })
    if (rejected) {
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/Arc \(5042\) referral rewards are not supported/)
      expect(fetchQuote).not.toHaveBeenCalled()
    } else {
      expect(result.isError).not.toBe(true)
      const built = JSON.parse(result.content[0].text)
      expect(built.partnerFee).toEqual({ volumeBps: 1, recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' })
      expect(JSON.parse(built.fullAppData).metadata.ophisReferrer?.code).toBe(expectedCode)
      expect(fetchQuote).toHaveBeenCalledOnce()
    }
  } finally {
    fetchQuote.mockRestore()
  }
})
