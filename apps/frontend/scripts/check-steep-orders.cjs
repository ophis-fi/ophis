// node scripts/check-steep-orders.cjs http://127.0.0.1:3017
// Install browsers: pnpm --filter @ophis/landing exec playwright install chromium webkit
// Uses a read-only test wallet; unlocks the UI without signing or submitting orders.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { chromium, webkit } = createRequire(require.resolve('../apps/ophis-landing/package.json'))('@playwright/test')
const base = process.argv[2] || 'http://127.0.0.1:3017'

async function checkTwapControls(page) {
  const input = page.locator('input[placeholder="10.0"]')
  const field = page.locator('[class*=TradeWidgetFieldBox]').filter({ has: input })
  await input.fill('10.1')
  await input.press('Tab')
  const increase = field.getByRole('button', { name: 'Increase Value', exact: true })
  const decrease = field.getByRole('button', { name: 'Decrease Value', exact: true })
  await increase.press('Enter')
  assert.equal(await input.inputValue(), '10.2')
  await decrease.press('Space')
  assert.equal(await input.inputValue(), '10.1')
  assert.equal(await decrease.evaluate((e) => getComputedStyle(e).outlineStyle), 'solid')
  await input.fill('99.99')
  await input.press('ArrowUp')
  assert.equal(await input.inputValue(), '99.99')
  await input.press('Tab')

  // Exercise quote widths without relying on a live market response.
  const prefix = field.locator('em')
  const original = await prefix.innerHTML()
  try {
    for (const price of ['2 225,0356 USDC', '12345678901234567890 LONGTOKENSYMBOL']) {
      await prefix.evaluate((e, price) => {
        e.textContent = price
      }, price)
      const layout = await field.evaluate((e) => {
        const box = e.getBoundingClientRect()
        const input = e.querySelector('input')
        const control = input.parentElement
        const quote = e.querySelector('em')
        return {
          overflow: e.scrollWidth > e.clientWidth + 1,
          clipped: [...e.querySelectorAll('input, button'), control, quote].some((child) => {
            const rect = child.getBoundingClientRect()
            return rect.left < box.left || rect.right > box.right || rect.bottom > box.bottom
          }),
          overlap: quote.getBoundingClientRect().right > control.getBoundingClientRect().left + 1,
          inputClipped: input.scrollWidth > input.clientWidth + 1,
        }
      })
      assert.deepEqual(layout, { overflow: false, clipped: false, overlap: false, inputClipped: false }, price)
    }
  } finally {
    await prefix.evaluate((e, original) => {
      e.innerHTML = original
    }, original)
  }
  await page.getByRole('button', { name: '1 Hour', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Custom', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const hours = dialog.locator('input').first()
  await hours.fill('12')
  await dialog.getByRole('button', { name: 'Increase Value', exact: true }).first().press('Enter')
  assert.equal(await hours.inputValue(), '13')
  assert.equal(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth + 1), false)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
}

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
      const profile = page.locator('[class*=OrdersPanel__SideBar]').getByRole('link', { name: 'Profile', exact: true })
      await page.keyboard.press('Tab')
      await profile.focus()
      assert.equal(await profile.evaluate((e) => getComputedStyle(e).outlineStyle), 'solid')
      await profile.press('Enter')
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
    if (width === 1440 && !dark) {
      await page.goto(base + '/#/1/swap', { waitUntil: 'domcontentloaded' })
      await page
        .getByRole('navigation', { name: 'Ophis', exact: true })
        .getByRole('link', { name: 'Limit', exact: true })
        .waitFor()
      assert.equal(await page.getByRole('button', { name: 'Trading mode', exact: true }).count(), 0)
    }
    for (const route of ['limit', 'advanced']) {
      await page.goto(base + '/#/1/' + route + '/WETH/USDC', { waitUntil: 'domcontentloaded' })
      await page.locator('[id^="unlock-"][id$="-btn"]').click()
      const otc = page.locator('header').getByRole('link', { name: 'Open OTC', exact: true })
      assert.ok((await otc.boundingBox()).height >= 44, 'OTC has a button-sized target')
      assert.equal(await otc.getAttribute('href'), '#/otc')
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
      if (route === 'advanced') {
        await page.getByText('Unsupported wallet detected', { exact: true }).waitFor()
        await checkTwapControls(page)
      }
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
      const disconnected = await browser.newContext({ viewport: { width: 320, height: 800 } })
      try {
        const page = await disconnected.newPage()
        await page.addInitScript(() => localStorage.setItem('ophis_consent', 'denied'))
        await page.goto(base + '/#/1/swap', { waitUntil: 'domcontentloaded' })
        await page
          .getByRole('navigation', { name: 'Ophis', exact: true })
          .getByRole('link', { name: 'Profile', exact: true })
          .click()
        await page.waitForURL(/profile/)
        console.log('PASS', engine.name(), 'disconnected mobile Profile navigation')
      } finally {
        await disconnected.close()
      }
      for (const dark of [false, true]) for (const width of [320, 390, 1440]) await check(browser, width, dark)
    } finally {
      await browser.close()
    }
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
