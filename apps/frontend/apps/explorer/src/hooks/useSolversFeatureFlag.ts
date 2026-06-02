// LaunchDarkly removed (Ophis fork). Solvers visibility is statically off to
// preserve prior behavior: CoW's LD context never returned isSolversEnabled for
// the 'explorer' key, so this hook already resolved to false at runtime.
export function useSolversFeatureFlag(): boolean {
  return false
}
