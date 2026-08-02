import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOVEREIGN_CHAINS } from '../src/data/chains'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const dist = (f: string) => join(__dirname, '..', 'dist', f)

// The canonical fact pages: /pricing, /supported-chains, /security.
// Dev server routes are the no-slash form (trailingSlash: 'never'); the
// canonical URL carries the trailing slash CF Pages actually serves at 200.

const PAGES = [
  { route: '/pricing', canonical: 'https://ophis.fi/pricing/', h1: 'Fees and pricing' },
  { route: '/supported-chains', canonical: 'https://ophis.fi/supported-chains/', h1: 'Supported chains' },
  { route: '/security', canonical: 'https://ophis.fi/security/', h1: 'Security' },
]

for (const p of PAGES) {
  test(`${p.route} renders with canonical, breadcrumb + FAQ schema, and a Last updated date`, async ({ page }) => {
    await page.goto(p.route)
    await expect(page.locator('h1')).toHaveText(p.h1)
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', p.canonical)

    const ldBlocks = await page.locator('script[type="application/ld+json"]').allTextContents()
    const types = ldBlocks.flatMap((b) => {
      const parsed = JSON.parse(b)
      const nodes = parsed['@graph'] ?? [parsed]
      return nodes.map((n: { '@type': string }) => n['@type'])
    })
    expect(types).toContain('BreadcrumbList')
    expect(types).toContain('FAQPage')

    await expect(page.locator('.updated time')).toBeVisible()
  })
}

test('pricing page states the flat fee and the partner rate', async ({ page }) => {
  await page.goto('/pricing')
  const body = page.locator('main')
  await expect(body).toContainText('0.10%')
  await expect(body).toContainText('0.01%')
  await expect(body).toContainText('5 bps')
})

test('supported-chains lists every chain from the canonical data, sovereigns badged', async ({ page }) => {
  await page.goto('/supported-chains')
  const table = page.locator('.prose table').first()
  for (const name of ['Ethereum', 'Robinhood Chain', 'Unichain', 'Optimism', 'Plasma', 'Solana', 'Bitcoin']) {
    await expect(table).toContainText(name)
  }
  await expect(page.locator('.badge')).toHaveCount(SOVEREIGN_CHAINS.length)
})

test('sitemap lists the canonical pages with trailing-slash URLs', () => {
  expect(existsSync(dist('sitemap.xml'))).toBe(true)
  const sm = readFileSync(dist('sitemap.xml'), 'utf8')
  for (const p of PAGES) {
    expect(sm).toContain(`<loc>${p.canonical}</loc>`)
  }
})

test('blog posts carry a visible human byline matching the Person schema', async ({ page }) => {
  await page.goto('/blog/swap-on-robinhood-chain')
  const meta = page.locator('.post-meta')
  await expect(meta).toContainText('By ')
  const byline = (await meta.textContent()) ?? ''
  const name = byline.split('·')[0].replace('By', '').trim()
  expect(name.length).toBeGreaterThan(0)

  const ldBlocks = await page.locator('script[type="application/ld+json"]').allTextContents()
  const posting = ldBlocks.map((b) => JSON.parse(b)).find((b) => b['@type'] === 'BlogPosting')
  expect(posting).toBeTruthy()
  expect(posting.author['@type']).toBe('Person')
  expect(posting.author.name).toBe(name)

  const crumbs = ldBlocks.map((b) => JSON.parse(b)).find((b) => b['@type'] === 'BreadcrumbList')
  expect(crumbs).toBeTruthy()
  expect(crumbs.itemListElement).toHaveLength(3)
})
