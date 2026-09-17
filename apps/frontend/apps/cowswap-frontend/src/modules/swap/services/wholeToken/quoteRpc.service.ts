import { Interface } from '@ethersproject/abi'
import { JsonRpcProvider } from '@ethersproject/providers'

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11'
const abi = new Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])',
])

type PendingCall = { to: string; data: string; resolve: (data: string) => void; reject: (error: unknown) => void }

class RouteUnavailableError extends Error {}

/** Only an EVM/pool rejection rules out a route. Transport errors must fail the comparison. */
export function unavailableRoute(error: unknown): null {
  if (error instanceof RouteUnavailableError || isEvmRevert(error)) return null
  throw error
}

function isEvmRevert(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const {
    code,
    message,
    error: inner,
    body,
  } = error as { code?: unknown; message?: unknown; error?: unknown; body?: unknown }
  if ([3, -32000, -32015].includes(Number(code))) {
    return /^execution reverted\b/i.test(String(message))
  }
  if (isEvmRevert(inner)) return true
  if (typeof body === 'string') {
    try {
      return isEvmRevert(JSON.parse(body))
    } catch {
      return false
    }
  }
  return false
}

/** Batch independent quoter reads at the same block; stop follow-up work when the form changes. */
export function createQuoteRpc(
  provider: JsonRpcProvider,
  block: number,
  signal?: AbortSignal,
): {
  call: (to: string, data: string) => Promise<string>
  check: () => void
} {
  let queue: PendingCall[] = []
  const check = (): void => signal?.throwIfAborted()
  const flush = async (): Promise<void> => {
    const calls = queue
    queue = []
    try {
      check()
      const data = abi.encodeFunctionData('aggregate3', [calls.map((call) => [call.to, true, call.data])])
      const raw = await provider.call({ to: MULTICALL, data }, block)
      check()
      const results = abi.decodeFunctionResult('aggregate3', raw)[0] as { success: boolean; returnData: string }[]
      calls.forEach((call, i) => {
        const result = results[i]
        if (result?.success) call.resolve(result.returnData)
        else call.reject(new RouteUnavailableError('Pool cannot quote this route'))
      })
    } catch (error) {
      calls.forEach((call) => call.reject(error))
    }
  }
  return {
    check,
    call: (to, data) => {
      check()
      return new Promise((resolve, reject) => {
        const abort = (): void => reject(signal?.reason || new Error('Quote cancelled'))
        signal?.addEventListener('abort', abort, { once: true })
        const cleanup = (): void => signal?.removeEventListener('abort', abort)
        queue.push({
          to,
          data,
          resolve: (value) => {
            cleanup()
            resolve(value)
          },
          reject: (error) => {
            cleanup()
            reject(error)
          },
        })
        if (queue.length === 1) queueMicrotask(() => void flush())
      })
    },
  }
}
