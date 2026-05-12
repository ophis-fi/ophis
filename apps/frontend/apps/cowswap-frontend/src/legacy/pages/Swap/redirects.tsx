import { Navigate } from 'react-router'

// Ophis: redirects use `replace` so they don't add stuck history
// entries between `/swap` and `/{chainId}/swap/{...}`. Without this,
// browser-back from a fully-qualified swap URL returns to the bare
// `/swap` path which immediately redirects forward again — trapping
// the user on the swap page. See
// docs/development/specs/2026-05-08-ophis-intent-input-design.md
// (issue #3 from the 2026-05-09 review).
//
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function RedirectPathToSwapOnly() {
  return <RedirectToPath path={'/swap'} />
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function RedirectToPath({ path }: { path: string }) {
  return <Navigate to={path} replace />
}
