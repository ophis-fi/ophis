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
  {
    route: '/stablecoin-swaps',
    canonical: 'https://ophis.fi/stablecoin-swaps/',
    h1: 'Stablecoin swaps across onchain markets',
  },
  {
    route: '/tokenized-stocks-rwa',
    canonical: 'https://ophis.fi/tokenized-stocks-rwa/',
    h1: 'Tokenized markets need precise execution',
  },
  {
    route: '/ai-agent-crypto-swap-api',
    canonical: 'https://ophis.fi/ai-agent-crypto-swap-api/',
    h1: 'A bounded swap path for AI agents',
  },
  {
    route: '/swap/robinhood-chain',
    canonical: 'https://ophis.fi/swap/robinhood-chain/',
    h1: 'Swap on Robinhood Chain',
  },
  {
    route: '/migrate/odos-api',
    canonical: 'https://ophis.fi/migrate/odos-api/',
    h1: 'Migrating an Odos API integration',
  },
  {
    route: '/learn/intent-based-dex-aggregator',
    canonical: 'https://ophis.fi/learn/intent-based-dex-aggregator/',
    h1: 'What is an intent-based DEX aggregator?',
  },
  {
    route: '/learn/mev-protected-swaps',
    canonical: 'https://ophis.fi/learn/mev-protected-swaps/',
    h1: 'MEV-protected swaps, explained',
  },
  {
    route: '/learn/ai-agent-token-swaps',
    canonical: 'https://ophis.fi/learn/ai-agent-token-swaps/',
    h1: 'AI agent token swaps: the safe pattern',
  },
  {
    route: '/learn/mcp-server-for-trading',
    canonical: 'https://ophis.fi/learn/mcp-server-for-trading/',
    h1: 'What is an MCP server for trading?',
  },
  {
    route: '/learn/ai-agent-custody',
    canonical: 'https://ophis.fi/learn/ai-agent-custody/',
    h1: 'How should an AI agent hold custody?',
  },
  {
    route: '/learn/api-keys-vs-wallet-signatures',
    canonical: 'https://ophis.fi/learn/api-keys-vs-wallet-signatures/',
    h1: 'Agent trading: API keys vs wallet signatures',
  },
  {
    route: '/learn/what-is-eip-712',
    canonical: 'https://ophis.fi/learn/what-is-eip-712/',
    h1: 'What is EIP-712, and why do agents sign typed data?',
  },
  {
    route: '/learn/what-is-a-sandwich-attack',
    canonical: 'https://ophis.fi/learn/what-is-a-sandwich-attack/',
    h1: 'What is a sandwich attack?',
  },
  {
    route: '/learn/what-is-a-solver',
    canonical: 'https://ophis.fi/learn/what-is-a-solver/',
    h1: 'What is a solver?',
  },
  {
    route: '/learn/coincidence-of-wants',
    canonical: 'https://ophis.fi/learn/coincidence-of-wants/',
    h1: 'What is a coincidence of wants?',
  },
  {
    route: '/learn/slippage-vs-signed-limit',
    canonical: 'https://ophis.fi/learn/slippage-vs-signed-limit/',
    h1: 'Slippage vs a signed limit price',
  },
  {
    route: '/learn/what-is-surplus',
    canonical: 'https://ophis.fi/learn/what-is-surplus/',
    h1: 'What is surplus, and who keeps it?',
  },
  {
    route: '/learn/mev-blockers-vs-batch-auctions',
    canonical: 'https://ophis.fi/learn/mev-blockers-vs-batch-auctions/',
    h1: 'MEV blockers vs batch auctions',
  },
]

for (const p of PAGES) {
  test(`${p.route} renders with canonical, breadcrumb + FAQ schema, and a Last updated date`, async ({ page }) => {
    await page.goto(p.route)
    await expect(page.locator('main h1')).toHaveText(p.h1)
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

test('/learn hub renders and links every guide', async ({ page }) => {
  await page.goto('/learn')
  await expect(page.locator('main h1')).toHaveText('Learn')
  for (const p of PAGES.filter((x) => x.route.startsWith('/learn/'))) {
    await expect(page.locator(`.hub a[href="${p.route}/"]`)).toBeVisible()
  }
})

test('pricing page includes Arc in the standard capture policy', async ({ page }) => {
  await page.goto('/pricing')
  const body = page.locator('main')
  await expect(body).toContainText('1 bp + 80% improvement')
  await expect(body).toContainText('50%/20 bps cap for stables')
  await expect(body).toContainText('Same 1 bp + capped improvement policy')
  const mcpRow = page.locator('tr').filter({ has: page.getByRole('link', { name: 'MCP server' }) })
  await expect(mcpRow.locator('td').nth(2)).toHaveText('Same all-chain policy via CIP-75 appData')
  await expect(body).toContainText("Hosted chains apply the same Ophis base and improvement policy")
  await expect(body).not.toContainText('5 bps')
  await expect(body).not.toContainText('Hosted-chain costs follow the flat schedule')
  await expect(page.getByRole('heading', { name: 'Arc price-improvement policy' })).toBeVisible()
  await expect(body).toContainText('Arc uses the same backend market-order policy')
  await expect(body).toContainText('Historical base-only trades retain their original fees')
  await expect(page.locator('.updated time')).toHaveAttribute('datetime', /2026-09-30/)
})

test('acquisition pages are linked from their relevant guides', async ({ page }) => {
  await page.goto('/pricing')
  await expect(page.locator('a[href="/blog/solver-aligned-pricing/"]')).toBeVisible()
  await page.goto('/ai-agent-crypto-swap-api')
  await expect(page.locator('main a[href="/migrate/odos-api/"]')).toBeVisible()
  await page.goto('/supported-chains')
  await expect(page.locator('main a[href="/swap/robinhood-chain/"]')).toBeVisible()
})

test('supported-chains lists every chain from the canonical data, sovereigns badged', async ({ page }) => {
  await page.goto('/supported-chains')
  const table = page.locator('.prose table').first()
  for (const name of ['Ethereum', 'Robinhood Chain', 'Unichain', 'Optimism', 'Plasma', 'Solana', 'Bitcoin']) {
    await expect(table).toContainText(name)
  }
  await expect(table.locator('.badge')).toHaveCount(SOVEREIGN_CHAINS.length)
})

test('supported-chains explains the current SDK, Arc referrals and enrollment', async ({ page, request }) => {
  await page.goto('/supported-chains')
  const body = page.locator('main')
  const sdk = JSON.parse(readFileSync(join(__dirname, '../../../../../packages/sdk/package.json'), 'utf8'))
  await expect(body).toContainText(`SDK v${sdk.version} and the hosted MCP server`)
  await expect(body).toContainText(`@ophis/sdk v${sdk.version} helpers`)
  await expect(body).toContainText(`npm install @ophis/sdk@${sdk.version}`)
  await expect(body).toContainText('SDK v0.4.3 already supports Arc trading. Upgrade to v0.4.4 to include referral codes on Arc orders.')
  await expect(body).toContainText('Before every order submission, register the actual order owner')
  await expect(body).toContainText('await enrollOphisTrader(orderOwner, { blocking: true })')
  await expect(body).toContainText('Registration alone does not establish partner affiliation')
  await expect(body).toContainText('Affiliate payouts remain disabled.')
  await expect(page.locator('.updated time')).toHaveAttribute('datetime', /2026-09-29/)
  const ldBlocks = await page.locator('script[type="application/ld+json"]').allTextContents()
  const faq = ldBlocks.map((block) => JSON.parse(block)).find((block) => block['@type'] === 'FAQPage')
  expect(JSON.stringify(faq)).toContain(`SDK v${sdk.version} and hosted MCP include Arc (5042)`)
  const guide = await request.get('/.well-known/agent-skills/ophis/SKILL.md')
  expect(guide.ok()).toBe(true)
  const guideText = (await guide.text()).replace(/\s+/g, ' ')
  expect(guideText).toContain('Arc (5042) is also Ophis-operated and is supported by the published SDK and hosted MCP.')
  expect(guideText).toContain("It remains outside this skill's three-chain execution policy.")
  const sitemap = readFileSync(dist('sitemap.xml'), 'utf8')
  expect(sitemap).toMatch(/<loc>https:\/\/ophis\.fi\/supported-chains\/<\/loc>\s*<lastmod>2026-09-29/)
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
