import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { Mnemonic, Wallet } from 'ethers'

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const s = lstatSync(path)
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077))
    throw new Error('Operator storage requires an owned private directory (0700).')
}

export function privateFile(path: string, create = false): Buffer {
  const fd = openSync(path, (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY) |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077))
      throw new Error('Operator files must be owned, private regular files (0600).')
    if (!create && s.size > 32 * 1024) throw new Error('Operator secrets exceed the size limit.')
    return create ? Buffer.alloc(0) : readFileSync(fd)
  } finally { closeSync(fd) }
}

export interface Secrets { gasKey: string; feeMnemonic?: string; feeViewingKey?: string; encryptionKey: string }

export function parseSecrets(data: Buffer): Secrets {
  try {
    if (data.length > 8192) throw new Error()
    const value = JSON.parse(data.toString()) as Secrets
    if (!value || Object.keys(value).some((key) => !['gasKey', 'encryptionKey', 'feeMnemonic', 'feeViewingKey'].includes(key)) ||
      typeof value.gasKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.gasKey) ||
      (value.feeMnemonic === undefined) === (value.feeViewingKey === undefined) ||
      (value.feeMnemonic !== undefined && (typeof value.feeMnemonic !== 'string' || !Mnemonic.isValidMnemonic(value.feeMnemonic))) ||
      (value.feeViewingKey !== undefined && (typeof value.feeViewingKey !== 'string' || !/^[0-9a-f]{128,1024}$/.test(value.feeViewingKey))) ||
      typeof value.encryptionKey !== 'string' || !/^[0-9a-f]{64}$/i.test(value.encryptionKey)) throw new Error()
    return value
  } catch { throw new Error('Invalid or inaccessible operator secrets; no secret values were logged.') }
}

export function parseMainnetSecrets(data: Buffer, operatorAddress: string): Secrets {
  const value = parseSecrets(data)
  if (!value.feeViewingKey || value.feeMnemonic || new Wallet(value.gasKey).address !== operatorAddress)
    throw new Error('The unlocked keys do not match the configured gas and view-only fee custody.')
  return value
}
