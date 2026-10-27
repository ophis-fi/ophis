import { expect, it } from 'vitest'
import { BrowserProvider, makeError } from 'ethers'
import { errorMessage } from './ui'

it('shows the SDK broadcaster response cause without treating the attempt as safe to retry', () => {
  const error = new Error('Received response error from broadcaster.', { cause: new Error('Fee quote is no longer valid') })
  expect(errorMessage(error)).toContain('Reason: Fee quote is no longer valid')
  expect(errorMessage(error)).toContain('Check pending swap before another attempt')
  expect(errorMessage(new Error('Received response error from broadcaster.'))).toContain('No reason was supplied')
})

it('bounds broadcaster reason display and omits executable calldata', () => {
  const data = '0x' + 'ab'.repeat(500)
  const error = new Error('Received response error from broadcaster.', { cause: new Error(`Rejected ${data} ${'x'.repeat(1000)}`) })
  const message = errorMessage(error)
  expect(message).toContain('[transaction data omitted]')
  expect(message).not.toContain(data)
  expect(message.length).toBeLessThan(1000)
})

it('shows the wallet error without Ethers transaction payloads', () => {
  const error = makeError('could not coalesce error', 'UNKNOWN_ERROR', {
    error: { message: 'Wallet connection failed' },
    payload: { method: 'eth_sendTransaction', params: [{ data: 'sensitive transaction payload' }] },
  })
  expect(errorMessage(error)).toBe('Wallet connection failed')
  expect(errorMessage(new Error('Normal failure'))).toBe('Normal failure')
  expect(errorMessage(undefined)).toBe('Operation failed.')
})

it('unwraps an actual BrowserProvider error and does not retry a rejected send', async () => {
  let sends = 0
  const provider = new BrowserProvider({ request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_sendTransaction') sends += 1
    throw new Error('Wallet connection did not respond')
  } })
  try {
    await provider.send('eth_sendTransaction', [{ from: '0x0000000000000000000000000000000000000001' }])
    throw new Error('Expected the wallet request to fail')
  } catch (error) {
    expect(errorMessage(error)).toBe('Wallet connection did not respond')
    expect(sends).toBe(1)
  } finally {
    provider.destroy()
  }
})
