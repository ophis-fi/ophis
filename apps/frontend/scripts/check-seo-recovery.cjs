// Run against the built app served by `wrangler pages dev`.
// node scripts/check-seo-recovery.cjs http://127.0.0.1:3017
const assert = require('node:assert/strict')
const { chromium, webkit } = require('playwright')
const base = process.argv[2] || 'http://127.0.0.1:3017'

;(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
    try {
      for (const width of [320, 390, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        await page.goto(base, { waitUntil: 'domcontentloaded' })
        const summary = page.getByRole('region', { name: 'About Ophis swaps' })
        await summary.waitFor({ timeout: 60000 })
        await summary.scrollIntoViewIfNeeded()
        assert.match(await summary.innerText(), /intent-based DEX aggregator/)
        assert.match(await summary.innerText(), /0\.01% base fee plus capped price-improvement capture/)
        assert.equal(await page.locator('#ophis-seo').count(), 0, 'app must finish mounting')
        for (const path of ['pricing', 'supported-chains', 'security', 'ai-agent-crypto-swap-api']) {
          assert.equal(await summary.locator(`a[href="https://ophis.fi/${path}/"]`).count(), 1)
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        assert.equal((await page.request.get(base + '/missing-seo-page')).status(), 404)
        const legacy = await page.request.get(base + '/4663/swap/USDC/ETH?amount=1', { maxRedirects: 0 })
        assert.equal(legacy.status(), 301)
        assert.equal(legacy.headers().location, base + '/#/4663/swap/USDC/ETH?amount=1')
        const llms = await (await page.request.get(base + '/llms.txt')).text()
        assert.ok(llms.includes('https://ophis.fi/openapi.json') && !llms.includes('/openapi.yaml'))
        console.log('PASS', engine.name(), width, 'persistent copy, links, overflow, routes, API discovery')
        await page.close()
      }
      const page = await browser.newPage({ javaScriptEnabled: false })
      await page.goto(base, { waitUntil: 'domcontentloaded' })
      assert.match(await page.locator('#ophis-seo').innerText(), /0\.01% base fee plus capped/)
      assert.ok(!(await page.locator('body').innerText()).includes('flat 0.01%'))
      await page.close()
    } finally {
      await browser.close()
    }
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
