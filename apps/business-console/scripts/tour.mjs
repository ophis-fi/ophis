// "pnpm tour": a look at the console for one person with no security key. Local only, test data only.
// It starts the local server on a throwaway database (.wrangler/tour) with the stand-ins, opens the installed Google
// Chrome with Chrome's virtual security keys (DevTools protocol, as tests/e2e.mjs does) and signs three people in,
// each in a window of their own: the Owner of a partner, and the Owner and the Approver of an institution.
// Then the operator's own command reads the OFAC list file of the local stand-in ("sync": test data) and records a clear
// sanctions screening for both organisations (test files in tests/fixtures/), so that Compliance shows them.
// Then it waits: Ctrl+C, or closing Chrome, stops everything. TOUR_CHECK=1: no window; the Owner sends an order, the
// Approver approves it, Compliance shows the screening, and it ends. TOUR_CHECK=window: the same check with the windows.
import { execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { start as startDnsStubs } from './dns-stub.mjs'
import { start as startIndexer } from './indexer-stub.mjs'
import { start as startLists } from './list-stub.mjs'
import { start as startOrderbook } from './orderbook-stub.mjs'

process.chdir(new URL('..', import.meta.url).pathname)
const ORIGIN = 'http://localhost:8787'
const STATE = '.wrangler/tour'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHECK = process.env.TOUR_CHECK // '1' or 'window'
const HEADLESS = CHECK === '1'
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
const run = (command, args) => execFileSync(command, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const dev = (...args) => run('node', ['scripts/dev.mjs', ...args, '--persist', STATE])
const reachable = () => fetch('http://127.0.0.1:8787', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (await reachable()) {
  console.error('Port 8787 is in use. Stop the other local server first (Ctrl+C in its terminal), then run this again.')
  process.exit(1)
}
console.log('Starting the local server and three signed-in windows. This takes about one minute.')
rmSync(STATE, { recursive: true, force: true })
run('node_modules/.bin/wrangler', ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE])
// Each seed prints a one-time enrolment link (10 minutes), and completes .dev.vars for the stand-ins.
const [partnerSeed, institutionSeed] = [dev('seed', '--live'), dev('seed', '--demo')]
const stops = [startDnsStubs(), startIndexer(), startLists(), startOrderbook()]
// detached: the server gets its own process group, so the whole group is stopped at the end.
const server = spawn('node_modules/.bin/wrangler', ['dev', '--persist-to', STATE, '--port', '8787'], { env, detached: true, stdio: 'ignore' })
let browser
let stopping = false
async function stop(code) {
  if (stopping) return
  stopping = true
  await browser?.close().catch(() => undefined)
  const signal = (name) => {
    try {
      process.kill(-server.pid, name)
    } catch {
      // already gone
    }
  }
  signal('SIGTERM')
  for (let i = 0; i < 20 && (await reachable()); i++) await wait(250)
  if (await reachable()) signal('SIGKILL')
  for (const end of stops) end()
  process.exit(code)
}
process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))

try {
  for (let i = 0; i < 60 && !(await reachable()); i++) await wait(500)
  if (!(await reachable())) throw new Error('The local server did not start.')
  browser = await chromium.launch({ executablePath: CHROME, headless: HEADLESS })

  // A security key: USB, resident keys, user verification, device-bound. It answers every passkey check by itself.
  const KEY = { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
  // One person: a window of their own, with one security key plugged in.
  async function person() {
    const context = await browser.newContext(HEADLESS ? {} : { viewport: null })
    const page = await context.newPage()
    const devtools = await context.newCDPSession(page)
    await devtools.send('WebAuthn.enable')
    const { authenticatorId } = await devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
    return { page, devtools, authenticatorId }
  }
  const heading = (who, name) => who.page.getByRole('heading', { name }).first().waitFor()
  const read = async (who) => {
    const button = who.page.getByRole('button', { name: 'I have read this' })
    if (await button.count()) await button.click()
  }
  async function create(who, link) {
    await who.page.goto(link)
    await who.page.getByRole('button', { name: 'Create passkey' }).click()
    await heading(who, 'Your passkey waits for approval.')
  }
  async function signIn(who) {
    await who.page.goto(ORIGIN)
    await who.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    await heading(who, /in one view|People, wallets|Read this before you continue/)
    await read(who)
  }
  async function organisation(who) {
    await who.page.goto(`${ORIGIN}/#/organisation`)
    await who.page.reload()
    await heading(who, /People, wallets|Read this before you continue/)
    await read(who)
    await heading(who, 'People, wallets and two-person approval.')
  }
  // The second key of a seat: the first goes back in the drawer, a new one is plugged in.
  async function secondKey(who) {
    await who.devtools.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: who.authenticatorId })
    await who.devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
    await who.page.getByRole('button', { name: 'Add a passkey' }).click()
    await who.page.getByText('2: Security key 1, Security key 2').waitFor()
  }
  async function firstOwner(seedOutput) {
    const who = await person()
    await create(who, seedOutput.match(/http\S+\/#\/enrol\/\S+/)[0])
    dev('activate') // stands in for the activation of a first Owner
    await signIn(who)
    await organisation(who)
    await secondKey(who)
    return who
  }
  async function approverOf(owner) {
    await owner.page.getByRole('button', { name: 'Invite member' }).click()
    await owner.page.getByLabel('Name shown to colleagues').fill('Abe Approver')
    await owner.page.getByLabel('Role').selectOption('approver')
    await owner.page.getByRole('button', { name: 'Create the link' }).click()
    const link = await owner.page.getByLabel('Enrolment link').inputValue()
    await owner.page.getByRole('button', { name: 'Done' }).click()
    const who = await person()
    await create(who, link)
    await organisation(owner)
    await owner.page.getByRole('button', { name: 'Confirm with passkey' }).click()
    await owner.page.getByText('a 72 hour wait stands in for the second person').waitFor()
    dev('activate') // stands in for the 72 hours
    await signIn(who)
    await organisation(who)
    await secondKey(who)
    return who
  }
  const show = async (who, hash, title) => {
    await who.page.evaluate((to) => void (location.hash = to), hash)
    await who.page.evaluate((text) => void (document.title = text), title)
  }

  const partner = await firstOwner(partnerSeed)
  const owner = await firstOwner(institutionSeed)
  const approver = await approverOf(owner)
  // Sanctions screening, with the real operator command and test files: the read of the list file, then a clear screening of each organisation.
  const operator = (...args) => run('node', ['scripts/operator.mjs', ...args])
  // "sync" makes the Worker read the list stand-in, which lives in this process: the command must not block it (not execFileSync).
  const synced = await new Promise((resolve) => {
    let said = ''
    spawn('node', ['scripts/operator.mjs', 'sync'], { env, stdio: ['ignore', 'pipe', 'ignore'] }).on('close', () => resolve(said)).stdout.on('data', (chunk) => (said += chunk))
  })
  if (!synced.includes('Loaded 2 addresses')) throw new Error('The list file of the local stand-in was not loaded.')
  const organisations = [...operator('list').matchAll(/^([0-9a-f]{32}) {2}Northwind Vaults/gm)].map((match) => match[1])
  if (organisations.length !== 2) throw new Error('The operator\'s list did not name the two organisations.')
  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  for (const id of organisations) operator('screen', id, '--outcome', 'clear', '--list', 'eu=tests/fixtures/sanctions-eu.txt', '--list', 'un=tests/fixtures/sanctions-un.txt', '--next-review', nextYear, '--tier', 'standard', '--source', 'registry')
  await show(partner, '#/overview', '1 Partner, Owner')
  await partner.page.getByText('Figures from the Ophis rebate service, read at').waitFor()
  await partner.page.getByRole('heading', { name: 'Wallets that traded through your integration' }).waitFor()
  await partner.page.getByText('1 wallet on a sanctions list traded through your integration').waitFor() // a wallet of the stand-in is on the test OFAC file
  await show(owner, '#/desk', '2 Institution, Owner')
  await owner.page.getByRole('button', { name: 'Review order' }).waitFor()
  await show(approver, '#/organisation', '3 Institution, Approver')
  await heading(approver, 'People, wallets and two-person approval.')

  if (CHECK) {
    // The check walks the path the legend names, once: the Owner sends an order, the Approver approves it.
    await owner.page.locator('form.ticket').getByLabel('Amount to sell').fill('1')
    await owner.page.locator('form.ticket').getByRole('button', { name: 'Review order' }).click()
    await owner.page.locator('[data-step="review"]').getByRole('button', { name: 'Send for approval' }).click()
    await owner.page.getByText('Sent for approval.').waitFor()
    await organisation(approver)
    const card = approver.page.locator('article.appr', { hasText: 'Sell 1 WETH for at least' })
    await card.getByRole('button', { name: 'Review' }).click()
    await card.getByRole('button', { name: 'Approve' }).click()
    await card.waitFor({ state: 'detached' })
    for (const who of [partner, owner]) {
      await who.page.evaluate(() => void (location.hash = '#/compliance'))
      await who.page.getByText('Result: no match.').waitFor()
      await who.page.getByText('Not on a loaded list').waitFor()
    }
    console.log('Tour check passed: three people signed in, the Owner sent an order, the Approver approved it, and Compliance shows the screening of both organisations.')
    await stop(0)
  }
  console.log(`
Three windows are open, each signed in. Test data only.
  1 Partner, Owner         Overview: the partner fee and the wallets that traded, from the local stand-in of the rebate service;
                           one of them is on the test OFAC list, so a red alert names it.
  2 Institution, Owner     Desk: fill the ticket, "Review order" (a quote of the local stand-in orderbook), then send it for approval.
  3 Institution, Approver  Organisation, Approvals: approve or refuse that order.
Compliance, in windows 1 and 2: the sanctions screening the operator's command recorded, and the list it read.
Passkey checks in these three tabs answer by themselves (test keys). A new tab or window has no key.
Press Ctrl+C here, or quit that Chrome, to close the windows and stop the server.`)
  browser.on('disconnected', () => void stop(0))
} catch (error) {
  console.error(`The tour stopped: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
  await stop(1)
}
