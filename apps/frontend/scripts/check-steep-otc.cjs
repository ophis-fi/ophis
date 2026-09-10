// node scripts/check-steep-otc.cjs http://127.0.0.1:3017
// Vite required. Renders the actual read-only view with verified-order fixtures.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { chromium, webkit } = createRequire(require.resolve('../apps/ophis-landing/package.json'))('@playwright/test')
const base = process.argv[2] || 'http://127.0.0.1:3017'

async function mountOrders(page) {
  await page.evaluate(async () => {
    const [source, entry, language] = await Promise.all(
      ['/src/pages/Otc/Otc.page.tsx', '/src/cow-react/index.tsx', '/src/lib/i18n.tsx'].map(async (path) =>
        (await fetch(path)).text(),
      ),
    )
    const dependency = (source, name) => source.match(new RegExp('from "([^"\\n]*/' + name + '\\.js[^"\\n]*)"'))[1]
    const [react, dom, lang, core, router, theme, view] = await Promise.all([
      import(dependency(source, 'react')),
      import(dependency(entry, 'react-dom_client')),
      import(dependency(language, '@lingui_react')),
      import(dependency(language, '@lingui_core')),
      import(dependency(source, 'react-router')),
      import('/src/theme/ThemeProvider.tsx'),
      import('/src/pages/Otc/Otc.page.tsx'),
    ])
    const account = '0x000000000000000000000000000000000000dEaD'
    const order = {
      orderId: 1n,
      maker: account,
      active: true,
      tokenA: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      amountA: 1000000000000000000n,
      tokenB: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountB: 2500000000n,
    }
    const state = {
      status: 'ready',
      degradedReason: null,
      indexLagBlocks: 0n,
      snapshot: {
        chainId: 1,
        blockNumber: 1000n,
        blockHash: '0x' + '11'.repeat(32),
        nextOrderId: 2n,
        orders: [order, { ...order, orderId: 0n, active: false }],
        truncated: false,
      },
      enrichment: { byOrderId: new Map(), indexedBlock: 1000n },
      reconciliation: {
        verifiedIds: [0n, 1n],
        mismatches: [],
        missingOnchain: [],
        notIndexed: [],
        unknownIds: [],
        activeLagIds: [],
      },
    }
    document.getElementById('root').style.display = 'none'
    const host = document.createElement('div')
    host.id = 'otc-fixture'
    document.body.append(host)
    const h = react.default.createElement
    ;(dom.createRoot || dom.default.createRoot)(host).render(
      h(
        theme.ThemeProvider,
        null,
        h(
          lang.I18nProvider,
          { i18n: core.i18n },
          h(router.MemoryRouter, null, h(view.OtcPageView, { state, account, nowMs: Date.now() })),
        ),
      ),
    )
  })
  await page.locator('#otc-fixture table').waitFor()
}

async function check(browser, width, dark) {
  const page = await browser.newPage({ locale: 'en-US', viewport: { width, height: 1000 } })
  try {
    await page.addInitScript((dark) => {
      localStorage.setItem('ophis_consent', 'denied')
      localStorage.setItem('redux_localstorage_simple_user', JSON.stringify({ userDarkMode: dark }))
    }, dark)
    await page.goto(base + '/#/otc', { waitUntil: 'domcontentloaded' })
    await page.locator('h1').waitFor()
    await mountOrders(page)
    for (const tab of ['Browse', 'My orders']) {
      await page.getByRole('button', { name: tab, exact: true }).click()
      await page.locator('#otc-fixture table').waitFor()
      // Off-screen table cells may scroll locally; their hidden labels must not widen the page.
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      if (tab === 'Browse') {
        await page.getByLabel('Filter by maker address').fill('0x0000')
        await page.getByRole('link', { name: 'Order 1 details' }).waitFor()
        await page.getByLabel('Filter by maker address').fill('')
      }
    }
    console.log('PASS', browser.browserType().name(), width, dark ? 'dark' : 'light', 'OTC tables and filters')
  } finally {
    await page.close()
  }
}

;(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
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
