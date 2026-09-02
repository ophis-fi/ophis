import { test, expect } from '@playwright/test'

test('hero has headline, accent word, two CTAs', async ({ page }) => {
  await page.goto('/')
  const h1 = page.locator('.hero h1')
  await expect(h1).toContainText('MEV-protected swaps')
  await expect(h1).toContainText('onchain markets')
  await expect(page.locator('.hero .accent')).toContainText('onchain markets')
  await expect(page.locator('.hero .cta-primary')).toContainText(/Trade now/)
  await expect(page.locator('.hero .cta-secondary')).toContainText(/Integrate Ophis/)
})

test('trade CTA emits the acquisition event without including page or destination URLs', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const state = window as unknown as {
      analyticsCalls: unknown[][]
      gtag: (...args: unknown[]) => void
    }
    state.analyticsCalls = []
    state.gtag = (...args: unknown[]) => state.analyticsCalls.push(args)
    document.querySelector('.hero .cta-primary')?.addEventListener('click', (event) => event.preventDefault())
  })

  await page.locator('.hero .cta-primary').click()
  const calls = await page.evaluate(
    () => (window as unknown as { analyticsCalls: unknown[][] }).analyticsCalls,
  )
  expect(calls).toEqual([
    ['event', 'trade_click', { destination: 'swap_app' }],
  ])
})

test('hero is single-column centered (no claw image)', async ({ page }) => {
  await page.goto('/')
  // No claw img in hero
  const clawImg = page.locator('.hero img')
  await expect(clawImg).toHaveCount(0)
  // Hero copy is centered
  const heroCopy = page.locator('.hero-inner')
  await expect(heroCopy).toBeVisible()
})
