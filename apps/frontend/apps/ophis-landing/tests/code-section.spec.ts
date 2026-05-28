import { test, expect } from '@playwright/test'

test('code section default tab is curl', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.code-section h2')).toContainText(/Trade.*tonight/)
  await expect(page.locator('.code-section .tab.active')).toContainText('curl')
  await expect(page.locator('.code-section .code-body')).toContainText('curl')
  await expect(page.locator('.code-section .code-body')).toContainText('swap.ophis.fi/api/intent')
})

test('clicking JavaScript tab switches code body', async ({ page }) => {
  await page.goto('/')
  const jsTab = page.locator('.code-section button.tab', { hasText: 'JavaScript' })
  await jsTab.waitFor({ state: 'visible' })
  // Preact (client:load) attaches event listeners asynchronously after page load.
  // Use toPass to retry click + assertion until Preact hydration completes.
  await expect(async () => {
    await jsTab.click({ force: true })
    const text = await page.locator('.code-section .code-body').textContent()
    expect(text).toContain('fetch')
  }).toPass({ intervals: [100, 200, 500, 1000, 2000], timeout: 10000 })
  await expect(page.locator('.code-section .code-body')).not.toContainText('curl -X POST')
})

test('code section never includes any auth header or API key in ANY tab', async ({ page }) => {
  await page.goto('/')

  // Assert against each tab's rendered code body, not just the active one.
  // Hydration is async (Preact client:load), so use toPass with retries.
  const tabs = ['curl', 'JavaScript', 'Rust']

  for (const tab of tabs) {
    if (tab !== 'curl') {
      // curl is the default active tab; click the others
      const tabBtn = page.locator('.code-section button.tab', { hasText: tab })
      await expect(async () => {
        await tabBtn.click({ force: true })
        const active = await page.locator('.code-section .tab.active').textContent()
        expect(active).toContain(tab)
      }).toPass({ intervals: [100, 200, 500, 1000, 2000], timeout: 10000 })
    }

    const body = await page.locator('.code-section .code-body').textContent()
    expect(body, `Tab "${tab}" must not contain auth headers`).not.toMatch(
      /api[_-]?key|x-api-key|bearer|authorization/i
    )
  }
})
