import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// Static layout fixture only: no wallet, RPC, transaction or personal browser profile.
const root = fileURLToPath(new URL('..', import.meta.url))
const artifacts = process.env.RAILGUN_UI_ARTIFACTS || '/tmp/ophis-private-ui'
await mkdir(artifacts, { recursive: true, mode: 0o700 })
const [html, css, icon] = await Promise.all([
  readFile(join(root, 'index.html'), 'utf8'), readFile(join(root, 'src/style.css'), 'utf8'),
  readFile(join(root, 'public/incognito.svg')),
])
const browser = await chromium.launch({ headless: true })
const results = []
try {
  const page = await browser.newPage()
  const requests = []
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort() })
  const render = async (markup, style) => {
    await page.setContent(markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('src="./incognito.svg"', `src="data:image/svg+xml;base64,${icon.toString('base64')}"`))
    await page.addStyleTag({ content: style })
    await page.evaluate(() => {
      for (const id of ['setup', 'history-progress', 'balance-sync']) document.getElementById(id).hidden = true
      document.getElementById('wallet').hidden = false
      document.getElementById('ready-actions').disabled = false
      document.getElementById('status').textContent = ''
      document.getElementById('environment').textContent = 'Mainnet'
      document.getElementById('spendable-balance').textContent = '0 WETH'
    })
    return page.locator('#quote').boundingBox()
  }
  const baseline = path => execFileSync('git', ['show', `HEAD:apps/railgun/${path}`], { cwd: root, encoding: 'utf8' })
  await page.setViewportSize({ width: 470, height: 900 })
  const previous = await render(baseline('index.html'), baseline('src/style.css'))
  assert(previous, 'Previous primary action exists')
  for (const viewport of [{ width: 470, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport)
    const action = await render(html, css)
    assert(action && action.y + action.height < 480, 'Primary action fits above the fold with room for the host toolbar')
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal scrolling')
    assert.deepEqual(await page.locator('#private-network option').allTextContents(), [
      'Ethereum · ETH', 'Arbitrum · ETH', 'Polygon · POL', 'BNB Chain · BNB',
    ])
    for (const id of ['deposit-details', 'withdrawal', 'wallet-details', 'recovery']) {
      assert.equal(await page.locator(`#${id}`).getAttribute('open'), null)
    }
    const file = join(artifacts, `private-swap-${viewport.width}.png`)
    await page.locator('main').screenshot({ path: file })
    results.push({ viewport, primaryActionBottom: Math.round(action.y + action.height), screenshot: file })
    await page.locator('#withdraw-shortcut').evaluate(link => { link.href = '#recovery' })
    assert(await page.locator('#withdrawal > summary').isVisible(), 'Saved-transaction shortcut does not hide withdrawal access')
    await page.locator('#deposit-details').evaluate(panel => { panel.open = true })
    await page.locator('#withdrawal > summary').click()
    assert.equal(await page.locator('#deposit-details').getAttribute('open'), null, 'Funding and withdrawal panels do not compete')
    assert(await page.locator('#recipient').isVisible(), 'Withdrawal controls remain accessible')
    await page.locator('#ready-actions').evaluate(fieldset => { fieldset.disabled = true })
    assert(await page.locator('#quote').isDisabled(), 'History verification still gates spending')
    assert(await page.locator('#lock').isEnabled(), 'Wallet lock remains available while history is incomplete')
  }
  assert(previous.y + previous.height - results[0].primaryActionBottom > 250, 'Primary action moved substantially upward')
  assert.equal(requests.length, 0, 'Layout verification made no external requests')
  await writeFile(join(artifacts, 'layout-result.json'), JSON.stringify({
    passed: true, fixtureOnly: true, previousPrimaryActionBottom: Math.round(previous.y + previous.height), results,
  }, null, 2))
  console.log(JSON.stringify({ passed: true, previousPrimaryActionBottom: Math.round(previous.y + previous.height), results }))
} finally {
  await browser.close()
}
