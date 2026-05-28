import { test, expect } from '@playwright/test'

test('chains strip lists 13 chains including Ethereum, Solana, Bitcoin', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.chains .chain')
  await expect(items).toHaveCount(13)
  // Check key chains by name
  const texts = await items.allTextContents()
  const names = texts.map(t => t.trim())
  expect(names.some(n => n.includes('Ethereum'))).toBe(true)
  expect(names.some(n => n.includes('Solana'))).toBe(true)
  expect(names.some(n => n.includes('Bitcoin'))).toBe(true)
  expect(names.some(n => n.includes('Optimism'))).toBe(true)
})

test('chains strip shows via-NEAR label for Solana and Bitcoin', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.chains .chain')
  const all = await items.all()
  let solanaFound = false
  let bitcoinFound = false
  for (const item of all) {
    const text = await item.textContent()
    if (text?.includes('Solana') && text?.includes('via NEAR')) solanaFound = true
    if (text?.includes('Bitcoin') && text?.includes('via NEAR')) bitcoinFound = true
  }
  expect(solanaFound).toBe(true)
  expect(bitcoinFound).toBe(true)
})
