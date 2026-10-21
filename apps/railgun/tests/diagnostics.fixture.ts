import { JsonRpcProvider } from 'ethers'
import { RailgunEngine } from '@railgun-community/engine'
import { setLoggers } from '@railgun-community/wallet'

export async function enableForkDiagnostics(): Promise<void> {
  const provider = new JsonRpcProvider(new URL('/rpc', location.origin).href)
  if (!(await provider.send('anvil_metadata', [])).forkedNetwork)
    throw new Error('Diagnostics require a local Anvil fork.')
  provider.destroy()
  const log = (message: string): void => console.info('[fork]', message.slice(0, 180))
  const error = (message: Error | string): void => log(message instanceof Error ? message.message : message)
  setLoggers(log, error)
  RailgunEngine.setEngineDebugger({ log, error, verboseScanLogging: false })
}
