import { JSX, PropsWithChildren, ReactNode } from 'react'

import { LAUNCH_DARKLY_CLIENT_KEY } from '@cowprotocol/common-const'

import { withLDProvider } from 'launchdarkly-react-client-sdk'

function InnerWithLDProvider({ children }: PropsWithChildren): ReactNode {
  return children
}

// Ophis fork: skip LaunchDarkly entirely when no client key is set.
// CoW upstream depends on LD for feature flags; we don't have an LD
// account. Without this guard, withLDProvider() runs with an empty
// clientSideID which causes the SDK to fire `network error (Error)`
// repeatedly, CORS-block on app.launchdarkly.com, and leak through
// downstream `useFlags()` consumers returning undefined values.
export const WithLDProvider = LAUNCH_DARKLY_CLIENT_KEY
  ? withLDProvider<PropsWithChildren & JSX.IntrinsicAttributes>({
      clientSideID: LAUNCH_DARKLY_CLIENT_KEY,
      context: {
        kind: 'user',
        key: 'cowswap',
        name: 'cowswap',
      },
      options: {
        bootstrap: 'localStorage',
      },
    })(InnerWithLDProvider)
  : InnerWithLDProvider
