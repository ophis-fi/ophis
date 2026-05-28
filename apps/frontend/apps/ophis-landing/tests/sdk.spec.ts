import { test, expect } from '@playwright/test'

test('SDK section shows configurePartnerFee snippet + install command', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.sdk h2')).toContainText('Ship integrations')
  await expect(page.locator('.sdk .sdk-tag')).toContainText('@ophis/sdk')
  await expect(page.locator('.sdk pre')).toContainText('configurePartnerFee')
  await expect(page.locator('.sdk a[href*="npmjs"], .sdk a[href*="github.com/ophis-fi"]').first()).toBeVisible()
})
