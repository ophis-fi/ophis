import { atom } from 'jotai'

import type { TronWeb } from 'tronweb'

export interface TronProvider {
  request(args: { method: string }): Promise<unknown>
  tronWeb: TronWeb | false
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}
export interface TronConnection {
  provider: TronProvider
  address: string
  name: string
}
export const tronWalletAtom = atom<TronConnection | undefined>(undefined)
