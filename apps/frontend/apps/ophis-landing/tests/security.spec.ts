import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('security page credits the audit methodology without implying endorsements', async ({ page }) => {
  await page.goto('/security')

  const cards = page.locator('.audit-methodology .tool-card')
  await expect(cards).toHaveCount(4)
  await expect(cards).toContainText(['Pashov skills', 'ETHSKILLS', 'Trail of Bits', 'Verity Lang'])

  const logos = page.locator('.audit-methodology .logo-stage img')
  await expect(logos).toHaveCount(4)
  for (const logo of await logos.all()) {
    await expect(logo).toHaveJSProperty('complete', true)
    expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  }

  await expect(page.locator('.audit-methodology .methodology-note')).toContainText(
    'do not represent an independent audit, engagement, certification, or endorsement',
  )
})

test('security methodology stacks cleanly and stays accessible on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/security')

  const cards = page.locator('.audit-methodology .tool-card')
  const firstCard = await cards.nth(0).boundingBox()
  const secondCard = await cards.nth(1).boundingBox()
  expect(firstCard).not.toBeNull()
  expect(secondCard).not.toBeNull()
  expect(secondCard!.y).toBeGreaterThanOrEqual(firstCard!.y + firstCard!.height)

  const results = await new AxeBuilder({ page }).include('.audit-methodology').analyze()
  expect(results.violations).toEqual([])
})
