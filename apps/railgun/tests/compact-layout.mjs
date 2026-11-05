import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const artifacts = await mkdtemp(join(tmpdir(), 'ophis-private-ui-'))
const built = await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
  build: { write: false, target: 'es2022', minify: false,
    lib: { entry: join(root, 'tests/layout.fixture.ts'), formats: ['es'], fileName: () => 'fixture.js' } } })
const output = (Array.isArray(built) ? built[0] : built).output
const resources = new Map(output.map(item => [`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source]))
resources.set('/incognito.svg', await readFile(join(root, 'public/incognito.svg')))
for (const name of ['chain-ethereum.png', 'chain-arbitrum.jpg', 'chain-polygon.png', 'chain-bnb.png',
  'token-weth.png', 'token-usdc.png', 'token-usdt.png']) {
  const bytes = await readFile(join(root, 'public/logos', name))
  assert.deepEqual(bytes, await readFile(join(root, '../frontend/apps/cowswap-frontend/public/logos', name)))
  resources.set(`/logos/${name}`, bytes)
}
const browser = await chromium.launch({ headless: true })
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (request.method !== 'GET' || !resources.has(path)) { response.writeHead(404); response.end(); return }
  const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.png') ? 'image/png'
    : path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html'
  response.writeHead(200, { 'Content-Type': type }); response.end(resources.get(path))
})
const results = [], requests = [], errors = []
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(10_000)
  const markup = await page.evaluate(html => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script').forEach(script => script.remove())
    return doc.documentElement.outerHTML
  }, await readFile(join(root, 'index.html'), 'utf8'))
  const style = await readFile(join(root, 'src/style.css'), 'utf8')
  resources.set('/', markup.replace('</head>', `<style>${style}</style></head>`)
    .replace('</body>', '<script type="module" src="/fixture.js"></script></body>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const request = route.request(); requests.push({ url: request.url(), method: request.method() })
    return request.url().startsWith(origin + '/') ? route.continue() : route.abort()
  })
  await page.goto(origin, { waitUntil: 'networkidle' })
  await expect(page.locator('#quote')).toBeVisible()
  assert.deepEqual(await page.locator('#private-network option').allTextContents(), ['Ethereum', 'Arbitrum', 'Polygon', 'BNB Chain'])
  await page.locator('#private-network-picker').click()
  await expect(page.locator('#asset-options img')).toHaveCount(4)
  await page.locator('#asset-search').fill('BNB')
  await expect(page.locator('#asset-options button')).toHaveCount(1)
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  await expect(page.locator('#private-network')).toHaveValue('56')
  await expect(page.locator('#private-network-picker')).toHaveText('BNB Chain⌄')
  await page.locator('#private-network-picker').click()
  await page.locator('#asset-options button').filter({ hasText: 'Ethereum' }).click()
  await page.locator('#token').evaluate(select => {
    window.selectionEvents = []
    for (const type of ['input', 'change']) select.addEventListener(type, () => window.selectionEvents.push(type))
  })
  await page.locator('#token-picker').click()
  await page.locator('#asset-options button').filter({ hasText: 'USDC' }).click()
  assert.deepEqual(await page.evaluate(() => window.selectionEvents), ['input', 'change'])
  await expect(page.locator('#token-picker')).toBeFocused()
  await page.locator('#token-picker').click(); await page.keyboard.press('Escape')
  await expect(page.locator('#token-picker')).toBeFocused()
  await page.locator('#token-picker').click()
  await page.locator('#asset-options button').filter({ hasText: 'WETH' }).click()
  await page.locator('#private-network').evaluate(select => { select.disabled = true })
  await expect(page.locator('#private-network-picker')).toBeDisabled()
  await page.locator('#private-network').evaluate(select => { select.disabled = false })
  await page.locator('#ready-actions').evaluate(fieldset => { fieldset.disabled = true })
  await expect(page.locator('#token-picker')).toBeDisabled(); await expect(page.locator('#quote')).toBeDisabled()
  await page.locator('#wallet-menu-button').click(); await expect(page.locator('#lock')).toBeEnabled()
  await page.keyboard.press('Escape')
  await page.locator('#ready-actions').evaluate(fieldset => { fieldset.disabled = false })
  await page.locator('#wallet-menu-button').click(); await page.locator('#withdraw-shortcut').click()
  await expect(page.locator('#recipient')).toBeVisible(); await expect(page.locator('#amount')).toBeVisible()
  await expect(page.locator('#buy-token-picker')).not.toBeVisible()
  await page.locator('#wallet-menu-button').click(); await page.locator('#deposit-shortcut').click()
  await expect(page.locator('#shield-amount')).toBeVisible()
  await page.locator('#deposit-connect').click(); await expect(page.locator('#walletconnect')).toBeVisible()
  await page.keyboard.press('Escape'); await expect(page.locator('#deposit-connect')).toBeFocused()
  await page.locator('#wallet-back').click()
  await page.evaluate(() => {
    document.getElementById('swap').hidden = false
    document.getElementById('quote-details').textContent = 'Illustrative fee review'
    window.ophisUiFixture.setSwapReview(true)
  })
  await expect(page.locator('#swap')).toBeVisible(); await expect(page.locator('#quote')).not.toBeVisible()
  await page.locator('#edit-swap').click(); await expect(page.locator('#quote')).toBeVisible()
  await page.evaluate(() => {
    window.ophisUiFixture.showSetup(false)
    document.getElementById('setup').hidden = false; document.getElementById('wallet').hidden = true
  })
  await expect(page.locator('#generate')).toBeVisible(); await expect(page.locator('#unlock')).not.toBeVisible()
  await page.evaluate(() => window.ophisUiFixture.showSetup(false, 'backup'))
  await expect(page.locator('#mnemonic')).toBeVisible(); await expect(page.locator('#backup')).toBeVisible()
  await page.evaluate(() => window.ophisUiFixture.showSetup(true))
  await expect(page.locator('#unlock')).toBeVisible(); await expect(page.locator('#generate')).not.toBeVisible()
  await page.evaluate(() => {
    document.getElementById('setup').hidden = true; document.getElementById('wallet').hidden = false
    window.ophisUiFixture.startFirstFunding(); window.ophisUiFixture.updateFirstFunding(true, false)
  })
  await expect(page.locator('#first-funding-guide')).toBeVisible()
  await page.evaluate(() => window.ophisUiFixture.updateFirstFunding(true, true))
  await expect(page.locator('#first-funding-guide')).not.toBeVisible(); await expect(page.locator('#quote')).toBeVisible()
  await page.evaluate(() => {
    document.getElementById('pending-details').textContent = 'Saved transaction · UI fixture only'
    window.ophisUiFixture.setPendingNotice(true)
  })
  await expect(page.locator('#pending-details')).toBeVisible(); await expect(page.locator('#pending-notice')).toBeVisible()
  await expect(page.locator('#recovery-index')).not.toBeVisible()
  await page.locator('#advanced-recovery > summary').click(); await expect(page.locator('#recovery-index')).toBeVisible()
  await page.evaluate(() => { window.ophisUiFixture.setPendingNotice(false); window.ophisUiFixture.showWalletView('swap') })
  await page.evaluate(() => {
    window.busyAction = window.ophisUiFixture.run(document.getElementById('quote'), 'Checking…',
      () => new Promise(resolve => { window.finishBusyAction = resolve }))
  })
  await expect(page.locator('#quote')).toBeDisabled(); await expect(page.locator('#token-picker')).toBeDisabled()
  await page.locator('#wallet-menu-button').click(); await expect(page.locator('#lock')).toBeEnabled()
  await page.locator('#deposit-shortcut').click(); await expect(page.locator('#wallet-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.evaluate(async () => { window.finishBusyAction(); await window.busyAction })
  await page.evaluate(() => {
    window.dialogAction = window.ophisUiFixture.run(document.getElementById('connect'), 'Connecting…',
      () => new Promise(resolve => { window.finishDialogAction = resolve }))
  })
  await expect(page.locator('#connect')).toBeDisabled()
  await page.evaluate(async () => { window.finishDialogAction(); await window.dialogAction })
  for (const viewport of [{ width: 470, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport)
    const action = await page.locator('#quote').boundingBox()
    assert(action && action.y + action.height < 480)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert(await page.locator('.asset-picker-button img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)))
    const file = join(artifacts, `private-swap-${viewport.width}.png`)
    await page.locator('main').screenshot({ path: file })
    results.push({ viewport, primaryActionBottom: Math.round(action.y + action.height), screenshot: file })
  }
  assert.deepEqual(errors, [])
  assert(requests.every(request => request.url.startsWith(origin + '/') && request.method === 'GET'))
  await writeFile(join(artifacts, 'layout-result.json'), JSON.stringify({ passed: true, fixtureOnly: true, results }, null, 2))
  console.log(JSON.stringify({ passed: true, fixtureOnly: true, results }))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
