import { useMemo } from 'react'

import { CHAIN_INFO } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

export function useNetworkName(): string | undefined {
  const { chainId } = useWalletInfo()

  return useMemo(() => {
    // 2026-05-17 Codex-Cyber finding: CHAIN_INFO[chainId] is undefined for
    // chains outside our SupportedChainId set (wallet provider injected an
    // unsupported chain id), and the `.label` access would crash any caller.
    // Latent today (no live call site found) but hardened pre-emptively to
    // close the trust-boundary class entirely.
    return CHAIN_INFO[chainId]?.label || ''
  }, [chainId])
}
