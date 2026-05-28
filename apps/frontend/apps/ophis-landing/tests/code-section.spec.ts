import { test, expect } from '@playwright/test'

test('code section default tab is curl', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.code-section h2')).toContainText(/Trade.*tonight/)
  await expect(page.locator('.code-section .tab.active')).toContainText('curl')
  await expect(page.locator('.code-section .code-body')).toContainText('swap.ophis.fi/api/intent')
})

// Table-driven: per-tab assertions on the API contract
const TABS = [
  { label: 'curl', requestField: '"text":', responseWrap: '"ok": true', responseData: '"data":' },
  { label: 'JavaScript', requestField: 'text:', responseWrap: 'ok', responseData: 'data' },
  { label: 'Rust', requestField: '"text":', responseWrap: 'parsed.ok', responseData: 'parsed.data' },
]

for (const { label, requestField, responseWrap, responseData } of TABS) {
  test(`${label} tab uses the real API contract (text + ok+data wrapper)`, async ({ page }) => {
    await page.goto('/')
    if (label !== 'curl') {
      await page.locator('.code-section .tab', { hasText: label }).click()
      await page.waitForTimeout(150) // allow hydration + tab switch
    }
    const body = await page.locator('.code-section .code-body').textContent()
    expect(body).toContain('swap.ophis.fi/api/intent')
    expect(body).toContain(requestField)
    // Response shape uses {ok, data} wrapper
    expect(body).toContain(responseWrap)
    expect(body).toContain(responseData)
    // Security: still no auth headers/keys
    expect(body).not.toMatch(/api[_-]?key|x-api-key|bearer|authorization/i)
  })
}
