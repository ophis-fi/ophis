// The canonical fact pages (pricing, supported chains, security). Shared by
// the pages themselves (visible "Last updated" date) and src/pages/sitemap.xml.ts
// (lastmod), so the two cannot drift. Bump `updated` when a page's content
// changes materially.

export interface CanonicalPage {
  /** Trailing-slash path, matching the 200 URL CF Pages serves. */
  path: '/pricing/' | '/supported-chains/' | '/security/'
  updated: Date
}

export const CANONICAL_PAGES: CanonicalPage[] = [
  { path: '/pricing/', updated: new Date('2026-08-02') },
  { path: '/supported-chains/', updated: new Date('2026-08-02') },
  { path: '/security/', updated: new Date('2026-08-02') },
]

export function canonicalPage(path: CanonicalPage['path']): CanonicalPage {
  const page = CANONICAL_PAGES.find((p) => p.path === path)
  if (!page) throw new Error(`canonicalPages.ts has no entry for ${path}`)
  return page
}
