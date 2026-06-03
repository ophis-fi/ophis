import { test, expect } from '@playwright/test'

test('SDK section shows the routing/safety snippet + install command', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.sdk h2')).toContainText('Ship integrations')
  await expect(page.locator('.sdk .sdk-tag')).toContainText('@ophis/sdk')
  await expect(page.locator('.sdk pre')).toContainText('getOphisOrderbookUrl')
  await expect(page.locator('.sdk pre')).toContainText('assertReceiverIsOwner')
  // Partner-fee mechanics are intentionally NOT advertised on the landing.
  await expect(page.locator('.sdk pre')).not.toContainText('ophisDefaultPartnerFee')
  await expect(page.locator('.sdk a[href*="npmjs"], .sdk a[href*="github.com/ophis-fi"]').first()).toBeVisible()
})
