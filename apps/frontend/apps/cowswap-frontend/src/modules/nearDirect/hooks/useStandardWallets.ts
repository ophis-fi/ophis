import { useEffect, useState } from 'react'

import { getWallets } from '@wallet-standard/app'

import { SourceStandardWallet, StandardSourceChain } from '../standardWallet.atoms'
import { supportsSourceWallet } from '../standardWallet.service'

export function useStandardWallets(chain: StandardSourceChain): readonly SourceStandardWallet[] {
  const [wallets, setWallets] = useState<readonly SourceStandardWallet[]>([])
  useEffect(() => {
    const registry = getWallets()
    const update = (): void => setWallets(registry.get().filter((wallet) => supportsSourceWallet(wallet, chain)))
    update()
    const offRegister = registry.on('register', update)
    const offUnregister = registry.on('unregister', update)
    return () => {
      offRegister()
      offUnregister()
    }
  }, [chain])
  return wallets
}
