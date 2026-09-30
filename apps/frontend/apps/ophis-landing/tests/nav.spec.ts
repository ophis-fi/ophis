import { test, expect } from '@playwright/test'

for (const width of [320, 390, 1280]) {
  test(`Arc announcement shows its logo and links to Arc at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/')
    const banner = page.getByRole('complementary', { name: 'Product announcement' })
    await expect(banner).toBeVisible()
    await expect(banner).toHaveText('Arc is live on Ophis. Trade now →')
    const link = banner.getByRole('link')
    await expect(link).toHaveAttribute('href', 'https://swap.ophis.fi/#/5042/swap')
    const logo = banner.locator('img')
    await expect(logo).toHaveAttribute('src', '/logos/chain-arc-network.svg')
    await logo.evaluate((img: HTMLImageElement) => img.decode())
    await expect(logo).toHaveCSS('filter', 'none')
    const size = await logo.evaluate((img) => ({ width: img.clientWidth, height: img.clientHeight }))
    expect(size.width).toBeGreaterThan(0)
    expect(size.width).toBe(size.height)
    expect(await banner.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(width)
    await link.focus()
    await expect(link).toBeFocused()
  })
}

test('nav renders mono logo + nav links + Trade CTA', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.nav .logo')).toContainText('Ophis')
  // Logo is the Ophis mono mark image
  const mark = page.locator('.nav .logo img.logo-mark')
  await expect(mark).toBeVisible()
  await expect(mark).toHaveAttribute('src', '/ophis-mono.svg')
  const links = page.locator('.nav .nav-links a')
  await expect(links).toHaveCount(7)
  await expect(page.locator('.nav .nav-cta')).toHaveText(/Trade/)
})

test('nav becomes frosted past scroll threshold', async ({ page }) => {
  await page.goto('/')
  await page.setViewportSize({ width: 1200, height: 800 })
  // Ensure document has enough height to scroll
  await page.evaluate(() => {
    document.body.style.minHeight = '3000px'
  })
  await expect(page.locator('.nav')).not.toHaveClass(/scrolled/)
  // Deterministically scroll past the 40px threshold + fire the scroll event.
  // (Avoids the prior flaky-deploy source: smooth-scroll / a missed native
  // scrollTo event under CI load.)
  await page.evaluate(() => {
    // html has scroll-behavior:smooth, which animates the jump — disable it so
    // scrollTop applies instantly and the dispatched scroll event sees >40.
    document.documentElement.style.scrollBehavior = 'auto'
    document.documentElement.scrollTop = 600
    window.dispatchEvent(new Event('scroll'))
  })
  await expect(page.locator('.nav')).toHaveClass(/scrolled/)
})

test('mobile nav: hamburger opens the drawer; Escape closes it and restores scroll + focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const burger = page.locator('#nav-burger')
  const drawer = page.locator('#nav-drawer')
  // On mobile the burger replaces the (now-hidden) desktop links.
  await expect(burger).toBeVisible()
  await expect(page.locator('.nav .nav-links')).toBeHidden()
  // Drawer mirrors the 7 links + the Trade CTA.
  await expect(page.locator('#nav-drawer .nav-drawer-links a')).toHaveCount(8)
  // Open.
  await burger.click()
  await expect(burger).toHaveAttribute('aria-expanded', 'true')
  await expect(drawer).toHaveAttribute('data-open', 'true')
  expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden')
  // Escape closes, restores body scroll, and returns focus to the burger.
  await page.keyboard.press('Escape')
  await expect(burger).toHaveAttribute('aria-expanded', 'false')
  await expect(drawer).toHaveAttribute('data-open', 'false')
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('visible')
  expect(await burger.evaluate((b) => document.activeElement === b)).toBe(true)
})
