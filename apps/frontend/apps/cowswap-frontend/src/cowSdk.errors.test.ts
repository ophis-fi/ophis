import { isExecutionError, isTransportError } from './cowSdk.utils'

const dead = Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 })
const revert = Object.assign(new Error('Internal JSON-RPC error.'), {
  code: -32603,
  data: { code: 3, message: 'execution reverted', data: '0x08c379a0' },
})

describe('isExecutionError', () => {
  it('recognises reverts in the shapes MetaMask, ethers wrappers and raw nodes produce', () => {
    expect(isExecutionError(revert)).toBe(true)
    expect(isExecutionError({ code: 3, message: 'execution reverted', data: '0x' })).toBe(true)
    expect(isExecutionError({ code: -32000, message: 'insufficient funds for gas * price + value' })).toBe(true)
    expect(isExecutionError({ code: -32000, message: 'gas required exceeds allowance (30000000)' })).toBe(true)
    // ethers SERVER_ERROR wrapping the node answer under error; MetaMask under data.originalError (Codex round 3)
    expect(
      isExecutionError({
        code: 'SERVER_ERROR',
        message: 'processing response error',
        error: { code: 3, data: '0x08c379a0' },
      }),
    ).toBe(true)
    expect(
      isExecutionError({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { originalError: { code: 3, message: 'execution reverted' } },
      }),
    ).toBe(true)
    expect(isExecutionError({ code: 'SERVER_ERROR', cause: { code: -32603, data: { code: 3 } } })).toBe(true)
    // WalletConnect-style bare strings, top level or nested as data (Codex round 4)
    expect(isExecutionError('execution reverted')).toBe(true)
    expect(
      isExecutionError({ code: -32603, message: 'Internal JSON-RPC error.', data: 'execution reverted: SPL' }),
    ).toBe(true)
    expect(isExecutionError('Internal JSON-RPC error.')).toBe(false)
    // An overloaded RPC's "execution timeout" is transport, not execution (Codex round 13)
    expect(isExecutionError({ code: -32603, message: 'execution timeout' })).toBe(false)
    expect(isExecutionError({ code: -32603, message: 'request execution timed out' })).toBe(false)
    // VM failures without revert data (Codex round 6)
    for (const message of [
      'out of gas',
      'invalid opcode: INVALID',
      'stack underflow (0 <=> 1)',
      'invalid jump destination',
    ])
      expect(isExecutionError({ code: -32000, message })).toBe(true)
    // EIP-1559 and tx-pool validation answers, wrapped the MetaMask way (Codex round 12)
    for (const message of [
      'max fee per gas less than block base fee: maxFeePerGas: 1, baseFee: 2',
      'fee cap less than block base fee',
      'max priority fee per gas higher than max fee per gas',
      'transaction underpriced',
      'exceeds block gas limit',
      'insufficient balance for transfer',
    ])
      expect(
        isExecutionError({ code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32000, message } }),
      ).toBe(true)
  })

  it('classifies connectivity, rate-limit and timeout failures as transport errors', () => {
    expect(isExecutionError(dead)).toBe(false)
    expect(isExecutionError({ code: -32005, message: 'limit exceeded' })).toBe(false)
    expect(isExecutionError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isExecutionError(new Error('wallet eth_getCode. Timeout after 10000 ms'))).toBe(false)
    expect(isExecutionError(undefined)).toBe(false)
  })
})

describe('isTransportError', () => {
  it('identifies dead endpoints, rate limits, blocked requests and timeouts', () => {
    expect(isTransportError(dead)).toBe(true)
    expect(isTransportError({ code: -32005, message: 'limit exceeded' })).toBe(true)
    expect(isTransportError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isTransportError(new Error('wallet eth_getCode. Timeout after 10000 ms'))).toBe(true)
    expect(isTransportError({ code: -32603, message: 'request execution timed out' })).toBe(true)
    expect(isTransportError({ code: 'SERVER_ERROR', message: 'bad response (status=403)' })).toBe(true)
    expect(
      isTransportError({
        code: -32603,
        message: 'Internal JSON-RPC error.',
        data: { message: 'Forbidden: domain not allowed' },
      }),
    ).toBe(true)
  })

  it('does not claim wallet policy answers or unknown errors', () => {
    expect(isTransportError({ code: 4001, message: 'User rejected the request.' })).toBe(false)
    expect(isTransportError({ code: 4100, message: 'Unauthorized' })).toBe(false)
    expect(isTransportError({ code: 4900, message: 'Disconnected' })).toBe(false)
    expect(isTransportError({ code: 4100, message: 'Forbidden' })).toBe(false)
    expect(isTransportError({ code: 4001, message: 'Request timeout' })).toBe(false)
    // A policy code nested under a transport wrapper still wins (Codex round 10)
    expect(
      isTransportError({ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 4100 } } }),
    ).toBe(false)
    expect(
      isTransportError({ code: 'SERVER_ERROR', message: 'bad response (status=403)', error: { code: 4001 } }),
    ).toBe(false)
    expect(isTransportError(new Error('something odd'))).toBe(false)
    expect(isTransportError(undefined)).toBe(false)
  })
})
