// node scripts/check-steep-rebates.cjs --fixtures
// node scripts/check-steep-rebates.cjs https://rebates.ophis.fi
// Requires both repo workspace installs, Chrome, and (from apps/frontend):
// pnpm --filter @ophis/landing exec playwright install webkit
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
// Reuse the landing workspace's declared browser test dependency.
const { chromium, webkit } = createRequire(require.resolve('../apps/ophis-landing/package.json'))('@playwright/test')

const fixtures = process.argv.includes('--fixtures')
const base = fixtures ? 'http://rebates.test' : process.argv[2] || 'https://rebates.ophis.fi'
const wallet = '0x0000000000000000000000000000000000000001'
const artifacts = join(tmpdir(), 'ophis-steep-rebates')
mkdirSync(artifacts, { recursive: true })

function renderFixtures() {
  const app = resolve(__dirname, '../../rebate-indexer')
  return JSON.parse(
    execFileSync(
      join(app, 'node_modules/.bin/tsx'),
      [
        '--eval',
        `
    import { renderTierPage } from './src/tier-page.ts';
    import { renderStatsPage } from './src/stats-page.ts';
    import { TIERS } from './src/tiers.ts';
    const pages = Object.fromEntries(TIERS.map((tier, i) => ['/tier-' + tier.name,
      renderTierPage({ wallet: '${wallet}', volume_30d_usd: tier.min_usd,
        trade_count_30d: 1234567890, tier, next_tier: TIERS[i + 1] ?? null,
        usd_to_next_tier: (TIERS[i + 1]?.min_usd ?? tier.min_usd) - tier.min_usd },
        { nextCycleIso: '2026-10-01T00:00:00Z', lastBatcherRunAt: i ? '2026-09-01T00:00:00Z' : null })]));
    const stats = { totalVolumeUsd: 1234567890123, totalTrades: 1234567890,
      distinctTraders: 123456789, chainsActive: 13,
      byChain: [{ chainId: 4663, volumeUsd: 1234567890123, trades: 1234567890 }],
      generatedAt: '2026-09-09T12:00:00Z', dataAsOf: '2026-09-09T11:00:00Z',
      dataFresh: true, dataStatus: 'fresh', dataStaleReason: null };
    pages['/stats'] = renderStatsPage(stats);
    pages['/stats-typical'] = renderStatsPage({ ...stats, totalVolumeUsd: 153875, totalTrades: 167, distinctTraders: 37, chainsActive: 11 });
    pages['/stats-stale'] = renderStatsPage({ ...stats, dataFresh: false, dataStatus: 'degraded' });
    pages['/stats-empty'] = renderStatsPage({ ...stats, byChain: [], dataAsOf: null, dataFresh: false });
    console.log(JSON.stringify(pages));
  `,
      ],
      { cwd: app, encoding: 'utf8' },
    ),
  )
}

;(async () => {
  const pages = fixtures ? renderFixtures() : { '/stats': null, ['/tier/' + wallet]: null }
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
    try {
      for (const width of [320, 390, 440, 768, 960, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: 'dark' })
        try {
          if (fixtures)
            await context.route(base + '/**', (route) =>
              route.fulfill({
                contentType: 'text/html',
                body: pages[new URL(route.request().url()).pathname] || '',
                headers: {
                  'content-security-policy':
                    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
                },
              }),
            )
          const page = await context.newPage()
          for (const path of Object.keys(pages)) {
            const response = await page.goto(base + path)
            assert.equal(response.status(), 200, path)
            assert.equal(await page.locator('main').count(), 1, 'main landmark')
            const result = await page.evaluate(() => {
              const luminance = (rgb) =>
                rgb
                  .map((n) => n / 255)
                  .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
                  .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0)
              const rgb = (color) =>
                color
                  .match(/[\d.]+/g)
                  .slice(0, 3)
                  .map(Number)
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
              let minimumContrast = Infinity
              while (walker.nextNode()) {
                if (!walker.currentNode.textContent.trim()) continue
                const element = walker.currentNode.parentElement
                if (!element.getClientRects().length) continue
                const style = getComputedStyle(element)
                let parent = element,
                  background = 'rgba(0, 0, 0, 0)'
                while (parent && background === 'rgba(0, 0, 0, 0)') {
                  background = getComputedStyle(parent).backgroundColor
                  parent = parent.parentElement
                }
                const foreground = luminance(rgb(style.color)),
                  backdrop = luminance(rgb(background))
                minimumContrast = Math.min(
                  minimumContrast,
                  (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05),
                )
              }
              return {
                minimumContrast,
                overflow: document.documentElement.scrollWidth > innerWidth,
                background: getComputedStyle(document.body).backgroundColor,
                heading: getComputedStyle(document.querySelector('h1')).fontFamily,
                scheme: getComputedStyle(document.documentElement).colorScheme,
              }
            })
            assert.equal(result.background, 'rgb(255, 255, 255)', path + ' canvas')
            assert.equal(result.scheme, 'light', path + ' browser scheme')
            assert.match(result.heading, /Georgia/, path + ' heading')
            assert.equal(result.overflow, false, path + ' horizontal overflow')
            assert.ok(result.minimumContrast >= 4.5, path + ' text contrast ' + result.minimumContrast)
            if (path === '/stats-typical')
              assert.ok(
                await page
                  .locator('.card .n')
                  .evaluateAll((numbers) =>
                    numbers.every(
                      (number) =>
                        number.getBoundingClientRect().height <= parseFloat(getComputedStyle(number).lineHeight) + 1,
                    ),
                  ),
                'ordinary stats totals must stay on one line',
              )
            await page.keyboard.press('Tab')
            // WebKit follows macOS's links-in-tab-order preference; focus the link explicitly.
            await page.locator('a').first().focus()
            assert.ok(
              await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'),
              'keyboard focus',
            )
            if (width === 320 || width === 1440)
              await page.screenshot({
                path: join(artifacts, engine.name() + '-' + width + '-' + path.replaceAll('/', '_') + '.png'),
                fullPage: true,
              })
          }
          console.log(
            'PASS',
            engine.name(),
            width,
            Object.keys(pages).length,
            'rebate pages: layout, palette, contrast and keyboard focus',
          )
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
