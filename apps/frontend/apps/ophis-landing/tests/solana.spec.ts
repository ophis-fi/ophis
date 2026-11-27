import { test, expect } from '@playwright/test'
import { SOLANA_FEE_ANSWER, SOLANA_PROGRAM } from '../src/data/chains'

// Native Solana swaps: one page presents them (actions, logos, steps, fees, program),
// and the pages and files that answer "does Ophis support Solana?" and "what does it
// cost?" say the same thing.
test('Solana has its own page, and the fee, chain and AI surfaces agree with it', async ({ page, request }) => {
  await page.goto('/swap/solana')
  const body = page.locator('main')
  // Three calls to action open the Solana swap: the hero, the steps and the closing band.
  await expect(body.locator('.hero .cta-primary')).toHaveAttribute('href', 'https://swap.ophis.fi/#/solana')
  await expect(body.locator('a[href="https://swap.ophis.fi/#/solana"]')).toHaveCount(3)
  await expect(body).toContainText(SOLANA_PROGRAM)
  await expect(body).toContainText(SOLANA_FEE_ANSWER)
  await expect(body.locator('ol > li')).toHaveCount(5)
  await expect(body.locator('table.fees tbody tr')).toHaveCount(3)
  await expect(body).toContainText('choose Reclaim account rent')
  await expect(body).toContainText('None of them builds a Solana order')
  // The picture names the six venues, the hero the three wallets, and every image loads.
  for (const name of ['Raydium', 'Orca', 'Meteora', 'PumpSwap', 'Manifest', 'Jupiter']) {
    await expect(body.locator(`.orbit img[alt="${name} logo"]`)).toBeVisible()
  }
  await expect(body.locator('.wallets li')).toHaveText(['Phantom', 'Solflare', 'Backpack', 'WalletConnect'])
  // The picture has no caption, it loops, and its checkbox pauses it.
  await expect(body.locator('.orbit figcaption')).toHaveCount(0)
  const playState = () => page.evaluate(() => getComputedStyle(document.querySelector('.orbit .packet-in') as Element).animationPlayState)
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.orbit .packet-in') as Element).animationName)).toBe('orbit-in')
  expect(await playState()).toBe('running')
  await page.getByRole('checkbox', { name: 'Pause the animation' }).press('Space')
  expect(await playState()).toBe('paused')
  await body.locator('.guide').first().scrollIntoViewIfNeeded()
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('main img')].every((img) => (img as HTMLImageElement).naturalWidth > 0)), {
      timeout: 20_000,
    })
    .toBe(true)
  // No stretched bitmap in the picture: a logo is a vector, or has 1.5 times the pixels it is shown at.
  const stretched = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('.orbit img')]
      .filter((img) => !img.src.endsWith('.svg') && img.naturalWidth < img.getBoundingClientRect().width * 1.5)
      .map((img) => img.src),
  )
  expect(stretched).toEqual([])
  // The two Solana guides and this page link to each other.
  await expect(body.locator('a[href="/blog/solana-dex-aggregator/"]')).toBeVisible()
  await expect(body.locator('a[href="/blog/solana-bridge/"]')).toBeVisible()
  await expect(page.locator('meta[property="og:image"]')).not.toHaveAttribute('content', 'https://ophis.fi/og-image.png')
  const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((block) => JSON.parse(block))
  const howTo = ld.find((block) => block['@type'] === 'HowTo')
  expect(howTo.step).toHaveLength(5)
  const faq = ld.find((block) => block['@type'] === 'FAQPage')
  expect(faq['@id']).toBe('https://ophis.fi/swap/solana/#faq')
  expect(faq.mainEntity.map((entry: { name: string }) => entry.name)).toContain('Can I swap on Solana with Ophis?')
  expect(ld.find((block) => block['@type'] === 'WebPage').dateModified).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // A click on the hero button is counted as a trade click, like the EVM swap links.
  await page.evaluate(() => {
    const state = window as unknown as { calls: unknown[][]; gtag: (...args: unknown[]) => void }
    state.calls = []
    state.gtag = (...args) => state.calls.push(args)
    document.querySelector('.hero .cta-primary')?.addEventListener('click', (event) => event.preventDefault())
  })
  await body.locator('.hero .cta-primary').click()
  expect(await page.evaluate(() => (window as unknown as { calls: unknown[][] }).calls)).toEqual([
    ['event', 'trade_click', { destination: 'swap_app', page_location: 'https://ophis.fi/swap/solana/' }],
  ])
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
