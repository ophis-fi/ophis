import { ArtifactStore, getEngine } from '@railgun-community/wallet'
import { Buffer } from 'buffer'
import level from 'level-js'
import levelup from 'levelup'
import { hexlify, id, toUtf8Bytes } from 'ethers'
import { CHAIN_ID, ENVIRONMENT } from './config'
import type { WalletSession } from './wallet'

const scope = ENVIRONMENT === 'fork' ? 'ophisRailgun' : 'ophisRailgunEthereum'
export const walletDB = level(`${scope}:v0`)
export const preferences = levelup(level(`${scope}Preferences:v0`))

export const artifacts = new ArtifactStore(
  async (path) => {
    const response = await (await caches.open('ophisRailgunArtifacts:v0')).match(artifactKey(path))
    return response ? Buffer.from(await response.arrayBuffer()) : null
  },
  async (_dir, path, value) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
    await (await caches.open('ophisRailgunArtifacts:v0')).put(artifactKey(path), new Response(bytes))
  },
  async (path) => !!(await (await caches.open('ophisRailgunArtifacts:v0')).match(artifactKey(path))),
)

function artifactKey(path: string): string {
  return new URL(`/artifacts/${encodeURIComponent(path)}`, location.origin).href
}

export async function readPreference<T>(key: string): Promise<T | undefined> {
  try {
    return JSON.parse((await preferences.get(key)).toString()) as T
  } catch (error) {
    if (error instanceof Error && 'notFound' in error) return undefined
    throw error
  }
}

export async function encryptionKey(password: string, salt: Uint8Array): Promise<string> {
  if (password.length < 12) throw new Error('Use a password with at least 12 characters.')
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: 600_000, hash: 'SHA-256' },
    material,
    256,
  )
  return hexlify(new Uint8Array(bits)).slice(2)
}

export async function writePreference(key: string, value: unknown): Promise<void> {
  await preferences.put(key, JSON.stringify(value))
}

function privatePath(session: WalletSession, key: string): (Uint8Array | string)[] {
  // Preserve existing Ethereum journals; other chains must never read or resume them.
  return [toUtf8Bytes('ophisPrivate:v0'), session.info.id, id(CHAIN_ID === 1 ? key : `${CHAIN_ID}:${key}`)]
}

export async function readPrivateState(session: WalletSession, key: string): Promise<unknown> {
  try {
    const value = await getEngine().db.getEncrypted(privatePath(session, key), session.key)
    return JSON.parse(Buffer.from(value, 'hex').toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof Error && 'notFound' in error && error.notFound) return undefined
    throw error
  }
}

export async function writePrivateState(session: WalletSession, key: string, value: unknown): Promise<void> {
  await getEngine().db.putEncrypted(privatePath(session, key), session.key, Buffer.from(JSON.stringify(value)))
}

export async function deletePrivateState(session: WalletSession, key: string): Promise<void> {
  await getEngine().db.del(privatePath(session, key))
}
