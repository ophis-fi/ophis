import { test, expect } from '@playwright/test'

test('workflow autoplays all five stages, loops, and supports pause and manual selection', async ({ page }) => {
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  await expect(story).toHaveAttribute('data-playing', '')
  await expect(story.getByRole('button', { name: /replay/i })).toHaveCount(0)
  await page.clock.install()
  for (const scene of [1, 2, 3, 4, 0]) {
    await page.clock.runFor(4500)
    await expect(story).toHaveAttribute('data-scene', String(scene))
    await expect(story.locator('[data-story-panel]:visible')).toHaveCount(1)
  }
  await story.getByRole('button', { name: 'Pause workflow animation' }).click()
  await page.clock.runFor(9000)
  await expect(story).toHaveAttribute('data-scene', '0')
  await story.getByRole('button', { name: 'Resume workflow animation' }).click()
  await page.clock.runFor(4500)
  await expect(story).toHaveAttribute('data-scene', '1')
  await story.locator('[data-story-step="3"]').click()
  await page.clock.runFor(9000)
  await expect(story).toHaveAttribute('data-scene', '3')
  await expect(story).not.toHaveAttribute('data-playing', '')
})

for (const width of [320, 390, 1440]) {
  test(`workflow fits ${width}px with working artwork and all stages readable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const story = page.locator('#swap-story')
    for (let index = 0; index < 5; index++) {
      await story.locator(`[data-story-step="${index}"]`).click()
      const panel = story.locator('[data-story-panel]:visible')
      await expect(panel.getByRole('heading')).toBeVisible()
      const bounds = await panel.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      for (const img of await panel.locator('img').all()) {
        await expect(img).toHaveJSProperty('complete', true)
        expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}

test('reduced motion stays static but allows reading every stage', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  await expect(story).not.toHaveAttribute('data-playing', '')
  await expect(story.locator('#storyPause')).toBeHidden()
  await story.locator('[data-story-step="4"]').click()
  await expect(story.getByRole('heading', { name: 'The result returns to you.' })).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(story).toHaveAttribute('data-playing', '')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(story).not.toHaveAttribute('data-playing', '')
})

test('workflow pauses outside the viewport and never requests a wallet', async ({ page }) => {
  const suspicious: string[] = []
  page.on('request', (req) => {
    if (!new URL(req.url()).pathname.startsWith('/logos/') && /eth_request|walletconnect|web3|wallet/i.test(req.url())) suspicious.push(req.url())
  })
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  await expect(story).toHaveAttribute('data-playing', '')
  await page.locator('footer').scrollIntoViewIfNeeded()
  await expect(story).not.toHaveAttribute('data-playing', '')
  await story.scrollIntoViewIfNeeded()
  await expect(story).toHaveAttribute('data-playing', '')
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

test('sample quote explains its rate and minimum without claiming a live price', async ({ page }) => {
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.locator('[data-story-step="0"]').click()
  await expect(story.locator('.asset-card').last()).toContainText('0.004 ETH')
  await expect(story.locator('.intent-limit').last()).toContainText('0.00398 ETH')
  await expect(story.locator('.story-caption')).toContainText('10 ÷ 2,500 = 0.004 ETH')
  await expect(story.locator('.story-caption')).toContainText('Illustrative amounts before fees')
})
