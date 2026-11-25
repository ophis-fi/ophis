import { atom } from 'jotai'

import {
  getOphisSolanaWalletRegistry,
  isOphisSolanaWallet,
  supportsOphisSolanaAccount,
  type OphisSolanaWallet,
  type OphisSolanaWalletAccount,
} from '@ophis/solana-sdk'

import { OPHIS_SOLANA_CONFIG } from './solana.constants'

export interface SolanaConnection {
  wallet: OphisSolanaWallet
  account: OphisSolanaWalletAccount
}

export const solanaWalletsAtom = atom<readonly OphisSolanaWallet[]>([])
solanaWalletsAtom.onMount = (set) => {
  const registry = getOphisSolanaWalletRegistry()
  const refresh = (): void => set(registry.get().filter(isOphisSolanaWallet))
  refresh()
  const offRegister = registry.on('register', refresh)
  const offUnregister = registry.on('unregister', refresh)
  return (): void => {
    offRegister()
    offUnregister()
  }
}

export const solanaConnectionAtom = atom<SolanaConnection | null>(null)
export const solanaWalletBusyAtom = atom(false)
export const solanaWalletErrorAtom = atom<string | null>(null)

export const connectSolanaWalletAtom = atom(null, async (_get, set, wallet: OphisSolanaWallet) => {
  const config = OPHIS_SOLANA_CONFIG
  if (!config) return false
  set(solanaWalletBusyAtom, true)
  set(solanaWalletErrorAtom, null)
  try {
    const { accounts } = await wallet.features['standard:connect'].connect()
    const account = accounts.find((candidate) => supportsOphisSolanaAccount(wallet, candidate, config.chain))
    if (!account) throw Error('Select a Solana account on the configured network in your wallet.')
    set(solanaConnectionAtom, { wallet, account })
    return true
  } catch (error: unknown) {
    set(solanaWalletErrorAtom, error instanceof Error ? error.message : 'Wallet connection failed')
    return false
  } finally {
    set(solanaWalletBusyAtom, false)
  }
})

export const disconnectSolanaWalletAtom = atom(null, async (get, set) => {
  const connection = get(solanaConnectionAtom)
  set(solanaConnectionAtom, null)
  try {
    await connection?.wallet.features['standard:disconnect']?.disconnect()
  } catch {
    set(solanaWalletErrorAtom, 'The app disconnected. You can also disconnect it inside your wallet.')
  }
})
