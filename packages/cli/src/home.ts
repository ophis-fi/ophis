// Where ophis keeps its one local file: the WalletConnect session. No private key is ever stored.
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { UserError } from './ui.ts'

const homeFromEnv = process.env.OPHIS_HOME
export const OPHIS_HOME = homeFromEnv ? homeFromEnv : join(homedir(), '.ophis')

/** An empty or relative OPHIS_HOME would scatter files into whatever folder ophis runs in: refuse it. */
export function checkHome(): void {
  if (homeFromEnv !== undefined && !isAbsolute(homeFromEnv)) {
    throw new UserError('OPHIS_HOME must be a full path (like /Users/you/.ophis). Unset it to use ~/.ophis.')
  }
}
