import { useEffect, useState } from 'react'

import { z } from 'zod'

import { TronProvider } from '../tronWallet.atoms'

export function useTronWallets(): { name: string; provider: TronProvider }[] {
  const [wallets, setWallets] = useState<{ name: string; provider: TronProvider }[]>([])
  useEffect(() => {
    const add = (name: string, provider: TronProvider): void =>
      setWallets((current) =>
        current.some((wallet) => wallet.provider === provider) ? current : [...current, { name, provider }],
      )
    const announce = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const detail: unknown = event.detail
      if (!detail || typeof detail !== 'object' || !('provider' in detail) || !('info' in detail)) return
      const { provider, info } = detail
      const parsedInfo = z.object({ name: z.string().max(100) }).safeParse(info)
      if (isTronProvider(provider) && parsedInfo.success) add(parsedInfo.data.name, provider)
    }
    window.addEventListener('TIP6963:announceProvider', announce)
    window.dispatchEvent(new Event('TIP6963:requestProvider'))
    const injected: unknown = (window as Window & { tron?: unknown }).tron
    if (isTronProvider(injected)) add('Tron wallet', injected)
    return () => window.removeEventListener('TIP6963:announceProvider', announce)
  }, [])
  return wallets
}

function isTronProvider(value: unknown): value is TronProvider {
  return (
    !!value &&
    typeof value === 'object' &&
    'request' in value &&
    typeof value.request === 'function' &&
    'on' in value &&
    typeof value.on === 'function' &&
    'removeListener' in value &&
    typeof value.removeListener === 'function' &&
    'tronWeb' in value
  )
}
