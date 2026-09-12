import { isExecutionError, isTransportError } from './cowSdk.utils'

/** The MetaMask envelope: the node's answer under data of a -32603. */
const wrap = (data: unknown): object => ({ code: -32603, message: 'Internal JSON-RPC error.', data })
const dead = { code: -32603, message: 'Internal JSON-RPC error.' }
const vmFailures = ['out of gas', 'invalid opcode: INVALID', 'stack underflow (0 <=> 1)', 'invalid jump destination']
const validationAnswers = [
  'max fee per gas less than block base fee: maxFeePerGas: 1, baseFee: 2',
  'fee cap less than block base fee',
  'max priority fee per gas higher than max fee per gas',
  'transaction underpriced',
  'exceeds block gas limit',
  'insufficient balance for transfer',
]

describe('isExecutionError: the node answered by running or validating the request', () => {
  it.each([
    ['MetaMask-wrapped revert', wrap({ code: 3, message: 'execution reverted', data: '0x08c379a0' })],
    ['raw revert', { code: 3, message: 'execution reverted', data: '0x' }],
    ['insufficient funds', { code: -32000, message: 'insufficient funds for gas * price + value' }],
    ['gas allowance', { code: -32000, message: 'gas required exceeds allowance (30000000)' }],
    [
      'ethers SERVER_ERROR wrapping the node answer (Codex round 3)',
      { code: 'SERVER_ERROR', error: { code: 3, data: '0x08' } },
    ],
    [
      'MetaMask data.originalError (Codex round 3)',
      wrap({ originalError: { code: 3, message: 'execution reverted' } }),
    ],
    ['cause chain', { code: 'SERVER_ERROR', cause: { code: -32603, data: { code: 3 } } }],
    ['bare string (Codex round 4)', 'execution reverted'],
    ['string nested as data', wrap('execution reverted: SPL')],
    ...vmFailures.map((m): [string, unknown] => [`VM failure: ${m} (Codex round 6)`, { code: -32000, message: m }]),
    ...validationAnswers.map((m): [string, unknown] => [
      `validation: ${m} (Codex round 12)`,
      wrap({ code: -32000, message: m }),
    ]),
  ] as [string, unknown][])('%s', (_name, error) => expect(isExecutionError(error)).toBe(true))

  it.each([
    ['a dead endpoint', dead],
    ['a rate limit', { code: -32005, message: 'limit exceeded' }],
    ['a fetch failure', new TypeError('Failed to fetch')],
    ['our own read timeout', new Error('wallet eth_getCode. Timeout after 10000 ms')],
    ['an execution timeout of an overloaded RPC (Codex round 13)', { code: -32603, message: 'execution timeout' }],
    ['request execution timed out', { code: -32603, message: 'request execution timed out' }],
    ['a bare transport string', 'Internal JSON-RPC error.'],
    ['nothing', undefined],
  ] as [string, unknown][])('is not %s', (_name, error) => expect(isExecutionError(error)).toBe(false))
})

describe('isTransportError: only a positively identified transport failure', () => {
  it.each([
    ['a dead endpoint', dead],
    ['a rate limit', { code: -32005, message: 'limit exceeded' }],
    ['a fetch failure', new TypeError('Failed to fetch')],
    ["Safari's fetch failure (Codex round 16)", new TypeError('Load failed')],
    ["Firefox's fetch failure", new TypeError('NetworkError when attempting to fetch resource.')],
    ['our own read timeout', new Error('wallet eth_getCode. Timeout after 10000 ms')],
    ['request execution timed out (Codex round 13)', { code: -32603, message: 'request execution timed out' }],
    ['an HTTP 403', { code: 'SERVER_ERROR', message: 'bad response (status=403)' }],
    ['an expired custom-RPC key behind the wrapper (Codex round 20)', wrap({ code: -32600, message: 'Unauthorized' })],
    ['an HTTP 401', { code: 'SERVER_ERROR', message: 'bad response (status=401)' }],
    ['a blocked extension', wrap({ message: 'Forbidden: domain not allowed' })],
    ['an HTML error page behind the wrapper', wrap({ message: 'Unexpected token < in JSON at position 0' })],
    ['a fetch failure behind the wrapper', wrap({ cause: { message: 'Failed to fetch' } })],
    [
      'a fetch failure behind data.originalError (Codex round 18)',
      wrap({ originalError: { message: 'Failed to fetch' } }),
    ],
  ] as [string, unknown][])('%s', (_name, error) => expect(isTransportError(error)).toBe(true))

  it.each([
    ['4001 user rejection', { code: 4001, message: 'User rejected the request.' }],
    ['4100 unauthorized', { code: 4100, message: 'Unauthorized' }],
    ['4900 disconnected', { code: 4900, message: 'Disconnected' }],
    ['4100 described as Forbidden (Codex round 8)', { code: 4100, message: 'Forbidden' }],
    ['4001 described as a timeout', { code: 4001, message: 'Request timeout' }],
    ['4100 nested under a -32603 wrapper (Codex round 10)', wrap({ originalError: { code: 4100 } })],
    [
      '4001 under an ethers SERVER_ERROR',
      { code: 'SERVER_ERROR', message: 'bad response (status=403)', error: { code: 4001 } },
    ],
    ['an unknown error', new Error('something odd')],
    [
      'a node answer the envelope carries (Codex round 17)',
      wrap({ code: -32000, message: "sender doesn't have enough funds to send tx" }),
    ],
    [
      'an unknown node answer under an ethers SERVER_ERROR',
      { code: 'SERVER_ERROR', error: { code: -32000, message: 'odd node answer' } },
    ],
    [
      'a node answer behind data.originalError (Codex round 18)',
      wrap({ originalError: { code: -32000, message: "sender doesn't have enough funds to send tx" } }),
    ],
    ['nothing', undefined],
  ] as [string, unknown][])('is not %s', (_name, error) => expect(isTransportError(error)).toBe(false))
})
