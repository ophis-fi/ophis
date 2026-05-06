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
        {/* `@safe-global/safe-apps-react-sdk@4.7.2` peers React 16/17/18 and ships `.d.ts`
            files compiled against `@types/react@^18` — its embedded `React.ReactNode`
            predates the React 19 `bigint` addition. Cast bridges the version skew. */}
        <SafeProvider>{children as React.ReactNode}</SafeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
