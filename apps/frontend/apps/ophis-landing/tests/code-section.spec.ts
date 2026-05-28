import { test, expect } from '@playwright/test'

test('code section default tab is curl', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.code-section h2')).toContainText(/Trade.*tonight/)
  await expect(page.locator('.tab.active')).toContainText('curl')
  await expect(page.locator('.code-body')).toContainText('curl')
  await expect(page.locator('.code-body')).toContainText('ophis.fi/api/intent')
})

test('clicking JavaScript tab switches code body', async ({ page }) => {
  await page.goto('/')
  // Scroll code section into view to trigger client:visible hydration
  await page.locator('.code-section').scrollIntoViewIfNeeded()
  // Wait for the interactive tab button (Preact hydrated)
  const jsTab = page.locator('.tab', { hasText: 'JavaScript' })
  await jsTab.waitFor({ state: 'visible' })
  await jsTab.click()
  await expect(page.locator('.code-body')).toContainText('fetch')
  await expect(page.locator('.code-body')).not.toContainText('curl -X POST')
})

test('code section never includes any auth header or API key', async ({ page }) => {
  await page.goto('/')
  const body = await page.locator('.code-body').textContent()
  expect(body).not.toMatch(/api[_-]?key|x-api-key|bearer|authorization/i)
})
