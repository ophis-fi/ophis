import { test, expect } from '@playwright/test'

test('built-on strip lists the 8 tools and partners a swap touches today', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.built-on .built-item')
  await expect(items).toHaveCount(8)
  const names = await page.locator('.built-on .built-name').allTextContents()
  for (const name of ['CoW Protocol', 'Trail of Bits', 'NEAR Intents', 'Across', 'Relay', 'Circle CCTP', 'RAILGUN', 'Safe']) {
    expect(names).toContain(name)
  }
  // Dropped 2026-11-26 (owner): the strip lists what is integrated today.
  expect(names).not.toContain('Aleph Cloud')
  expect(names).not.toContain('LibertAI')
  // Bungee's API is permanently gone and the swap app no longer routes
  // through it (2026-09-10); the strip must not claim it as a partner.
  expect(names).not.toContain('Bungee')
})

test('built-on strip has updated headline and subhead', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.built-on h2')).toContainText('Built with the tools and partners')
  await expect(page.locator('.built-on .sub')).toContainText('Forked from CoW Protocol')
  await expect(page.locator('.built-on .sub')).not.toContainText('Bungee')
  await expect(page.locator('.built-on .sub')).not.toContainText('Aleph')
})

test('venue grid shows dapp names and logos without status comments or Arcus', async ({ page }) => {
  await page.goto('/')
  const grid = page.locator('.protocol-grid')
  for (const name of ['RamsesX', 'Dexalot', 'Native', 'Pharaoh', 'UP33']) {
    await expect(grid.getByText(name, { exact: true })).toBeVisible()
  }
  // The Solana venues of the native solver, added 2026-11-26.
  for (const name of ['Raydium', 'Orca', 'Meteora', 'PumpSwap', 'Manifest', 'Jupiter']) {
    await expect(grid.getByText(name, { exact: true })).toBeVisible()
  }
  await expect(grid.locator('.protocol')).toHaveCount(26)
  await expect(grid.getByText('Pons', { exact: true })).toHaveCount(0)
  await expect(grid.getByText('Arcus', { exact: true })).toHaveCount(0)
  await expect(grid.locator('.protocol-status')).toHaveCount(0)
  await expect(page.locator('.protocols')).not.toContainText(/unverified|pending/i)
})
