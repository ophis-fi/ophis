import * as ed from '@noble/ed25519'
import { encryptJSONDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { keccak256, toUtf8Bytes } from 'ethers'
import { MAX_MESSAGE_BYTES } from './config'

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface OpenRequest {
  key: string
  envelope: string
  data: Record<string, unknown>
  sharedKey: Uint8Array
  id: number | string
}

export async function openRequest(
  payload: Uint8Array, privateViewingKey: Uint8Array, publicViewingKey: string,
): Promise<OpenRequest | undefined> {
  if (payload.length > MAX_MESSAGE_BYTES) return
  try {
    const envelope = Buffer.from(payload).toString('utf8')
    const packet: unknown = JSON.parse(envelope)
    if (!object(packet) || packet.method !== 'transact' || !object(packet.params)) return
    const { pubkey, encryptedData } = packet.params
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey) ||
      !Array.isArray(encryptedData) || encryptedData.length !== 2 ||
      !encryptedData.every((part) => typeof part === 'string' && part.length <= MAX_MESSAGE_BYTES)) return
    const sharedKey = await ed.getSharedSecret(privateViewingKey, pubkey)
    const data: unknown = tryDecryptJSONDataWithSharedKey(encryptedData as [string, string], sharedKey)
    if (!object(data) || typeof data.broadcasterViewingKey !== 'string' ||
      data.broadcasterViewingKey.replace(/^0x/i, '').toLowerCase() !== publicViewingKey.toLowerCase()) return
    const id = typeof packet.id === 'string' || (typeof packet.id === 'number' && Number.isSafeInteger(packet.id)) ? packet.id : 0
    // SDK retries can change the JSON-RPC id while retaining the same encrypted operation.
    const key = keccak256(toUtf8Bytes(JSON.stringify([pubkey.toLowerCase(), encryptedData])))
    return { key, envelope, data, sharedKey, id }
  } catch { return undefined }
}

export function encryptResponse(body: Record<string, unknown>, request: OpenRequest): string {
  return JSON.stringify(encryptJSONDataWithSharedKey(body, request.sharedKey))
}

export function responseEnvelope(ciphertext: string, id: number | string): Uint8Array {
  return toUtf8Bytes(JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(ciphertext) }))
}
