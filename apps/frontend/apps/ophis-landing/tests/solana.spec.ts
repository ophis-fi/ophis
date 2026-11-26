import { test, expect } from '@playwright/test'
import { SOLANA_FEE_ANSWER, SOLANA_PROGRAM } from '../src/data/chains'

// Native Solana swaps: one page states them, and the pages and files that answer
// "does Ophis support Solana?" and "what does it cost?" say the same thing.
test('Solana has its own page, and the fee, chain and AI surfaces agree with it', async ({ page, request }) => {
  await page.goto('/swap/solana')
  const body = page.locator('main')
  await expect(body.locator('a[href="https://swap.ophis.fi/#/solana"]')).toBeVisible()
  await expect(body).toContainText(SOLANA_PROGRAM)
  await expect(body).toContainText(SOLANA_FEE_ANSWER)
  await expect(body.locator('ol > li')).toHaveCount(5)
  await expect(body).toContainText('choose Reclaim account rent')
  await expect(body).toContainText('None of them builds a Solana order')
  // The two Solana guides and this page link to each other.
  await expect(body.locator('a[href="/blog/solana-dex-aggregator/"]')).toBeVisible()
  await expect(body.locator('a[href="/blog/solana-bridge/"]')).toBeVisible()
  const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((block) => JSON.parse(block))
  const howTo = ld.find((block) => block['@type'] === 'HowTo')
  expect(howTo.step).toHaveLength(5)
  const faq = ld.find((block) => block['@type'] === 'FAQPage')
  expect(faq.mainEntity.map((entry: { name: string }) => entry.name)).toContain('Can I swap on Solana with Ophis?')
  // No sideways scroll on a phone: the program address is one long unbroken string.
  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)

  await page.goto('/pricing')
  await expect(page.locator('main')).toContainText(SOLANA_FEE_ANSWER)
  await expect(page.locator('main a[href="/swap/solana/"]')).toBeVisible()

  await page.goto('/supported-chains')
  await expect(page.locator('main')).toContainText('Does Ophis support Solana?')
  await expect(page.locator('.prose table a[href="/swap/solana/"]')).toBeVisible()

  await page.goto('/')
  await expect(page.locator('#faq')).toContainText('Can I swap on Solana with Ophis?')
  await expect(page.locator('footer a[href="/swap/solana/"]')).toHaveText('Solana swaps')
  await expect(page.locator('#product a[href="/swap/solana/"]')).toHaveCount(1)

  for (const guide of ['/blog/solana-dex-aggregator', '/blog/solana-bridge']) {
    await page.goto(guide)
    await expect(page.locator('main a[href="/swap/solana/"]').first()).toBeVisible()
  }

  const llms = await (await request.get('/llms.txt')).text()
  expect(llms).toContain('https://ophis.fi/swap/solana/')
  expect(llms).toContain(SOLANA_PROGRAM)
  expect(llms).toContain('none of them builds a Solana order')
  const plugin = await (await request.get('/.well-known/ai-plugin.json')).json()
  expect(plugin.description_for_model).toContain('none of them builds a Solana order')
})
