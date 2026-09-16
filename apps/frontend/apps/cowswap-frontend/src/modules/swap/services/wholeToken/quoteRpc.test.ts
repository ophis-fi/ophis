import { Interface } from '@ethersproject/abi'
import { JsonRpcProvider } from '@ethersproject/providers'

import { createQuoteRpc } from './quoteRpc.service'

const abi = new Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])',
])
const address = '0x1111111111111111111111111111111111111111'

it('batches concurrent quotes at one block and isolates unavailable pools', async () => {
  const provider = new JsonRpcProvider()
  const call = jest.spyOn(provider, 'call').mockResolvedValue(
    abi.encodeFunctionResult('aggregate3', [
      [
        [true, '0x01'],
        [false, '0x'],
      ],
    ]),
  )
  const rpc = createQuoteRpc(provider, 42)
  const result = await Promise.allSettled([rpc.call(address, '0x01'), rpc.call(address, '0x02')])
  expect(call).toHaveBeenCalledTimes(1)
  expect(call.mock.calls[0]?.[1]).toBe(42)
  expect(result[0]).toEqual({ status: 'fulfilled', value: '0x01' })
  expect(result[1]?.status).toBe('rejected')
})

it('cancels a stalled batch and prevents any follow-up RPC work', async () => {
  const provider = new JsonRpcProvider()
  const call = jest.spyOn(provider, 'call').mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const rpc = createQuoteRpc(provider, 42, controller.signal)
  const pending = rpc.call(address, '0x01')
  await Promise.resolve()
  controller.abort()
  await expect(pending).rejects.toBeDefined()
  expect(() => rpc.call(address, '0x02')).toThrow()
  expect(call).toHaveBeenCalledTimes(1)
})
