import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAddress, ZeroAddress } from 'ethers'
import { openOperator } from './custody'
import { parseMainnetSecrets, parseSecrets, privateDirectory, privateFile } from './secrets'

export interface OwnerIdentity { gasWalletAddress: string; runtimeSha256: string; retiredSha256: string }
const chains = new Set(['1', '42161', '56', '137'])
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function loadOwnerIdentity(recoveryKeyPath: string, chainId: string): OwnerIdentity {
  if (!chains.has(chainId)) throw new Error('Unsupported owner operator chain.')
  const parent = dirname(recoveryKeyPath)
  if ((lstatSync(parent).mode & 0o777) !== 0o700) throw new Error('Owner identity pins require a private directory (0700).')
  privateDirectory(parent)
  const path = join(parent, 'operator-identities.json')
  if ((lstatSync(path).mode & 0o777) !== 0o600) throw new Error('Owner identity pins require private permissions (0600).')
  const manifest: unknown = JSON.parse(privateFile(path).toString())
  if (!object(manifest) || manifest.version !== 1 || Object.keys(manifest).some((key) => !['version', 'chains'].includes(key)) ||
    !object(manifest.chains)) throw new Error('Invalid owner identity pins.')
  const entries: Record<string, OwnerIdentity> = {}
  for (const [chain, entry] of Object.entries(manifest.chains)) {
    if (!chains.has(chain) || !object(entry) || Object.keys(entry).length !== 3 ||
      Object.keys(entry).some((key) => !['gasWalletAddress', 'runtimeSha256', 'retiredSha256'].includes(key)) ||
      typeof entry.gasWalletAddress !== 'string' || typeof entry.runtimeSha256 !== 'string' || typeof entry.retiredSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.runtimeSha256) || !/^[0-9a-f]{64}$/.test(entry.retiredSha256))
      throw new Error('Invalid owner identity pins.')
    const gasWalletAddress = getAddress(entry.gasWalletAddress)
    if (gasWalletAddress === ZeroAddress) throw new Error('Invalid owner operator address.')
    entries[chain] = { gasWalletAddress, runtimeSha256: entry.runtimeSha256, retiredSha256: entry.retiredSha256 }
  }
  if (!entries[chainId]) throw new Error('Provision trusted owner identity pins for this chain before unlocking.')
  return entries[chainId]
}

export function openPinnedOperator(sealed: Buffer, recoveryKey: Buffer, identity: OwnerIdentity, role: 'runtime' | 'retired'): Buffer {
  const expected = role === 'retired' ? identity.retiredSha256 : identity.runtimeSha256
  if (createHash('sha256').update(sealed).digest('hex') !== expected) throw new Error('Encrypted operator file does not match its trusted owner pin.')
  const clear = openOperator(sealed, recoveryKey)
  try {
    if (role === 'runtime') parseMainnetSecrets(clear, identity.gasWalletAddress)
    else if (!parseSecrets(clear).feeMnemonic) throw new Error('Invalid retired operator payload.')
    return clear
  } catch {
    clear.fill(0)
    throw new Error('Operator payload does not match the trusted owner role and identity.')
  }
}
