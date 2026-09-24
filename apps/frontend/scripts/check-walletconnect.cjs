// Run with Chrome installed against a dev server or deployed app; no wallet approval or funds required.
// node scripts/check-walletconnect.cjs http://127.0.0.1:3000
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { chromium, devices } = createRequire(require.resolve('../apps/ophis-landing/package.json'))('@playwright/test')

const base = process.argv[2] || 'http://127.0.0.1:3000'

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    for (const device of ['desktop', 'mobile']) {
      const context = await browser.newContext(
        device === 'mobile' ? devices['iPhone 13'] : { viewport: { width: 1440, height: 1000 } },
      )
      const page = await context.newPage()
      page.setDefaultTimeout(30000)
      await page.goto(base + '/#/1/swap', { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Connect Wallet', exact: true }).waitFor()
      const decline = page.getByRole('button', { name: 'Decline', exact: true })
      if (await decline.isVisible()) await decline.click()

      for (const chainId of [1, 4663]) {
        await page.evaluate((chain) => {
          window.location.hash = `#/${chain}/swap`
        }, chainId)
        await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click()
        await page.getByRole('button', { name: 'Icon WalletConnect', exact: true }).click()
        const modal = page.locator('w3m-modal')
        const qr = modal.locator('wui-qr-code[uri^="wc:"]')
        const chooser = modal.getByRole('button', { name: /Trust Wallet/ })
        await (device === 'mobile' ? chooser : qr).waitFor({ state: 'visible' })
        const firstUri = device === 'desktop' ? await qr.getAttribute('uri') : undefined
        assert.equal(await modal.count(), 1, 'network changes must not add wallet modals')

        // Normal clicks deliberately detect an app overlay intercepting wallet controls.
        await modal.locator('w3m-header').getByRole('button').last().click()
        await page.getByRole('button', { name: 'Try Again', exact: true }).click()
        if (device === 'mobile') {
          await chooser.waitFor({ state: 'visible' })
        } else {
          await modal.locator(`wui-qr-code[uri^="wc:"]:not([uri=${JSON.stringify(firstUri)}])`).waitFor()
        }
        await modal.locator('w3m-header').getByRole('button').last().click()
        await page.getByRole('button', { name: 'Back to wallet selection', exact: true }).click()
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        console.log('PASS', device, chainId, 'pairing, cancel, retry, return to wallet selection')
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }
})().catch((error) => {
  // Locator errors can include pairing URIs. Never print those session secrets.
  console.error('FAIL WalletConnect browser check:', error.message.replace(/wc:[^\s"']+/g, '[redacted]'))
  process.exitCode = 1
})
