import { test, expect } from '@playwright/test'

test('code section default tab is curl', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.code-section h2')).toContainText(/Trade.*tonight/)
  await expect(page.locator('.code-section .tab.active')).toContainText('curl')
  await expect(page.locator('.code-section .code-body')).toContainText('curl')
  await expect(page.locator('.code-section .code-body')).toContainText('ophis.fi/api/intent')
})

test('clicking JavaScript tab switches code body', async ({ page }) => {
  await page.goto('/')
  // Ensure viewport is large enough to show code section
  await page.setViewportSize({ width: 1280, height: 900 })
  // Scroll code section into view to trigger client:visible hydration
  await page.locator('.code-section').scrollIntoViewIfNeeded()
  // Wait for Preact hydration: SSR renders divs; Preact replaces with buttons
  await page.waitForFunction(() => {
    const btns = document.querySelectorAll('.code-section button.tab')
    return btns.length > 0
  }, { timeout: 10000 })
  await page.locator('.code-section button.tab', { hasText: 'JavaScript' }).click()
  // Wait for preact re-render
  await expect(page.locator('.code-section .code-body')).toContainText('fetch', { timeout: 5000 })
  await expect(page.locator('.code-section .code-body')).not.toContainText('curl -X POST')
})

test('code section never includes any auth header or API key', async ({ page }) => {
  await page.goto('/')
  // Check all code bodies on the page for security
  const bodies = page.locator('.code-section .code-body')
  await bodies.scrollIntoViewIfNeeded()
  const body = await bodies.textContent()
  expect(body).not.toMatch(/api[_-]?key|x-api-key|bearer|authorization/i)
})
