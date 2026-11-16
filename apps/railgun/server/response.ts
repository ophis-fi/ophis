import { readBody } from './body'

const MAX_RESPONSE = 8 * 1024 ** 2
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

// Match the classifications used by ethers and prepaid-diagnostic without exposing
// arbitrary provider diagnostics (which can contain its authenticated URL).
function message(error: Record<string, unknown>, depth = 0): string | undefined {
  const text = typeof error.message === 'string' ? error.message.slice(0, 2048).toLowerCase() : ''
  if (error.code === 3 || /revert|execution failed/.test(text)) return 'execution reverted'
  if (/insufficient funds|base fee exceeds gas limit/.test(text)) return 'insufficient funds'
  if (/nonce/.test(text) && /too low/.test(text)) return 'nonce too low'
  if (/replacement transaction/.test(text) && /underpriced/.test(text)) return 'replacement transaction underpriced'
  if (/only replay-protected/.test(text)) return 'only replay-protected transactions are supported'
  if (/max fee per gas less than block base fee|gas price.*less than.*base fee|fee cap less than block base fee/.test(text)) return 'max fee per gas less than block base fee'
  if (/gas required exceeds allowance/.test(text)) return 'gas required exceeds allowance'
  if (/out of gas|intrinsic gas/.test(text)) return 'out of gas'
  if (/timeout|timed out|deadline exceeded/.test(text)) return 'request timed out'
  if (error.code === -32601 || error.code === -32004 || /the method .* does not exist|unauthorized method/.test(text)) return 'the method requested does not exist'
  if (error.code === -32602) return 'invalid RPC parameters'
  if (/rate|limit|capacity|quota/.test(text)) return 'RPC rate or quota limit reached'
  if (/already known/.test(text)) return 'transaction already known'
  if (depth < 4) {
    for (const key of ['data', 'error', 'originalError']) {
      const nested = error[key]
      if (!object(nested)) continue
      const classified = message(nested, depth + 1)
      if (classified !== undefined) return classified
    }
  }
  return undefined
}

function revertData(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value)) return value
  if (depth < 4 && object(value)) {
    for (const key of ['data', 'error', 'originalError']) {
      const data = revertData(value[key], depth + 1)
      if (data !== undefined) return data
    }
  }
  return undefined
}

function sanitized(reply: unknown): unknown {
  if (!object(reply) || reply.jsonrpc !== '2.0' ||
    !(typeof reply.id === 'string' || typeof reply.id === 'number' || reply.id === null)) throw new Error('Invalid RPC response.')
  if (!Object.hasOwn(reply, 'error')) {
    if (!Object.hasOwn(reply, 'result')) throw new Error('Invalid RPC response.')
    return { jsonrpc: '2.0', id: reply.id, result: reply.result }
  }
  const error = object(reply.error) ? reply.error : {}
  const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : -32000
  const data = revertData(error.data)
  return { jsonrpc: '2.0', id: reply.id,
    error: { code, message: message(error) ?? 'Trusted RPC rejected the request.', ...(data === undefined ? {} : { data }) } }
}

/** Preserve RPC results and recoverable error semantics, never provider transport diagnostics. */
export async function publicRpcResponse(response: Response, headers: HeadersInit): Promise<Response> {
  const failure = (status = response.status) => Response.json({ error: 'Trusted RPC unavailable. Retry without clearing pending transactions.' }, { status, headers })
  if (!response.ok && response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel()
    return failure()
  }
  try {
    const value = await readBody(response, MAX_RESPONSE)
    const replies = Array.isArray(value) ? value : [value]
    if (!response.ok && (!replies.length || replies.some(reply => !object(reply) || !object(reply.error)))) return failure()
    const result = replies.map(sanitized)
    return Response.json(Array.isArray(value) ? result : result[0], { status: response.status, headers })
  } catch { return failure(response.ok ? 502 : response.status) }
}
