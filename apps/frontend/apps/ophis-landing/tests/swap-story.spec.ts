import { test, expect } from '@playwright/test'

test('native animation rotates crosschain, same-chain and stock examples without controls', async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  const story = page.locator('#swap-story')
  await story.scrollIntoViewIfNeeded()
  await expect(story).toHaveAttribute('data-playing', 'true')
  await expect(story.locator('button, video, canvas, .scene-footer, .preview-footnote, .token-label, .chain-badge text')).toHaveCount(0)
  await expect(story.locator('.solver text')).toHaveText(['Horadrim', 'Tsolver', 'OKX'])
  const titles = ['USDC on Ethereum to SOL on Solana', 'ETH on Ethereum to USDC on Ethereum', 'USDC on Base to AAPLc on Base', 'USDC on Base to ETH on Ethereum', 'USDC on Base to NVDAc on Base']
  await expect(story.locator('#scene-title')).toHaveText(titles[0])
  for (const index of [1, 2, 3, 4, 0]) {
    await page.clock.runFor(4800)
    await expect(story).toHaveAttribute('data-example', String(index))
    await expect(story.locator('#scene-title')).toHaveText(titles[index])
  }
  await story.locator('#story-scene').focus()
  await page.keyboard.press('Space')
  await expect(story).toHaveAttribute('data-playing', 'false')
  const pausedExample = await story.getAttribute('data-example')
  await page.clock.runFor(9600)
  await expect(story).toHaveAttribute('data-example', pausedExample ?? '')
  await page.keyboard.press('Enter')
  await expect(story).toHaveAttribute('data-playing', 'true')
  await story.locator('.intent').click()
  await expect(story).toHaveAttribute('data-playing', 'false')
  await story.locator('.intent').click()
  await expect(story).toHaveAttribute('data-playing', 'true')
  await page.locator('footer').scrollIntoViewIfNeeded()
  await expect(story).toHaveAttribute('data-playing', 'false')
  const example = await story.getAttribute('data-example')
  await page.clock.runFor(9600)
  await expect(story).toHaveAttribute('data-example', example ?? '')
})

for (const width of [320, 390, 768, 850, 851, 1024, 1440, 1920]) {
  test(`component fits the landing at ${width}px with local artwork and static reduced motion`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    const story = page.locator('#swap-story')
    await story.scrollIntoViewIfNeeded()
    await expect(story).toHaveAttribute('data-playing', 'false')
    await expect(story.locator('#receipt')).toHaveAttribute('opacity', '1.000')
    await expect(story.getByRole('heading', { name: 'From intent to settlement.' })).toBeVisible()
    await expect(page.locator('main h1')).toHaveCount(1)
    expect(await story.innerText()).not.toMatch(/Illustrative auction|Ethereum|Solana|Base/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const clipped = await story.locator('#playground').evaluate(svg => {
      const box = svg.getBoundingClientRect()
      return [...svg.querySelectorAll('#source-node,#portal,#destination-node,.venue,.solver')].some(node => {
        const r = node.getBoundingClientRect()
        return r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1
      })
    })
    expect(clipped).toBe(false)
    const gap = await story.evaluate(root => {
      const intent = root.querySelector('.intent')?.getBoundingClientRect()
      const heading = root.querySelector('#solver-heading')?.getBoundingClientRect()
      return intent && heading ? heading.top - intent.bottom : -1
    })
    expect(gap).toBeGreaterThanOrEqual(12)
    const ordered = await story.evaluate(root => {
      const axis = matchMedia('(max-width:850px)').matches ? 'top' : 'left'
      const position = (id: string): number => root.querySelector(`#${id}`)?.getBoundingClientRect()[axis] ?? Infinity
      return [0,1,2].every(i => position('source-node') < position(`venue-${i}`) && position(`venue-${i}`) < position(`solver-${i}`) && position(`solver-${i}`) < position('portal') && position('portal') < position('destination-node'))
    })
    expect(ordered).toBe(true)
    const artwork = await story.locator('image').evaluateAll(nodes => Promise.all(nodes.map(node => new Promise<boolean>(resolve => {
      const img = new Image()
      img.onload = () => resolve(img.naturalWidth > 0)
      img.onerror = () => resolve(false)
      img.src = node.getAttribute('href') ?? ''
    }))))
    expect(artwork.every(Boolean)).toBe(true)
    expect(errors).toEqual([])
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(story).toHaveAttribute('data-playing', 'true')
  })
}

test('network chips still swap the destination panel', async ({ page }) => {
  await page.goto('/')
  const panel = page.locator('#chainPanel')
  await page.locator('[data-chain="solana"]').click()
  await expect(panel.locator('#chainText')).toContainText('Solana address')
  await page.locator('[data-chain="ethereum"]').click()
  await expect(panel.locator('#chainTitle')).toContainText('same-chain settlement')
})

 test('static SVG remains coherent without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto('/')
  const story = page.locator('#swap-story')
  await expect(story).toBeVisible()
  await expect(story.locator('#portal')).toHaveAttribute('transform', 'translate(755,285) scale(1)')
  await expect(story.locator('#source-node')).toHaveAttribute('transform', 'translate(85,285) scale(0.7)')
  await expect(story.locator('#solver-0')).toHaveAttribute('transform', 'translate(485,160) scale(1)')
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(story.locator('.static-summary')).toBeVisible()
  await expect(story.locator('#playground')).toBeHidden()
  await context.close()
})
