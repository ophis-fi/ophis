import { expect, it } from 'vitest'
import { NETWORK } from '../src/config'
import { assertPrivateExecution, assertTraceSuccess, TraceValidationError, traceRpcDiagnostic } from '../src/transaction'

it.each([
  [{ code: 'UNKNOWN_ERROR', info: { error: { code: -32602, message: 'PRIVATE request', data: 'PRIVATE data' } } }, { category: 'invalid-params', rpcCode: -32602 }],
  [{ code: -32601, message: 'PRIVATE endpoint' }, { category: 'method-unavailable', rpcCode: -32601 }],
  [{ error: { code: -32004, message: 'PRIVATE endpoint' } }, { category: 'method-unavailable', rpcCode: -32004 }],
  [{ code: 'CALL_EXCEPTION', message: 'PRIVATE calldata' }, { category: 'execution' }],
  [{ error: { code: 3, message: 'PRIVATE revert' } }, { category: 'execution', rpcCode: 3 }],
  [{ info: { error: { code: -32000, message: 'intrinsic gas too low: PRIVATE payload' } } }, { category: 'execution', rpcCode: -32000 }],
  [{ code: 'UNKNOWN_ERROR', info: { error: { code: -32000, message: 'max fee per gas less than block base fee: PRIVATE payload' } } }, { category: 'gas-price-below-base', rpcCode: -32000 }],
  [{ code: 'TIMEOUT', message: 'PRIVATE URL' }, { category: 'timeout' }],
  [{ info: { error: { code: -32000, message: 'execution timeout: PRIVATE request' } } }, { category: 'timeout', rpcCode: -32000 }],
  [{ code: -32000, message: 'PRIVATE unspecified failure', data: 'PRIVATE response' }, { category: 'other', rpcCode: -32000 }],
  [{ code: 'PRIVATE', message: 'PRIVATE' }, { category: 'other' }],
  [{ code: Number.MAX_SAFE_INTEGER }, { category: 'other' }],
  [null, { category: 'other' }],
])('classifies RPC failures without returning provider material: %#', (error, expected) => {
  expect(traceRpcDiagnostic(error)).toEqual(expected)
  expect(JSON.stringify(traceRpcDiagnostic(error))).not.toContain('PRIVATE')
})

it('retains exact nested CALL matching and rejects altered private batch bytes', () => {
  const input = '0x1234', trace = { type: 'CALL', calls: [{ type: 'STATICCALL' }, { type: 'CALL', calls: [
    { type: 'CALL', to: NETWORK.proxyContract, input },
  ] }] }
  expect(() => assertPrivateExecution(trace, input)).not.toThrow()
  try { assertPrivateExecution(trace, '0x1235'); throw new Error('Unexpected acceptance') }
  catch (error) { expect(error).toBeInstanceOf(TraceValidationError); expect(error).toHaveProperty('category', 'exact-batch-absent') }
})

it('retains the depth boundary while distinguishing a finite limit rejection', () => {
  let trace: { type: string; calls?: unknown[] } = { type: 'CALL' }
  for (let i = 0; i < 64; i++) trace = { type: 'CALL', calls: [trace] }
  expect(() => assertTraceSuccess(trace)).not.toThrow()
  try { assertTraceSuccess({ type: 'CALL', calls: [trace] }); throw new Error('Unexpected acceptance') }
  catch (error) { expect(error).toBeInstanceOf(TraceValidationError); expect(error).toHaveProperty('category', 'limit') }
})
