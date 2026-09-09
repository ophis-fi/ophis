// node scripts/check-steep-states.cjs http://127.0.0.1:3017
// Vite dev server required for actual component imports. Mock rebate API only;
// no wallet connection, signature, transaction, claim, or external link navigation.
const assert = require('node:assert/strict')
const { chromium, webkit } = require('playwright')
const { mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const base = process.argv[2] || 'http://127.0.0.1:3017'
const artifacts = join(tmpdir(), 'ophis-steep-state-review')
const tiers = ['none', 'bronze', 'silver', 'gold', 'palladium', 'platinum']
mkdirSync(artifacts, { recursive: true })

async function contrast(locator) {
  return locator.evaluate((element) => {
    const rgba = (color) => color.match(/[\d.]+/g).map(Number)
    const composite = (front, back) =>
      front.slice(0, 3).map((v, i) => v * (front[3] ?? 1) + back[i] * (1 - (front[3] ?? 1)))
    const luminance = (rgb) =>
      rgb
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const ancestors = []
    for (let node = element; node; node = node.parentElement) ancestors.unshift(node)
    const background = ancestors.reduce(
      (back, node) => composite(rgba(getComputedStyle(node).backgroundColor), back),
      [255, 255, 255],
    )
    const style = getComputedStyle(element)
    const a = luminance(composite(rgba(style.color), background)),
      b = luminance(background)
    return { color: style.color, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
  })
}

async function check(page, dark, label) {
  await page.addInitScript(
    ({ dark }) => {
      localStorage.setItem('ophis_consent', 'denied')
      localStorage.setItem('redux_localstorage_simple_user', JSON.stringify({ userDarkMode: dark }))
      localStorage.removeItem('ophis.rebates.optIn')
    },
    { dark },
  )
  await page.route('**/tier/0x*', async (route) => {
    const wallet = new URL(route.request().url()).pathname.split('/').pop()
    const name = tiers[Number(wallet.slice(-1)) - 1]
    assert.ok(name, 'unexpected rebate wallet request')
    await route.fulfill({
      json: {
        wallet,
        volume_30d_usd: 0,
        trade_count_30d: 0,
        tier: { name, min_usd: 0, rebate_pct: 0 },
        next_tier: null,
        usd_to_next_tier: 0,
      },
    })
  })
  await page.goto(base + '/#/about', { waitUntil: 'domcontentloaded' })
  await page.locator('h1').first().waitFor()
  await page.waitForFunction(
    (expected) => getComputedStyle(document.documentElement).colorScheme === expected,
    dark ? 'dark' : 'light',
  )
  await page.evaluate(async (tiers) => {
    const source = await (await fetch('/src/ophis/components/TierChip.tsx')).text()
    const entry = await (await fetch('/src/cow-react/index.tsx')).text()
    const reactUrl = source.match(/from "([^"]*\/react\.js[^"]*)"/)[1]
    const domUrl = entry.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)[1]
    const [react, dom, theme, chips, tickets, account] = await Promise.all([
      import(reactUrl),
      import(domUrl),
      import('/src/theme/ThemeProvider.tsx'),
      import('/src/ophis/components/TierChip.tsx'),
      import('/src/pages/Rewards/WinningTicket.styled.ts'),
      import('/src/legacy/components/Header/AccountElement/styled.tsx'),
    ])
    const h = react.default.createElement
    document.getElementById('root').style.display = 'none'
    const host = document.createElement('main')
    host.id = 'state-review'
    host.style.cssText = 'max-width:620px;margin:24px auto;padding:16px;display:grid;gap:16px'
    document.body.append(host)
    ;(dom.createRoot || dom.default.createRoot)(host).render(
      h(
        theme.ThemeProvider,
        null,
        h('h1', null, 'Connected-state contrast fixtures'),
        ...tiers.map((tier, i) =>
          h(
            account.Wrapper,
            { key: tier, active: true, 'data-tier': tier, style: { padding: 12 } },
            h(chips.TierChip, { wallet: '0x' + String(i + 1).padStart(40, '0') }),
          ),
        ),
        h(
          tickets.WinningTicket,
          { 'data-ticket': 'winning' },
          h(
            tickets.TicketFooter,
            null,
            h(tickets.TicketError, { 'data-error': 'winning' }, 'Claim failed. Please try again.'),
          ),
        ),
        h(
          tickets.TicketEmpty,
          { 'data-ticket': 'empty' },
          h(tickets.TicketError, { 'data-error': 'empty' }, 'Unable to load tickets. Please try again.'),
        ),
      ),
    )
  }, tiers)
  const optIn = page.locator('[data-tier="none"] button')
  await optIn.waitFor()
  const ratios = []
  for (const hovered of [false, true]) {
    if (hovered) await optIn.hover()
    for (const selector of ['[class*=tierName]', '[class*=volume]']) {
      const result = await contrast(optIn.locator(selector))
      assert.ok(result.ratio >= 4.5, `opt-in ${selector} hover=${hovered}: ${JSON.stringify(result)}`)
      ratios.push(result.ratio)
    }
  }
  await optIn.focus()
  await page.keyboard.press('Enter')
  for (const tier of tiers) {
    const chip = page.locator(`[data-tier="${tier}"] a`)
    await chip.waitFor()
    assert.equal(await chip.getAttribute('aria-label'), `View ${tier === 'none' ? 'unranked' : tier} rebate rank`)
    for (const hovered of [false, true]) {
      await page.mouse.move(0, 0)
      if (hovered) await chip.hover()
      const result = await contrast(chip.locator('span'))
      assert.ok(result.ratio >= 4.5, `${tier} hover=${hovered}: ${JSON.stringify(result)}`)
      ratios.push(result.ratio)
    }
  }
  const winning = await contrast(page.locator('[data-error="winning"]'))
  const empty = await contrast(page.locator('[data-error="empty"]'))
  assert.equal(winning.color, 'rgb(156, 36, 53)', 'fixed peach ticket must use its own dark error color')
  for (const [name, result] of [
    ['winning', winning],
    ['empty', empty],
  ])
    assert.ok(result.ratio >= 4.5, `${name} error: ${JSON.stringify(result)}`)
  if (dark) assert.notEqual(empty.color, winning.color, 'fixed-ticket override leaked into dark empty ticket')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'fixture overflow',
    )
    assert.ok(await page.locator('[data-tier="platinum"] a').isVisible())
    await page.locator('#state-review').screenshot({ path: join(artifacts, `${label}-${width}.png`) })
  }
  console.log('PASS', label, JSON.stringify({ minimumChipContrast: Math.min(...ratios), winning, empty }))
}

;(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
    try {
      for (const dark of [true, false]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
        try {
          await check(await context.newPage(), dark, engine.name() + '-' + (dark ? 'dark' : 'light'))
        } finally {
          await context.close()
        }
      }
    } finally {
      await browser.close()
    }
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
