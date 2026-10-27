import { JsonRpcProvider } from 'ethers'
import { RailgunEngine } from '@railgun-community/engine'
import { setLoggers } from '@railgun-community/wallet'

export async function enableForkDiagnostics(): Promise<void> {
  const provider = new JsonRpcProvider(new URL('/rpc', location.origin).href)
  if (!(await provider.send('anvil_metadata', [])).forkedNetwork)
    throw new Error('Diagnostics require a local Anvil fork.')
  provider.destroy()
  const log = (message: string): void => console.info('[fork]', message.slice(0, 180))
  const error = (message: Error | string): void => {
    let cause: unknown = message
    for (let depth = 0; depth < 4 && cause != null; depth += 1) {
      log(cause instanceof Error ? cause.message : String(cause))
      cause = cause instanceof Error ? cause.cause : undefined
    }
  }
  setLoggers(log, error)
  RailgunEngine.setEngineDebugger({ log, error, verboseScanLogging: false })
}
