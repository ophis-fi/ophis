import { test, expect } from '@playwright/test'

test('swap story shows the sample USDC -> ETH trade with limit and caption', async ({ page }) => {
  await page.goto('/')
  const story = page.locator('#swap-story')
  await expect(story).toBeVisible()
  await expect(story.locator('.story-pay .story-value')).toContainText('10')
  await expect(story.locator('.story-output')).toContainText('0.003996')
  await expect(story.locator('.story-output')).toContainText('ETH')
  await expect(story.locator('.story-limit .story-value')).toContainText('10')
  await expect(story.locator('.story-limit')).toContainText('Partial approval selected')
  await expect(story.locator('.story-caption')).toContainText('Illustrative trade')
  await expect(story.locator('.story-caption')).toContainText('No wallet connection')
  // Token logos resolve.
  for (const img of await story.locator('img').all()) {
    await expect(img).toHaveJSProperty('complete', true)
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  }
})

test('scene buttons switch scenes and replay settles on the final scene', async ({ page }) => {
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  // Manual scene selection stops the autoplay and jumps.
  await story.locator('[data-story-step="0"]').click()
  await expect(story).toHaveAttribute('data-scene', '0')
  await expect(story.locator('[data-story-step="0"]')).toHaveAttribute('aria-pressed', 'true')
  await story.locator('[data-story-step="1"]').click()
  await expect(story).toHaveAttribute('data-scene', '1')
  // Replay runs the finite sequence and settles on the limit scene.
  await story.locator('#storyReplay').click()
  await expect(story).toHaveAttribute('data-scene', '2', { timeout: 5000 })
  await expect(story).not.toHaveAttribute('data-playing', '', { timeout: 5000 })
})

test('reduced motion keeps the story static on the final scene', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  await story.locator('#storyReplay').click()
  await expect(story).toHaveAttribute('data-scene', '2')
  await expect(story).not.toHaveAttribute('data-playing', '')
  await ctx.close()
})

test('story interaction makes no wallet or dapp requests', async ({ page }) => {
  const suspicious: string[] = []
  page.on('request', (req) => {
    if (/eth_request|walletconnect|web3|wallet/i.test(req.url())) suspicious.push(req.url())
  })
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  await story.locator('[data-story-step="0"]').click()
  await story.locator('#storyReplay').click()
  await expect(story).toHaveAttribute('data-scene', '2', { timeout: 5000 })
  expect(suspicious).toEqual([])
})

test('network chips swap the destination panel', async ({ page }) => {
  await page.goto('/')
  const panel = page.locator('#chainPanel')
  await expect(panel.locator('#chainTitle')).toContainText('same-chain settlement')
  await page.locator('[data-chain="solana"]').click()
  await expect(panel.locator('#chainTitle')).toContainText('needs a Solana address')
  await expect(panel.locator('#chainText')).toContainText('Solana address')
  await page.locator('[data-chain="bitcoin"]').click()
  await expect(panel.locator('#chainTitle')).toContainText('native BTC only')
  await expect(panel.locator('#chainText')).toContainText('native BTC')
  await page.locator('[data-chain="ethereum"]').click()
  await expect(panel.locator('#chainTitle')).toContainText('same-chain settlement')
})

 test('changing motion preference stops an active replay', async ({ page }) => {
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  await story.locator('#storyReplay').click()
  await expect(story).toHaveAttribute('data-playing', '')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(story).not.toHaveAttribute('data-playing', '')
  await expect(story).toHaveAttribute('data-scene', '2')
})
