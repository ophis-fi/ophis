// Run against the built app served by `wrangler pages dev`.
// node scripts/check-seo-recovery.cjs http://127.0.0.1:3017
const assert = require('node:assert/strict')
const { chromium, webkit } = require('playwright')
const base = process.argv[2] || 'http://127.0.0.1:3017'
const engines = process.argv[3] === 'chromium' ? [chromium] : [chromium, webkit]

async function checkStructuredData(page, path) {
  const response = await page.request.get(base + path)
  assert.equal(response.status(), 200)
  const html = await response.text()
  const nodes = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap(
    (match) => {
      const data = JSON.parse(match[1])
      return data['@graph'] || [data]
    },
  )
  const canonical = 'https://swap.ophis.fi' + path
  const document = nodes.find((node) => node['@type'] === 'WebPage')
  assert.equal(document?.url, canonical)
  assert.equal(document?.['@id'], canonical + '#webpage')
  assert.equal(document?.isPartOf?.['@id'], 'https://swap.ophis.fi/#website')
  assert.equal(document?.publisher?.['@id'], 'https://ophis.fi/#organization')
  if (path === '/') {
    const organization = nodes.find((node) => node['@type'] === 'Organization')
    assert.equal(organization?.['@id'], 'https://ophis.fi/#organization')
    assert.equal(organization?.url, 'https://ophis.fi/')
    const app = nodes.find((node) => node['@type'] === 'WebApplication')
    assert.equal(app?.['@id'], 'https://ophis.fi/#software')
    assert.equal(app?.publisher?.['@id'], organization['@id'])
    assert.equal(app?.url, canonical)
    assert.ok(nodes.some((node) => node['@type'] === 'WebSite' && node.url === canonical))
  }
  return html
}

;(async () => {
  for (const engine of engines) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
    try {
      for (const width of [320, 390, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: width < 400 ? 667 : 900 } })
        await page.goto(base, { waitUntil: 'domcontentloaded' })
        const summary = page.getByRole('region', { name: 'About Ophis swaps' })
        await summary.waitFor({ timeout: 60000 })
        await summary.scrollIntoViewIfNeeded()
        const disclosure = summary.locator('details')
        assert.equal(await disclosure.getAttribute('open'), null, 'guide starts collapsed')
        await disclosure.locator('summary').focus()
        await page.keyboard.press('Enter')
        assert.notEqual(await disclosure.getAttribute('open'), null, 'guide opens with keyboard')
        assert.match(await summary.innerText(), /intent-based DEX aggregator/)
        assert.match(await summary.innerText(), /0\.01% base fee plus capped price-improvement capture/)
        assert.match(await summary.innerText(), /Signing an order does not guarantee a fill/)
        assert.match(await summary.innerText(), /independent of Robinhood Markets/)
        const html = await checkStructuredData(page, '/')
        const fallbackParagraphs = await page.evaluate((html) => {
          const document = new DOMParser().parseFromString(html, 'text/html')
          return [...document.querySelectorAll('#ophis-seo p')].map((p) => p.textContent.replace(/\s+/g, ' ').trim())
        }, html)
        const guideParagraphs = (await disclosure.locator('p').allTextContents()).map((text) =>
          text.replace(/\s+/g, ' ').trim(),
        )
        assert.deepEqual(guideParagraphs, fallbackParagraphs, 'raw HTML and rendered guide explain the same product')
        await checkStructuredData(page, '/robinhood-chain/')
        assert.equal(await page.locator('#ophis-seo').count(), 0, 'app must finish mounting')
        for (const path of ['pricing', 'supported-chains', 'security', 'ai-agent-crypto-swap-api']) {
          assert.equal(await summary.locator(`a[href="https://ophis.fi/${path}/"]`).count(), 1)
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 60000 })
        assert.equal((await page.request.get(base + '/missing-seo-page')).status(), 404)
        const legacy = await page.request.get(base + '/4663/swap/USDC/ETH?amount=1', { maxRedirects: 0 })
        assert.equal(legacy.status(), 301)
        assert.equal(legacy.headers().location, base + '/#/4663/swap/USDC/ETH?amount=1')
        const llms = await (await page.request.get(base + '/llms.txt')).text()
        assert.ok(llms.includes('https://ophis.fi/openapi.json') && !llms.includes('/openapi.yaml'))
        const missing = await page.goto(base + '/missing-seo-page', { waitUntil: 'domcontentloaded' })
        assert.equal(missing.status(), 404, 'controlled navigation must preserve the network 404')
        assert.ok(await page.getByRole('heading', { name: 'Page not found' }).isVisible())
        console.log('PASS', engine.name(), width, 'persistent copy, links, overflow, routes, API discovery')
        await page.close()
      }
      const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 320, height: 667 } })
      await page.goto(base, { waitUntil: 'domcontentloaded' })
      assert.match(await page.locator('#ophis-seo').innerText(), /0\.01% base fee plus capped/)
      assert.match(await page.locator('#ophis-seo').innerText(), /Signing an order does not guarantee a fill/)
      assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1)
      assert.ok(await page.locator('#ophis-seo').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
      assert.ok(!(await page.locator('body').innerText()).includes('flat 0.01%'))
      await page.goto(base + '/robinhood-chain/', { waitUntil: 'domcontentloaded' })
      assert.ok(await page.getByRole('heading', { name: 'Swap on Robinhood Chain', exact: true }).isVisible())
      assert.equal(await page.locator('a[data-trade-cta]').first().getAttribute('href'), '/#/4663/swap')
      await page.close()
    } finally {
      await browser.close()
    }
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
