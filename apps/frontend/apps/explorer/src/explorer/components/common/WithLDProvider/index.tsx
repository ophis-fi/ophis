import { PropsWithChildren, ReactNode } from 'react'

// LaunchDarkly removed for the Ophis fork: the upstream CoW client-side ID
// triggered failed app.launchdarkly.com requests + console errors on the Ophis
// explorer. All former flags are now statically defaulted at their call sites
// (useSolversFeatureFlag, Home's isTheGraphEnabled). Kept as a pass-through so
// ExplorerApp's component tree is unchanged.
export function WithLDProvider({ children }: PropsWithChildren): ReactNode {
  return children
}
