// node scripts/check-steep-orders.cjs http://127.0.0.1:3017
// Install browsers: pnpm --filter @ophis/landing exec playwright install chromium webkit
// Uses a read-only test wallet; unlocks the UI without signing or submitting orders.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { chromium, webkit } = createRequire(require.resolve('../apps/ophis-landing/package.json'))('@playwright/test')
const base = process.argv[2] || 'http://127.0.0.1:3017'

async function check(browser, width, dark) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    locale: 'en-US',
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(45000)
  try {
    await page.addInitScript((dark) => {
      localStorage.setItem('ophis_consent', 'denied')
      localStorage.setItem('redux_localstorage_simple_user', JSON.stringify({ userDarkMode: dark }))
      window.ethereum = {
        autoConnect: true,
        isMetaMask: true,
        isConnected: () => true,
        _metamask: { isUnlocked: async () => true },
        on: () => {},
        removeListener: () => {},
        request: async ({ method }) => {
          if (['eth_accounts', 'eth_requestAccounts'].includes(method))
            return ['0x000000000000000000000000000000000000dEaD']
          if (method === 'eth_chainId') return '0x1'
          if (method === 'net_version') return '1'
          if (['eth_getBalance', 'eth_getTransactionCount'].includes(method)) return '0x0'
          if (method === 'eth_blockNumber') return '0x1700000'
          if (['eth_call', 'eth_getCode'].includes(method)) return '0x'
          throw Error('Read-only test wallet rejects ' + method)
        },
      }
    }, dark)
    if (width === 320 && !dark) {
      await page.goto(base + '/#/1/swap', { waitUntil: 'domcontentloaded' })
      await page.locator('#web3-status-connected').click()
      await page.getByRole('link', { name: 'Profile', exact: true }).click()
      await page.waitForURL(/profile/)
      await page.goto(base + '/#/1/swap', { waitUntil: 'domcontentloaded' })
      const mode = page.getByRole('button', { name: 'Trading mode', exact: true })
      await mode.focus()
      await page.keyboard.press('Enter')
      await page.getByText('Trading mode', { exact: true }).waitFor()
      assert.equal(await mode.getAttribute('aria-expanded'), 'true')
      await page.getByRole('link', { name: 'Limit', exact: true }).last().click()
      await page.waitForURL(/limit/)
    }
    for (const route of ['limit', 'advanced']) {
      await page.goto(base + '/#/1/' + route + '/WETH/USDC', { waitUntil: 'domcontentloaded' })
      await page.locator('[id^="unlock-"][id$="-btn"]').click()
      const heading = page.getByRole('heading', { name: 'No open orders found', exact: true })
      await heading.waitFor()
      await page.waitForFunction(
        (dark) => getComputedStyle(document.documentElement).colorScheme === (dark ? 'dark' : 'light'),
        dark,
      )
      const grid = page.locator('[class*="PageWrapper"]').filter({ has: heading }).last()
      assert.ok((await grid.boundingBox()).width <= 1200, 'form and orders stay on the shared page grid')
      assert.match(await heading.evaluate((e) => getComputedStyle(e).fontFamily), /Georgia/)
      const artwork = page.locator('[class*=NoOrdersArtwork] svg')
      await artwork.waitFor()
      assert.ok((await artwork.boundingBox()).width <= 112)
      assert.equal(await artwork.locator('linearGradient').count(), 0)
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        clipped: [...document.querySelectorAll('input,select')].some((e) => {
          const bounds = e.getBoundingClientRect()
          return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1)
        }),
      }))
      assert.deepEqual(layout, { overflow: false, clipped: false }, route + ' layout at ' + width)
      const arrow = page.getByRole('button', { name: 'Switch tokens', exact: true })
      assert.equal(await arrow.evaluate((e) => getComputedStyle(e, '::after').backgroundImage), 'none')
      if (route === 'advanced') await page.getByText('Unsupported wallet detected', { exact: true }).waitFor()
      console.log('PASS', browser.browserType().name(), width, dark ? 'dark' : 'light', route)
    }
  } finally {
    await context.close()
  }
}

;(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const dark of [false, true]) for (const width of [320, 390, 1440]) await check(browser, width, dark)
    } finally {
      await browser.close()
    }
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
