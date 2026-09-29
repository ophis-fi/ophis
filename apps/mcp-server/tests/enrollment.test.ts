import { afterEach, expect, it, vi } from 'vitest'
import { registerOphisTools } from '../src/tools.js'
import { submitOrder } from '../src/ophis.js'

type OphisModule = typeof import('../src/ophis.js')

vi.mock('../src/ophis.js', async (original) => ({
  ...await original<OphisModule>(), submitOrder: vi.fn(),
}))
afterEach(() => vi.restoreAllMocks())

it.each([undefined, 'partner'])('enrolls accepted orders with referral %s', async (code) => {
  vi.mocked(submitOrder).mockResolvedValue('accepted-order-uid')
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  const registerTool = vi.fn()
  registerOphisTools({ registerTool } as never)
  const submit = registerTool.mock.calls.find(([name]) => name === 'submit_order')?.[2]
  const result = await submit({ chainId: 5042, from: `0x${'12'.repeat(20)}`, order: {}, signature: '0x12',
    fullAppData: JSON.stringify({ metadata: { ...(code ? { ophisReferrer: { code } } : {}) } }) })
  expect(result.isError).not.toBe(true)
  expect(request).toHaveBeenCalledWith(`https://rebates.ophis.fi/tier/0x${'12'.repeat(20)}`, expect.any(Object))
})

it('reports enrollment failure without making an accepted order look rejected', async () => {
  vi.mocked(submitOrder).mockResolvedValue('accepted-order-uid')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }))
  const registerTool = vi.fn()
  registerOphisTools({ registerTool } as never)
  const submit = registerTool.mock.calls.find(([name]) => name === 'submit_order')?.[2]
  const result = await submit({ chainId: 10, from: `0x${'12'.repeat(20)}`, order: {}, signature: '0x12', fullAppData: '{}' })
  expect(result.isError).not.toBe(true)
  expect(result.content[0].text).toContain('accepted-order-uid')
  expect(result.content[1].text).toContain('Retry enrollment, not order submission')
})

it('does not enroll a rejected order', async () => {
  vi.mocked(submitOrder).mockRejectedValue(new Error('invalid order'))
  const request = vi.spyOn(globalThis, 'fetch')
  const registerTool = vi.fn()
  registerOphisTools({ registerTool } as never)
  const submit = registerTool.mock.calls.find(([name]) => name === 'submit_order')?.[2]
  const result = await submit({ chainId: 10, from: `0x${'12'.repeat(20)}`, order: {}, signature: '0x12', fullAppData: '{}' })
  expect(result.isError).toBe(true)
  expect(request).not.toHaveBeenCalled()
})
