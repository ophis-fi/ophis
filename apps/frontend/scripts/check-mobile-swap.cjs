// Run with Playwright installed: node scripts/check-mobile-swap.cjs http://127.0.0.1:3017
const assert = require('node:assert/strict')
const { chromium, webkit, devices } = require('playwright')
const base = process.argv[2] || 'http://127.0.0.1:3017'
const { mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const artifacts = join(tmpdir(), 'ophis-mobile-review')
mkdirSync(artifacts, { recursive: true })
const sizes = [
  [320, 568],
  [375, 667],
  [390, 844],
  [412, 732],
  [844, 390],
  [768, 1024],
  [1440, 900],
]
async function assertSwapLayout(page, { width, phone, empty = false }) {
  // CSS breakpoints update before React's media-query hook on viewport changes.
  await page.waitForFunction(
    () => [...document.querySelectorAll('h1')].filter((el) => el.getBoundingClientRect().width > 0).length === 1,
  )
  const geometry = await page.evaluate(() => {
    const box = (el) => {
      const rect = el.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: el.offsetHeight,
        minHeight: getComputedStyle(el).minHeight,
      }
    }
    const heading = [...document.querySelectorAll('h1')].filter((el) => el.getBoundingClientRect().width > 0)
    const header = document.querySelector('[data-testid="mobile-swap-header"]')
    return {
      viewport: innerWidth,
      scroll: document.documentElement.scrollWidth,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      header: box(header),
      nav: box(header.querySelector('nav')),
      navLinks: [...header.querySelectorAll('nav a')].map(box),
      headings: heading.map(box),
      panels: ['input', 'output'].map((side) => box(document.getElementById(side + '-currency-input'))),
    }
  })
  assert.equal(geometry.viewport, width, 'layout viewport expanded')
  assert.ok(geometry.scroll <= width + 1, 'page overflow')
  assert.equal(geometry.scheme, 'light', 'standalone swap must stay light at every viewport')
  assert.ok(geometry.header.width > 0, 'swap header missing')
  assert.equal(geometry.nav.width > 0, !phone, 'desktop navigation visibility disagrees with phone layout')
  assert.equal(geometry.headings.length, 1, 'swap must have exactly one visible heading')
  const panelHeight = phone ? 160 : 224
  for (const panel of geometry.panels) {
    assert.equal(panel.minHeight, panelHeight + 'px', 'incorrect responsive panel minimum height')
    assert.ok(panel.height >= panelHeight, 'swap panel collapsed')
    assert.ok(panel.x >= -1 && panel.x + panel.width <= width + 1, 'swap panel overflow')
    if (empty) assert.equal(panel.height, panelHeight, 'empty swap panel has unexpected height')
  }
  if (!phone) {
    for (let i = 1; i < geometry.navLinks.length; i++) {
      const previous = geometry.navLinks[i - 1]
      const current = geometry.navLinks[i]
      if (Math.abs(previous.y - current.y) < 4)
        assert.ok(current.x - previous.x - previous.width >= 12, 'header navigation links are cramped')
    }
    const [heading] = geometry.headings
    const [panel] = geometry.panels
    assert.ok(panel.width <= 560, 'desktop swap card exceeds its intended width')
    if (width > 960) {
      assert.ok(heading.x + heading.width <= panel.x, 'desktop introduction overlaps swap card')
    } else {
      assert.ok(heading.y + heading.height <= panel.y, 'tablet heading must stack above swap card')
    }
  }
}
async function check(engine, size, connected) {
  const [width, height] = size
  const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
  const phone = width <= 720 || height <= 500
  const page = await browser.newPage({
    ...(width < 1000 ? devices['iPhone 13'] : {}),
    viewport: { width, height },
    locale: 'en-US',
    colorScheme: 'light',
  })
  page.setDefaultTimeout(20000)
  await page.addInitScript(
    ({ connected }) => {
      localStorage.setItem('ophis_consent', 'denied')
      if (!connected) return
      const account = '0x000000000000000000000000000000000000dEaD'
      window.ethereum = {
        autoConnect: true,
        isMetaMask: true,
        isConnected: () => true,
        _metamask: { isUnlocked: async () => true },
        on: () => {},
        removeListener: () => {},
        request: async ({ method }) => {
          if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [account]
          if (method === 'eth_chainId') return '0x1'
          if (method === 'net_version') return '1'
          if (['eth_getBalance', 'eth_getTransactionCount'].includes(method)) return '0x0'
          if (method === 'eth_blockNumber') return '0x1700000'
          if (['eth_call', 'eth_getCode'].includes(method)) return '0x'
          throw Error('Read-only test wallet rejects ' + method)
        },
      }
    },
    { connected },
  )
  const label = engine.name() + '-' + width + 'x' + height + '-' + (connected ? 'wallet' : 'browser')
  try {
    console.log('CHECK', label)
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/#\/\d+\/swap/)
    assert.equal(await page.locator('[contenteditable=true]').count(), 0, 'root must open the swap directly')
    await page.locator('#input-currency-input').waitFor()
    if (connected) await page.locator('[class*=Web3StatusConnected]').waitFor()
    await assertSwapLayout(page, { width, phone })
    if (width === 375) {
      await page.locator('#web3-status-connected').click()
      const closeAccount = page.getByRole('button', { name: 'Close account' })
      await closeAccount.click()
      const dialogPage = await browser.newPage({
        ...devices['iPhone 13'],
        viewport: { width, height },
        locale: 'en-US',
      })
      await dialogPage.addInitScript(() => localStorage.setItem('ophis_consent', 'denied'))
      await dialogPage.goto(base + '/#/1/swap/_/_')
      await dialogPage.getByRole('button', { name: 'Connect Wallet', exact: true }).click()
      await dialogPage.locator('[data-reach-dialog-content]:visible').waitFor()
      await dialogPage.waitForFunction(() => {
        const dialog = document.querySelector('[data-reach-dialog-content]')
        const box = dialog?.getBoundingClientRect()
        return box && dialog.contains(document.elementFromPoint(box.x + box.width / 2, Math.max(1, box.y + 20)))
      })
      await dialogPage.screenshot({ timeout: 10000, path: join(artifacts, label + '-connect.png') })
      await dialogPage.close()
    }
    await page.screenshot({
      timeout: 10000,
      animations: 'disabled',
      scale: 'css',
      path: join(artifacts, label + '-swap.png'),
    })
    await page.locator('#open-settings-dialog-button').click()
    const settings = page.locator('[class*="MenuFlyout"]:visible').first()
    await settings.waitFor()
    const bounds = await settings.boundingBox()
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'settings overflow')
    if (phone) assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, 'settings outside viewport')
    const slippage = page.locator('#slippage-input')
    assert.ok((await slippage.boundingBox()).width >= 48, 'custom slippage input collapsed')
    await slippage.fill('0.4')
    assert.equal(Number(await slippage.inputValue()), 0.4)
    await page.screenshot({ timeout: 10000, animations: 'disabled', path: join(artifacts, label + '-settings.png') })
    await page.keyboard.press('Escape')
    await page.locator('[class*="SelectorControls"]').click()
    const network = page.getByRole('dialog').filter({ hasText: 'Select a network' })
    await network.waitFor()
    const box = await network.boundingBox()
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1, 'network overflow')
    if (width <= 960) {
      assert.ok(box.y >= -1 && box.y + box.height <= height + 1, 'network outside viewport')
      assert.ok(Math.abs(box.y + box.height - height) <= 1, 'obsolete bottom-bar gap')
    }
    if (width <= 960) await network.getByRole('button', { name: 'Close', exact: true }).click()
    else await page.locator('[class*="SelectorControls"]').click()
    await page.locator('#input-currency-input button').first().click()
    const search = page.getByPlaceholder('Search name or paste address...')
    await search.waitFor()
    assert.ok(Number.parseFloat(await search.evaluate((el) => getComputedStyle(el).fontSize)) >= 16, 'iOS input zoom')
    await search.fill('USDC')
    await page.screenshot({ timeout: 10000, animations: 'disabled', path: join(artifacts, label + '-tokens.png') })
    console.log('PASS', label)
  } catch (e) {
    await page
      .screenshot({ timeout: 10000, animations: 'disabled', path: join(artifacts, label + '-failure.png') })
      .catch(() => {})
    throw new Error(label + ': ' + e.message)
  } finally {
    await browser.close()
  }
}
async function checkDesign(engine) {
  const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  })
  try {
    await page.addInitScript(() => {
      localStorage.setItem('ophis_consent', 'denied')
      localStorage.setItem('redux_localstorage_simple_user', JSON.stringify({ userDarkMode: true }))
    })
    await page.goto(base + '/#/1/swap/_/_', { waitUntil: 'domcontentloaded' })
    await page.locator('#input-currency-input').waitFor()
    await page.waitForFunction(() => document.fonts.check('16px "Ophis Inter"'))
    assert.equal((await page.locator('h1:visible').innerText()).trim(), 'Swap with\nclarity.')
    await assertSwapLayout(page, { width: 390, phone: true, empty: true })
    const button = page.getByRole('button', { name: 'Connect Wallet', exact: true })
    const style = await button.evaluate((el) => ({
      radius: getComputedStyle(el).borderRadius,
      background: getComputedStyle(el).backgroundColor,
    }))
    assert.equal(style.radius, '9999px')
    assert.equal(style.background, 'rgb(23, 25, 28)')
    assert.equal(
      await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
      0,
      'reduced-motion animation still running',
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    await assertSwapLayout(page, { width: 1440, phone: false, empty: true })
    assert.equal(
      await page.locator('header nav a[aria-current="page"]').count(),
      1,
      'desktop swap nav has no active entry',
    )
    await page.setViewportSize({ width: 768, height: 1024 })
    await assertSwapLayout(page, { width: 768, phone: false, empty: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await assertSwapLayout(page, { width: 390, phone: true, empty: true })
    await page.locator('footer nav').getByRole('link', { name: 'Profile', exact: true }).click()
    await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark')
    console.log(
      'PASS',
      engine.name(),
      'responsive design, reduced motion, desktop geometry and saved-dark route restoration',
    )
  } finally {
    await browser.close()
  }
}
;(async () => {
  for (const engine of [chromium, webkit]) {
    if (!process.argv.includes('--design-only')) {
      for (const size of sizes.filter(([width]) => !process.argv.includes('--landscape-only') || width === 844))
        await check(engine, size, size[0] <= 412)
    }
    await checkDesign(engine)
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
