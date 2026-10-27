import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()
const url = process.env.RAILGUN_BROWSER_URL || 'http://127.0.0.1:4320'
const password = 'ephemeral-browser-test-password'
page.setDefaultTimeout(90_000)
async function idle(target) {
  await target.waitForFunction(() => !document.documentElement.dataset.busy)
}
async function unlock(target, value) {
  await target.locator('#password').fill(value)
  await target.locator('#unlock').click()
  await idle(target)
}
try {
  const response = await page.goto(url)
  assert.match(response.headers()['content-security-policy'], /frame-ancestors 'none'/)
  await page.locator('#generate').click()
  const phrase = await page.locator('#mnemonic').inputValue()
  assert.equal(phrase.split(' ').length, 12)
  await page.locator('#mnemonic').fill(phrase.split(' ').join('  \n'))
  await page.locator('#password').fill(password)
  await page.locator('#backup').check()
  await page.locator('#open').click()
  await idle(page)
  assert(await page.locator('#wallet').isVisible(), await page.locator('#error').innerText())
  assert.equal(await page.locator('#max-swap').innerText(), 'Max swap after fee')
  const address = await page.locator('#address').innerText()
  assert(address.startsWith('0zk'))
  assert.equal(await page.locator('#password').inputValue(), '')
  assert.equal(await page.locator('#mnemonic').inputValue(), '')
  await page.locator('#lock').click()
  await page.waitForLoadState('load')
  await unlock(page, 'incorrect-test-password')
  assert(!(await page.locator('#wallet').isVisible()))
  assert((await page.locator('#error').innerText()).length > 0)
  await unlock(page, password)
  assert.equal(await page.locator('#address').innerText(), address)
  const other = await context.newPage()
  await other.goto(url)
  await unlock(other, password)
  assert.match(await other.locator('#error').innerText(), /another tab/)
  await page.close()
  await unlock(other, password)
  assert.equal(await other.locator('#address').innerText(), address)
  console.log(
    'PASS: production build create, phrase whitespace, lock, wrong password, reload persistence, tab exclusion and retry',
  )
} finally {
  await context.close()
  await browser.close()
}
