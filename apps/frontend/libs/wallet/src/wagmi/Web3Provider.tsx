import { ReactNode } from 'react'

import { SafeProvider } from '@safe-global/safe-apps-react-sdk'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'

import { config } from './config'

const queryClient = new QueryClient()

interface Web3ProviderProps {
  children: ReactNode
}

export function Web3Provider({ children }: Web3ProviderProps): ReactNode {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {/* Cross-package ReactNode identity mismatch: SafeProvider bundles its own @types/react instance. */}
        <SafeProvider>{children as React.ReactNode}</SafeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
