import { test, expect } from '@playwright/test'

test('SDK section shows ophisDefaultPartnerFee snippet + install command', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.sdk h2')).toContainText('Ship integrations')
  await expect(page.locator('.sdk .sdk-tag')).toContainText('@ophis/sdk')
  await expect(page.locator('.sdk pre')).toContainText('ophisDefaultPartnerFee')
  await expect(page.locator('.sdk pre')).toContainText('OPHIS_PARTNER_FEE_RECIPIENT')
  await expect(page.locator('.sdk a[href*="npmjs"], .sdk a[href*="github.com/ophis-fi"]').first()).toBeVisible()
})
