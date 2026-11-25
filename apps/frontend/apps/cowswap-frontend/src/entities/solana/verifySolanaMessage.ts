import { utils } from 'ethers'

export async function verifySolanaMessage(address: string, signature: Uint8Array, message: Uint8Array): Promise<void> {
  const keyBytes = Uint8Array.from(utils.base58.decode(address))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'Ed25519', false, ['verify'])
  if (!(await crypto.subtle.verify('Ed25519', key, Uint8Array.from(signature), Uint8Array.from(message))))
    throw Error('The wallet signature does not match this account and message.')
}
