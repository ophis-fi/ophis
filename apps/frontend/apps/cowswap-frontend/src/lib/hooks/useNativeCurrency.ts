import { useMemo } from 'react'

import { NATIVE_CURRENCIES, TokenWithLogo } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { useWalletInfo } from '@cowprotocol/wallet'

export const MAINNET_NATIVE_CURRENCY = NATIVE_CURRENCIES[SupportedChainId.MAINNET]

// Return type was previously `TokenWithLogo` (no `| undefined`) but the
// implementation returns `NATIVE_CURRENCIES[chainId]` — a `Record<TargetChainId, ...>`
// lookup that yields `undefined` whenever `useWalletInfo().chainId` is not in
// our `TargetChainId` set (e.g. the user has MetaMask connected to Polygon,
// BSC, Avalanche — any chain we don't list). 2026-05-17 production incident:
// `FinalizeTxUpdater` runs as a global updater on EVERY page including `/`
// and read `useNativeCurrency().symbol` directly — crashing the entire React
// root to the Sentry "Something went wrong" overlay every time a user with
// an unsupported wallet chain loaded any page.
//
// The fix makes the return type honest (`| undefined`) so TypeScript catches
// future unguarded reads at compile time. Callers must now handle the
// undefined case explicitly (typically `?.symbol ?? 'ETH'` or short-circuit).
export default function useNativeCurrency(): TokenWithLogo | undefined {
  const { chainId } = useWalletInfo()

  return useMemo(() => NATIVE_CURRENCIES[chainId], [chainId])
}
