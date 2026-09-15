import { test, expect } from '@playwright/test'

test('built-on strip lists 5 partner items including CoW Protocol and Trail of Bits', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.built-on .built-item')
  await expect(items).toHaveCount(5)
  const names = await page.locator('.built-on .built-name').allTextContents()
  expect(names).toContain('CoW Protocol')
  expect(names).toContain('Trail of Bits')
  expect(names).toContain('Aleph Cloud')
  expect(names).toContain('Across')
  expect(names).not.toContain('LibertAI')
  expect(names).toContain('NEAR Intents')
  // Bungee's API is permanently gone and the swap app no longer routes
  // through it (2026-09-10); the strip must not claim it as a partner.
  expect(names).not.toContain('Bungee')
})

test('built-on strip has updated headline and subhead', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.built-on h2')).toContainText('Built with the tools and partners')
  await expect(page.locator('.built-on .sub')).toContainText('Forked from CoW Protocol')
  await expect(page.locator('.built-on .sub')).not.toContainText('Bungee')
})

test('venue grid shows dapp names and logos without status comments or Arcus', async ({ page }) => {
  await page.goto('/')
  const grid = page.locator('.protocol-grid')
  for (const name of ['RamsesX', 'Dexalot', 'Native', 'Pharaoh', 'UP33']) {
    await expect(grid.getByText(name, { exact: true })).toBeVisible()
  }
  await expect(grid.locator('.protocol')).toHaveCount(20)
  await expect(grid.getByText('Pons', { exact: true })).toHaveCount(0)
  await expect(grid.getByText('Arcus', { exact: true })).toHaveCount(0)
  await expect(grid.locator('.protocol-status')).toHaveCount(0)
  await expect(page.locator('.protocols')).not.toContainText(/unverified|pending/i)
})
