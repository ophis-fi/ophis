import { atom } from 'jotai'

import type { Wallet, WalletAccount } from '@mysten/wallet-standard'
import type { StandardConnectFeature, StandardEventsFeature } from '@wallet-standard/features'

export type StandardSourceChain = 'sol' | 'sui'
export type SourceStandardWallet = Wallet & { features: StandardConnectFeature & StandardEventsFeature }
export interface StandardConnection {
  wallet: SourceStandardWallet
  account: WalletAccount
}
export const standardWalletsAtom = atom<Partial<Record<StandardSourceChain, StandardConnection>>>({})
