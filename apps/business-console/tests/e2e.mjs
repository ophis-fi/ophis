// End-to-end proof in the installed Google Chrome, headless, with Chrome's virtual authenticators
// (DevTools protocol). Milestone 1: seed, enrol, activate, sign in, see the Organisation page, end the
// session. Milestone 2: the Owner adds a second key and invites a Viewer; the Viewer enrols in a second
// browser context with its own authenticator; the Owner confirms the new passkey with a passkey check; the Viewer
// signs in. Then the Viewer is re-enrolled from a third context, and the Viewer's old passkey stops that.
// Milestone 3: a second Owner and an Admin join (the Admin with the second Owner as second person), two people
// unfreeze the Viewer, the Admin asks for a role change, an Owner approves it, the audit page shows the rows and
// "Chain verified", and the export downloads.
// Milestone 4: an Owner asks to link a wallet; the wallet (a test key behind a fake injected provider, no network)
// signs on the signing page, which lives on its own hostname; the second Owner approves the link, then the wallet
// as recovery wallet; the Organisation page shows the readiness state to an Owner; unlinking the recovery wallet is refused.
// Milestone 4b: somebody asks for a recovery on the public page /recover and gets a signing link; the recovery wallet
// signs on the signing page; a member sees the banner and an Owner cancels; a second request waits (the local "skip"
// command stands in for the waits), is completed with the new passkey, and an old Owner passkey stops it; the
// recovery sheet prints alone.
// Milestone 6: the Owner opens Support, asks a question, reads a help text, presses "No" and gets the hand-over card.
// Milestone 5b: the declaration prints alone; a scan with a marker is sealed in the browser and uploaded; the stored
// object is sealed; the operator's command takes it for a reason, and the local test identity opens it: the original.
// Milestone 5a: an application, the activation by the recovery wallet, the review and the operator's approval.
// 2026-11-13: the application names a second person; after the approval the Owner gives that person a link and confirms
// the passkey, which is active at once (Ophis approved the person: no second person, no wait).
// Starts and stops its own local server on a throwaway database. Run: pnpm test:e2e
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite' // the sealed file, read back from the local D1's own SQLite file
import { Decrypter } from 'age-encryption' // milestone 5b: opens the downloaded file with the local test identity, as the operator would offline
import { chromium } from 'playwright-core'
import { mnemonicToAccount } from 'viem/accounts'
import { CONTRACT, PORT as INDEXER_PORT, start as startIndexer } from '../scripts/indexer-stub.mjs' // partner figures: the local stand-in for the rebate indexer
import { PORT as LIST_PORT, start as startLists } from '../scripts/list-stub.mjs' // M10: the local stand-in for the place where the OFAC list file lives
import { start as startTurnstile } from '../scripts/turnstile-stub.mjs' // the local stand-in for Cloudflare Turnstile
import { hear, verdict } from './operator-live.mjs' // the operator's command with --production, heard locally
import { PORT as ORDERBOOK_PORT, start as startOrderbook, TEST_BALANCES } from '../scripts/orderbook-stub.mjs' // the real desk: the local stand-in for the public orderbooks and the chains' endpoints
const ETHFLOW_OP = '0x764fE4aa1FF493cf39931c7923C8ff5837596504' // the EthFlow contract of OP Mainnet: an ETH sale's one transaction goes to it

process.chdir(fileURLToPath(new URL('..', import.meta.url))) // a path, not a URL: a space or a Windows drive survives (CodeRabbit, PR #1646)
const ORIGIN = 'http://localhost:8787'
const SIGN = 'http://127.0.0.1:8787' // the signing page's own hostname
const OPERATOR_SITE = 'http://operator.localhost:8787' // the operator's review page and API (2026-11-19)
const STATE = '.wrangler/e2e'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// E2E_PORT: where this run's server listens when 8787 is taken (a developer's own "pnpm dev"). The addresses stay the
// constants above: Chrome is told to reach them on that port, and the Worker decides by the Host header as always.
const PORT = process.env.E2E_PORT ?? '8787'
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', E2E_PORT: PORT }
const run = (command, args) => execFileSync(command, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const reachable = () => fetch(`http://127.0.0.1:${PORT}`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
const check = (what, ok) => {
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`ok  ${what}`)
}

if (await reachable()) throw new Error(`port ${PORT} is in use: stop the other server first, or set E2E_PORT`)
rmSync(STATE, { recursive: true, force: true })
mkdirSync('.shots', { recursive: true })
run('node_modules/.bin/wrangler', ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE])
const link = run('node', ['scripts/dev.mjs', 'seed', '--persist', STATE]).match(/http\S+\/#\/enrol\/\S+/)?.[0]
check('seed printed an enrolment link', Boolean(link))

const stopIndexer = startIndexer() // port 8793
const stopLists = startLists() // port 8794
const stopOrderbook = startOrderbook() // port 8795
const stopTurnstile = startTurnstile() // port 8796: the bot check of /recover
// detached: the server gets its own process group, so the whole group can be stopped at the end.
const serve = (...more) => spawn('node_modules/.bin/wrangler', ['dev', '--persist-to', STATE, '--port', PORT, ...more], { env, detached: true, stdio: 'ignore' })
const stopServer = async () => {
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    // already gone
  }
  for (let i = 0; i < 20 && (await reachable()); i++) await new Promise((resolve) => setTimeout(resolve, 250))
  if (await reachable()) {
    process.kill(-server.pid, 'SIGKILL')
    console.error('the server needed SIGKILL')
  }
}
let server = serve()
// A stand-in whose port is taken fails after the detached server started: its whole group is stopped, never left running (CodeRabbit, PR #1646).
process.on('uncaughtException', (error) => {
  try {
    process.kill(-server.pid, 'SIGKILL')
  } catch {
    // already gone
  }
  console.error(error)
  process.exit(1)
})
let browser
try {
  for (let i = 0; i < 60 && !(await reachable()); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  check('the local server answers', await reachable())

  // Sanctions screening: what the operator's command sends, heard by a server that only listens. A list file stays on this machine.
  const LIST = { eu: 'tests/fixtures/sanctions-eu.txt', un: 'tests/fixtures/sanctions-un.txt', addresses: 'tests/fixtures/sanctions-addresses.txt', xml: 'tests/fixtures/sdn-test.xml' }
  const fileSha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const heard = []
  const listener = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk)).on('end', () => {
      heard.push(`${request.method} ${request.url} ${body}`)
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"state":"active","list":"ofac","entries":2,"hits":[]}')
    })
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => listener.once('listening', resolve))
  const tell = (...args) => new Promise((resolve) => { // not execFileSync: this process must answer as the server meanwhile
    let said = ''
    spawn('node', ['scripts/operator.mjs', ...args], { env: { ...env, E2E_PORT: String(listener.address().port) }, stdio: ['ignore', 'ignore', 'pipe'] }).on('close', (code) => resolve(`${code} ${said}`)).stderr.on('data', (chunk) => (said += chunk))
  })
  const anId = 'ab'.repeat(16)
  const cut = `${STATE}/sdn-cut.xml` // a cut download of the official XML, its addresses all there: never loaded by hand either (CodeRabbit, PR #1646)
  writeFileSync(cut, readFileSync(LIST.xml, 'utf8').replace('</sdnList>', ''))
  const unsent = [await tell('addresses', 'ofac=tests/fixtures/sanctions-no-address.txt'), await tell('addresses', 'ofac=tests/fixtures/none.txt'), await tell('screen', anId, '--outcome', 'clear', '--list', `eu=${LIST.eu}`, '--list', `eu=${LIST.un}`, '--next-review', '2031-01-01'),
    // F5: what the server would refuse or drop is said by the command itself.
    await tell('screen', anId, '--outcome', 'clear', '--list', `un=${LIST.un}`, '--next-review', '2031-01-01'), await tell('screen', anId, '--outcome', 'ok', '--list', `eu=${LIST.eu}`, '--next-review', '2031-01-01'),
    await tell('decide', anId, 'more', '--reason', 'details_differ', '--tier', 'standard', '--source', 'registry', '--list', `eu=${LIST.eu}`), await tell('addresses', `ofac=${cut}`)]
  const sentByThose = heard.length
  await tell('screen', anId, '--outcome', 'review', '--list', `un=${LIST.un}`, '--list', `eu=${LIST.eu}`, '--next-review', '2031-01-01')
  await tell('decide', anId, 'approve', '--submission', '0'.repeat(16), '--tier', 'standard', '--source', 'registry', '--evidence', 'x', '--sha256', 'ab'.repeat(32), '--next-review', '2030-01-01', '--screening', 'clear', '--list', `eu=${LIST.eu}`)
  await tell('addresses', `ofac=${LIST.addresses}`)
  await tell('addresses', `ofac=${LIST.xml}`) // M10: an official XML carries its publish day
  listener.close() // before the checks: a failed check must end the run
  check('a list file that names no address, a file that is not there, a list code given twice and a cut official XML are refused by the command before anything is sent',
    sentByThose === 0 && unsent[0].startsWith('1 Refused: no address') && unsent[1].startsWith('1 Refused: the file could not be read') && unsent[2].startsWith('1 Refused: a list code is given twice')
    && unsent[3].startsWith('1 Refused: "screen" needs --list eu=<file>') && unsent[4].startsWith('1 Refused: "screen" needs --outcome clear, review or hit') && unsent[5].startsWith('1 Refused: --list needs --screening')
    && unsent[6].startsWith('1 Refused: the file does not end with </sdnList>'))
  check('the command sends the SHA-256 of each list file and, for "addresses", the addresses in it (lower case, each once, 40 hex characters exactly): nothing else of a file leaves this machine', JSON.stringify(heard.slice(sentByThose)) === JSON.stringify([
    `POST /api/operator/organisations/${anId}/screening ${JSON.stringify({ outcome: 'review', lists: { un: fileSha(LIST.un), eu: fileSha(LIST.eu) }, nextReview: '2031-01-01' })}`,
    `POST /api/operator/organisations/${anId}/decision ${JSON.stringify({ decision: 'approve', tier: 'standard', source: 'registry', evidenceRef: 'x', evidenceSha256: 'ab'.repeat(32), nextReview: '2030-01-01', submission: '0'.repeat(16), screening: { outcome: 'clear', lists: { eu: fileSha(LIST.eu) } } })}`,
    `POST /api/operator/sanctions ${JSON.stringify({ list: 'ofac', sha256: fileSha(LIST.addresses), addresses: ['0x00000000000000000000000000000000000a11ce', '0x0000000000000000000000000000000000000b0b'] })}`,
    `POST /api/operator/sanctions ${JSON.stringify({ list: 'ofac', sha256: fileSha(LIST.xml), addresses: ['0x0000000000000000000000000000000000000b0b', '0x00000000000000000000000000000000000000a1'], published: '2026-11-09' })}`, // in the order of the file; the maker sorts
  ]))
  // --production and "token --production": heard on this machine (tests/operator-live.mjs), nothing leaves it.
  for (const [what, ok] of verdict(await hear(`${process.cwd()}/${STATE}/live`))) check(what, ok)
  // M10: the maker of the list file, on the test XML (the real structure, invented values), and on files that are not whole.
  const made = `${STATE}/ofac.json`
  const maker = (from, out) => { try { return run('node', ['scripts/ofac-list.mjs', '--from', from, '--out', out]) } catch (error) { return `refused ${error.stderr}` } }
  const xml = readFileSync(LIST.xml, 'utf8')
  const broken = { 'not the list': xml.replaceAll('sdnList', 'sdnLost'), 'a cut download': xml.slice(0, xml.indexOf('</sdnList>')), 'no publish date': xml.replace(/<Publish_Date>.*<\/Publish_Date>/, ''), 'another count': xml.replace('<Record_Count>3<', '<Record_Count>4<'), 'no address': xml.replaceAll('0x0000', 'zz0000'),
    'two publish dates': xml.replace('</Publish_Date>', '</Publish_Date><Publish_Date>11/10/2026</Publish_Date>') }
  const refusals = Object.entries(broken).map(([what, text], i) => (writeFileSync(`${STATE}/bad-${i}.xml`, text), [what, maker(`${STATE}/bad-${i}.xml`, `${STATE}/bad-${i}.json`), existsSync(`${STATE}/bad-${i}.json`)]))
  const makerSaid = maker(LIST.xml, made)
  const madeAt = JSON.parse(readFileSync(made, 'utf8')).made // the time the maker ran: UTC, to the second
  check('the maker turns the test XML into the list file: the addresses sorted, the publish day, the time it was made, the SHA-256 of the XML; and refuses a file that is not whole or has two publish dates, writing nothing',
    makerSaid.startsWith(`Written: ${made}. 2 addresses, published 2026-11-09, made ${madeAt}`) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(madeAt) && Math.abs(Date.parse(madeAt) - Date.now()) < 60_000
    && readFileSync(made, 'utf8') === `${JSON.stringify({ list: 'ofac', source: 'sdn-test.xml', published: '2026-11-09', made: madeAt, sha256: fileSha(LIST.xml), count: 2, addresses: ['0x00000000000000000000000000000000000000a1', '0x0000000000000000000000000000000000000b0b'] }, null, 1)}\n`
    && refusals.every(([, said, written]) => said.startsWith('refused Refused: ') && said.includes('Nothing was written.') && !written)
    && ['no <sdnList', 'does not end with </sdnList>', 'no publish date', 'Record_Count says 4', 'no address', 'more than one publish date'].every((why, i) => refusals[i][1].includes(why)))

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: PORT === '8787' ? [] : [`--host-resolver-rules=MAP localhost:8787 127.0.0.1:${PORT}, MAP 127.0.0.1:8787 127.0.0.1:${PORT}, MAP operator.localhost:8787 127.0.0.1:${PORT}`] })
  const violations = []
  const foreign = []
  // A security key: USB, resident keys, user verification, not backup eligible (device-bound).
  const KEY = { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
  // One person: a browser context of their own, with one security key plugged in.
  async function person() {
    // reducedMotion: the kit then skips its entrance animation, so a screenshot never catches a half-faded page.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const devtools = await context.newCDPSession(page)
    await devtools.send('WebAuthn.enable')
    const { authenticatorId } = await devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
    page.on('console', (message) => /content security policy|trusted ?type/i.test(message.text()) && violations.push(message.text()))
    // /recover alone loads the bot check, here its local stand-in (scripts/turnstile-stub.mjs): no other page leaves the origin.
    page.on('request', (request) => request.url().startsWith(`${ORIGIN}/`) || (request.frame().url().startsWith(`${ORIGIN}/recover`) && request.url().startsWith('http://127.0.0.1:8796/turnstile/')) || foreign.push(request.url()))
    return { context, page, devtools, authenticatorId }
  }
  const FOOTER = 'Ophis © 2026'
  const { context, page, devtools, authenticatorId } = await person()
  const status = (path, on = page) => on.evaluate((url) => fetch(url).then((response) => response.status), path)
  const sessionCookie = async () => (await context.cookies()).find((c) => c.name === '__Host-session')

  const first = await page.goto(ORIGIN)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor()
  const headers = first.headers()
  check('the page carries the strict policy', ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"].every((part) => headers['content-security-policy']?.includes(part)))
  check('the page carries the other security headers', headers['x-content-type-options'] === 'nosniff' && headers['referrer-policy'] === 'no-referrer' && headers['cross-origin-resource-policy'] === 'same-origin' && headers['x-frame-options'] === 'DENY')
  check('the footer line is on the sign-in page', await page.locator(".foot-line", { hasText: FOOTER }).isVisible())
  check('the sign-in page has no username or password field', (await page.locator('input').count()) === 0)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: '.shots/01-signin.png' })

  // Owner, 2026-11-18: Ophis Business is for computers. A phone gets the message and no form on either page, and the API
  // of both hosts refuses it. An invitation link opened on a phone keeps its ticket, for a computer (Codex, PR #1665).
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
  const handset = await browser.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const small = await handset.newPage()
  const refused = (path) => small.evaluate((url) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (r) => r.status === 403 && (await r.json()).error === 'computer_only'), path)
  const ticketLink = `#/enrol/${'A'.repeat(43)}`
  const blocked = (on) => on.getByRole('heading', { name: 'The Ophis dashboard is only available from a computer.' }).waitFor({ timeout: 10000 }).then(() => true, () => false)
  await small.goto(ORIGIN)
  check('a phone is told the dashboard is only available from a computer, with no sign-in',
    await blocked(small) && (await small.getByRole('button', { name: 'Sign in with a passkey' }).count()) === 0
    && await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  // A page of its own: a fresh load, as from a message (a goto that changes only the fragment would not load the app again).
  const invited = await handset.newPage()
  await invited.goto(`${ORIGIN}/${ticketLink}`)
  check('a phone opening an invitation link gets no enrolment form, and the link stays whole, to open on a computer',
    await blocked(invited) && (await invited.getByRole('button', { name: 'Create passkey' }).count()) === 0 && (await invited.evaluate(() => location.hash)) === ticketLink)
  check('the API refuses a phone', await refused('/api/signin/start'))
  await small.screenshot({ path: '.shots/01-phone-computer-only.png' })
  await small.goto(`${SIGN}/sign/`)
  check('the signing page tells a phone it is only available from a computer, with no form, and its API refuses it',
    await small.getByRole('heading', { name: 'This page is only available from a computer.' }).waitFor({ timeout: 10000 }).then(() => true, () => false)
    && !(await small.locator('#paste').isVisible()) && await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    && await refused('/api/proof'))
  await small.screenshot({ path: '.shots/01-phone-signing-computer-only.png' })
  await handset.close()

  await page.goto(link)
  await page.getByRole('button', { name: 'Create passkey' }).waitFor()
  check('the ticket left the address bar', (await page.evaluate(() => location.hash)) === '#/enrol')
  check('the enrolment page names the organisation and the site', await page.getByText('Northwind Vaults').first().isVisible() && await page.locator('dd.site', { hasText: 'localhost:8787' }).isVisible())
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await page.getByRole('heading', { name: 'Your passkey waits for approval.' }).waitFor()
  check('a real browser enrolled a passkey, and the page says that the activate command confirms it: no colleague invited the first Owner', await page.getByText('Local build, first Owner: confirm with the activate command, then sign in.').isVisible() && (await page.getByText('The colleague who invited you').count()) === 0)

  await page.getByRole('link', { name: 'Go to sign-in' }).click()
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await page.getByText('Sign-in did not work.').waitFor()
  check('the pending passkey cannot sign in', (await status('/api/me')) === 401)

  check('the activate command confirmed one passkey', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  // Demo mode: an active organisation lands on Overview. The flows of the earlier milestones work on the Organisation page.
  const toOrganisation = async (on) => {
    await on.getByRole('heading', { name: /in one view|People, wallets and two-person approval/ }).waitFor()
    await on.evaluate(() => void (location.hash = '#/organisation'))
    await on.getByRole('heading', { name: 'People, wallets and two-person approval.' }).waitFor()
  }
  await page.getByRole('heading', { name: 'Your flow, in one view.' }).waitFor()
  check('after sign-in an active organisation lands on Overview: a partner with no linked wallet is told so, with no example and no demo banner, and the footer line',
    await page.getByText('No wallet is included in partner reporting.').isVisible() && !(await page.getByText('Demo data.').count()) && !(await page.locator('.stats').count()) && await page.locator(".foot-line", { hasText: FOOTER }).isVisible() && (await page.evaluate(() => location.hash)) !== '#/organisation')
  await toOrganisation(page)
  await page.getByRole('button', { name: 'End session' }).waitFor()
  check('the Organisation page shows the member, the passkey and the session',
    await page.getByRole('cell', { name: 'Maren Okafor' }).first().isVisible() && await page.getByText('1: Security key 1').isVisible() && await page.getByText('This session').isVisible())
  let cookie = await sessionCookie()
  check('the session cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/', Boolean(cookie) && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/' && cookie.domain === 'localhost')
  check('scripts cannot read the session cookie', !(await page.evaluate(() => document.cookie)).includes('session'))
  check('the footer line is on the Organisation page', await page.locator(".foot-line", { hasText: FOOTER }).isVisible())
  await page.screenshot({ path: '.shots/02-organisation.png', fullPage: true })

  // The security list is internal since 2026-11-17 (SECURITY-TODO.md): no link to it, and its old address shows the console's own page.
  check('no "Security and data" page or link', (await page.getByRole('link', { name: /Security/ }).count()) === 0)
  await page.goto(`${ORIGIN}/#/security`)
  await page.reload()
  check('the old address of the security page shows no such page', (await page.getByRole('heading', { name: 'What we store, and what we never hold.' }).count()) === 0)
  await page.getByRole('link', { name: 'Organisation' }).first().click()
  await page.getByRole('button', { name: 'End session' }).waitFor()
  check('the session survives a reload', (await status('/api/me')) === 200)

  // ---- milestone 2 ----
  const organisation = async (on = page) => {
    await on.goto(`${ORIGIN}/#/organisation`)
    await on.reload()
    await on.getByRole('heading', { name: /People, wallets|Read this before you continue/ }).waitFor()
  }
  // One screen at desk width and at phone width. True when the phone page does not scroll sideways.
  async function both(on, name, focus) {
    if (focus) await on.locator(focus).evaluate((element) => element.scrollIntoView())
    await on.screenshot({ path: `.shots/${name}.png` })
    await on.setViewportSize({ width: 390, height: 844 })
    await on.waitForTimeout(200) // let the narrow layout paint: a shot taken at once shows the old frame in part
    if (focus) await on.locator(focus).evaluate((element) => element.scrollIntoView())
    await on.screenshot({ path: `.shots/${name}-phone.png` })
    const fits = await on.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    // What does not fit, for whoever reads the failure: the innermost elements that reach past the right edge.
    if (!fits) console.log(`  wider than the phone (${name}): ${await on.evaluate(() => [...document.querySelectorAll('#root *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).slice(-3).map((e) => `${e.tagName.toLowerCase()}.${e.className}`).join(' | '))}`)
    await on.setViewportSize({ width: 1440, height: 900 })
    return fits
  }
  const readAlerts = async (text, on = page, shot = '') => {
    await on.getByRole('heading', { name: 'Read this before you continue.' }).waitFor()
    const shown = await on.getByText(text).isVisible() && (!shot || await both(on, shot))
    await on.getByRole('button', { name: 'I have read this' }).click()
    await toOrganisation(on)
    return shown
  }
  // The member's side, on their own device: open the link, create the passkey.
  async function enrolAt(link, who, label) {
    await who.page.goto(link)
    if (label) await who.page.getByLabel('Name for this key (no personal data)').fill(label)
    await who.page.getByRole('button', { name: 'Create passkey' }).click()
    await who.page.getByRole('heading', { name: 'Your passkey waits for approval.' }).waitFor()
  }
  // The Owner's side: the dialog's two steps. Returns the link, read from the page as the Owner would copy it.
  async function issue(open) {
    await open()
    await page.getByRole('button', { name: 'Create the link' }).click()
    const link = await page.getByLabel('Enrolment link').inputValue()
    await page.getByRole('button', { name: 'Copy the link' }).click()
    await page.getByRole('button', { name: 'Copied' }).waitFor()
    if (!(await both(page, '07-link-dialog'))) check('the link dialog fits a phone', false)
    await page.getByRole('button', { name: 'Done' }).click()
    return link
  }
  // The colleague's side: the card of that member, and a passkey check.
  const confirmAt = (name, on = page) => on.locator('article.appr', { hasText: name }).getByRole('button', { name: 'Confirm with passkey' }).click()

  check('an Owner with one key is asked for nothing more and may invite at once: one passkey is enough (owner, 2026-11-18)',
    (await page.getByText('Add a hardware key.').count()) === 0 && await page.getByRole('button', { name: 'Invite member' }).isVisible())
  // The only key plugged in already holds the seat's first passkey: the browser refuses (excludeCredentials), and the page
  // says why instead of "cancelled or timed out" (an Owner with a synced passkey hit this on every device, 2026-11-18).
  // /api/me is the action's last step (onChanged): once it is asked, the action is over and the next click is not ignored (CodeRabbit, PR #1665).
  const settled = page.waitForRequest((request) => request.url().endsWith('/api/me'))
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  check('adding a passkey on the key that holds the first says another one goes elsewhere',
    await page.getByText('already holds a passkey of your seat').waitFor({ timeout: 10000 }).then(() => true, () => false))
  await settled
  // The first key goes back in the drawer; a second security key is plugged in.
  await devtools.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
  await devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
  // Recovery readiness sits on this page: one Owner with one key is amber, not red. (It reads again after an action with
  // no page reload, Codex PR #1653: the failed read further down shows that.)
  check('the readiness block on Organisation: one Owner, and no recovery wallet yet', await page.locator('#readiness', { hasText: 'One Owner. If that person is locked out' }).waitFor({ timeout: 5000 }).then(() => true, () => false))
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  check('the Owner may still add a second hardware key', await page.getByText('2: Security key 1, Security key 2').waitFor({ timeout: 10000 }).then(() => true, () => false))

  // Invite a Viewer. The first try is answered "step-up required", as it would be 5 minutes after the last
  // passkey check: the app must run a real passkey check, get a new session token, and try again.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
  let asked = 0
  await page.route('**/api/tickets', (route) => (asked++ ? route.continue() : route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"step_up_required"}' })))
  const invitation = await issue(async () => {
    await page.getByRole('button', { name: 'Invite member' }).click()
    await page.getByLabel('Name shown to colleagues').fill('Ada Viewer')
    await page.getByLabel('Role').selectOption('viewer')
  })
  await page.unroute('**/api/tickets')
  const stepped = await sessionCookie()
  check('a step-up in a real browser gave the session a new token', asked === 2 && stepped.value !== cookie.value)
  check('the invitation link carries the ticket in the fragment only', /^http:\/\/localhost:8787\/#\/enrol\/[A-Za-z0-9_-]{43}$/.test(invitation) && (await page.evaluate(() => navigator.clipboard.readText())) === invitation)
  cookie = stepped

  const viewer = await person()
  await enrolAt(invitation, viewer)
  check('the Viewer enrolled on their own device and is told that the colleague who invited them now confirms the passkey, after checking with them',
    await viewer.page.getByText('The colleague who invited you now confirms it with a passkey check. They may first ask you, by a channel you both trust, whether you created it.').isVisible())
  check('the footer line is on the page after the passkey', await viewer.page.locator(".foot-line", { hasText: FOOTER }).isVisible())
  check('the page after the passkey fits a phone', await both(viewer.page, '03-passkey-stored'))

  await organisation()
  check('the Owner is told at the door that a passkey waits for confirmation', await readAlerts('A new passkey of Ada Viewer waits for you'))
  await page.getByRole('heading', { name: 'Waiting for confirmation' }).waitFor()
  const waiting = page.locator('article.appr', { hasText: 'Ada Viewer' })
  check('the Owner\'s card names the member, the role and when the passkey was created, and says to check with the member first',
    await waiting.getByText('Viewer, invitation').isVisible() && /Passkey created\s+\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ/.test(await waiting.innerText())
    && await waiting.getByText('Confirm only after you checked with Ada Viewer, by a channel you trust, that they created this passkey.').isVisible())
  await page.screenshot({ path: '.shots/04-waiting.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '.shots/08-waiting-phone.png', fullPage: true })
  check('at phone width the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.setViewportSize({ width: 1440, height: 900 })
  check('before the confirmation the Viewer cannot sign in', (await status('/api/me', viewer.page)) === 401)
  await confirmAt('Ada Viewer')
  await page.getByRole('button', { name: 'Re-enrol Ada Viewer' }).waitFor()
  check('the Owner confirmed: the Viewer is active', (await page.getByRole('heading', { name: 'Waiting for confirmation' }).count()) === 0)

  await viewer.page.getByRole('link', { name: 'Go to sign-in' }).click()
  await viewer.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await toOrganisation(viewer.page)
  await viewer.page.getByRole('button', { name: 'End session' }).waitFor()
  check('the Viewer signs in and sees only their own seat', (await viewer.page.getByRole('cell', { name: 'Maren Okafor' }).count()) === 0 && await viewer.page.getByRole('cell', { name: 'Ada Viewer' }).first().isVisible()
    && (await viewer.page.getByRole('button', { name: 'Invite member' }).count()) === 0)

  // Re-enrolment: someone with a third device gets the Viewer's seat a new passkey, and the Owner is talked into confirming it.
  const second = await issue(() => page.getByRole('button', { name: 'Re-enrol Ada Viewer' }).click())
  const replacement = await person()
  await replacement.page.goto(second)
  await replacement.page.getByRole('button', { name: 'Create passkey' }).click()
  await replacement.page.getByText('This seat already has a passkey with that name.').waitFor()
  check('a second passkey with the same name on one seat is refused', (await replacement.page.getByRole('heading', { name: 'Your passkey waits for approval.' }).count()) === 0)
  await enrolAt(second, replacement, 'Replacement key')
  await organisation()
  await readAlerts('A new passkey of Ada Viewer waits for you')
  await confirmAt('Ada Viewer')
  await page.getByText('Can stop its replacement until').waitFor()
  check('after the re-enrolment the old passkey is suspended, not deleted, and the old session is over',
    await page.getByText('Suspended').first().isVisible() && (await status('/api/me', viewer.page)) === 401)
  await replacement.page.getByRole('link', { name: 'Go to sign-in' }).click()
  await replacement.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  check('the new passkey signs in, and is told about the quarantine first, on a panel that fits a phone', await readAlerts('Your seat is in quarantine until', replacement.page, '09-alerts'))
  check('the quarantine banner is on the page behind, and fits a phone', await replacement.page.getByText('Your seat is in quarantine until').isVisible() && await both(replacement.page, '10-quarantine'))

  // The real Viewer comes back with the old passkey: no session, one action.
  await viewer.page.goto(ORIGIN)
  await viewer.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await viewer.page.getByRole('heading', { name: 'This passkey was replaced.' }).waitFor()
  check('a replaced passkey lands on the stop page with no session, and the footer line',
    (await status('/api/me', viewer.page)) === 401 && await viewer.page.locator(".foot-line", { hasText: FOOTER }).isVisible() && (await viewer.page.getByRole('button', { name: /Stop|Back/ }).count()) === 2)
  await viewer.page.screenshot({ path: '.shots/05-replaced.png' })
  await viewer.page.getByRole('button', { name: 'Stop this replacement' }).click()
  await viewer.page.getByText('Replacement stopped.').waitFor()
  check('the stop ended the session of the new passkey', (await status('/api/me', replacement.page)) === 401)
  await replacement.page.goto(ORIGIN)
  await replacement.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await replacement.page.getByText('Sign-in did not work.').waitFor()
  check('after the stop the new passkey opens no session', (await status('/api/me', replacement.page)) === 401)
  await organisation()
  check('the Owner is told at the door that the seat is frozen', await readAlerts('The seat of Ada Viewer is frozen'))
  await page.screenshot({ path: '.shots/06-after-stop.png', fullPage: true })
  await page.getByText('Frozen').waitFor()
  check('the Organisation page shows the frozen seat and the revoked passkey', await page.getByText('Revoked').first().isVisible() && (await page.getByRole('button', { name: /Re-enrol|New link/ }).count()) === 0)

  // ---- milestone 3 ----
  // The frozen member signs in with a passkey that was restored: a page that says who and when, and nothing else.
  await viewer.page.getByRole('button', { name: 'Back to sign-in' }).click()
  await viewer.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await viewer.page.getByRole('heading', { name: 'Your seat is frozen.' }).waitFor()
  check('a frozen member lands on a page that says how the seat was frozen, with one way out and no session',
    await viewer.page.getByText('A replaced passkey of this seat stopped its replacement on').isVisible() && (await viewer.page.getByRole('button', { name: /Stop|freeze|Sign in/i }).count()) === 0
    && (await status('/api/me', viewer.page)) === 401 && await viewer.page.locator(".foot-line", { hasText: FOOTER }).isVisible() && await both(viewer.page, '11-frozen'))
  await viewer.context.close()
  await replacement.context.close()

  // Sign in on a person's own device, read what is shown at the door, and arrive on the Organisation page.
  async function arrive(who, signIn = true) {
    if (signIn) {
      await who.page.goto(ORIGIN)
      await who.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    } else await organisation(who.page)
    await who.page.getByRole('heading', { name: /People, wallets|Read this before you continue|in one view/ }).waitFor()
    if (await who.page.getByRole('button', { name: 'I have read this' }).count()) await who.page.getByRole('button', { name: 'I have read this' }).click()
    await toOrganisation(who.page)
    await who.page.getByRole('button', { name: 'End session' }).first().waitFor()
  }
  // The second key of a seat: the first goes back in the drawer, a new one is plugged in.
  async function secondKey(who) {
    await who.devtools.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: who.authenticatorId })
    await who.devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
    // The key is stored when its finish answers 200 (Invite member shows before it: one key is enough, and a failed
    // registration also reloads /api/me, CodeRabbit PR #1667).
    const stored = who.page.waitForResponse((response) => response.url().endsWith('/api/passkeys/finish') && response.status() === 200)
    await who.page.getByRole('button', { name: 'Add a passkey' }).click()
    await stored
  }
  const invite = (name, role) => issue(async () => {
    await page.getByRole('button', { name: 'Invite member' }).click()
    await page.getByLabel('Name shown to colleagues').fill(name)
    await page.getByLabel('Role').selectOption(role)
  })
  const owner = { page }

  // A second Owner. The organisation has one key-role member, so a 72 hour wait stands in for the second person;
  // the local activate command stands in for the wait.
  const bo = await person()
  await enrolAt(await invite('Bo Owner', 'owner'), bo)
  await arrive(owner, false)
  await confirmAt('Bo Owner')
  await page.getByText('a 72 hour wait stands in for the second person').waitFor()
  check('with no other key-role member, the second Owner waits 72 hours', (await status('/api/me', bo.page)) === 401)
  check('the activate command stood in for the wait', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
  await arrive(bo)
  await secondKey(bo)

  // An Admin, through the full ceremony: the first Owner confirms, then the second Owner does.
  const cy = await person()
  await enrolAt(await invite('Cy Admin', 'admin'), cy)
  await arrive(owner, false)
  await confirmAt('Cy Admin')
  await page.getByText('Waiting for a second person with a key role').waitFor()
  check('after the first Owner\'s confirmation the Admin still cannot sign in', (await status('/api/me', cy.page)) === 401)
  await arrive(bo, false)
  await confirmAt('Cy Admin', bo.page)
  check('the second person is told at once that the member joined', await readAlerts('Cy Admin joined on a link issued on', bo.page))
  await bo.page.getByRole('button', { name: 'Re-enrol Cy Admin' }).waitFor()
  await arrive(cy)
  await secondKey(cy)
  check('the Admin joined with a second Owner as second person, and holds two keys', await cy.page.getByRole('button', { name: 'Manage Ada Viewer' }).isVisible())

  // Unfreeze the Viewer: one Owner asks, the other approves. The requester has no Approve button.
  await arrive(owner, false)
  await page.getByRole('button', { name: 'Manage Ada Viewer' }).click()
  await page.getByRole('heading', { name: 'Manage Ada Viewer' }).waitFor()
  check('each choice of the Manage dialog says what it does before its button, and fits a phone',
    await page.getByText('The passkeys that were active before the freeze work again').isVisible() && await page.getByText('This cannot be undone').isVisible() && await both(page, '13-manage'))
  await page.getByRole('button', { name: 'Request unfreeze' }).click()
  await page.getByRole('button', { name: 'Cancel request' }).waitFor()
  check('the request waits under Approvals, and its requester cannot approve it', await page.getByText('Requested by you').isVisible() && (await page.getByRole('button', { name: 'Approve' }).count()) === 0)
  await arrive(bo, false)
  await bo.page.getByRole('button', { name: 'Review' }).click()
  check('the second person sees what will change in plain words before approving', await bo.page.getByText('Unfreezes the seat of Ada Viewer (Viewer).').isVisible() && await bo.page.getByText('Requested by Maren Okafor (Owner)').first().isVisible() && await both(bo.page, '12-approvals'))
  await bo.page.getByRole('button', { name: 'Approve' }).click()
  await bo.page.getByRole('button', { name: 'Approve' }).first().waitFor({ state: 'detached' }) // the request left Approvals
  check('two people unfroze the seat', await bo.page.getByRole('row', { name: /Ada Viewer.*Active/ }).first().isVisible())

  // The Admin asks for a role change of the Viewer; an Owner approves it.
  await arrive(cy, false)
  await cy.page.getByRole('button', { name: 'Manage Ada Viewer' }).click()
  await cy.page.getByLabel('New role').selectOption('trader')
  await cy.page.getByRole('button', { name: 'Request role change' }).click()
  await cy.page.getByRole('button', { name: 'Cancel request' }).waitFor()
  check('an Admin cannot give the Owner role', (await cy.page.getByRole('button', { name: 'Manage Maren Okafor' }).count()) === 0)
  await arrive(owner, false)
  check('the Owner is shown the change in plain words', await page.getByText('Changes the role of Ada Viewer from Viewer to Trader.').isVisible() && await page.getByText('Requested by Cy Admin (Admin)').isVisible())
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.getByRole('button', { name: 'Approve' }).first().waitFor({ state: 'detached' }) // the request left Approvals
  check('the Owner approved it: the Viewer is a Trader', await page.getByRole('row', { name: /Ada Viewer.*Trader/ }).first().isVisible())

  // The audit log: rows in plain words, the chain state, and the export.
  await page.getByRole('link', { name: 'Compliance' }).first().click()
  await page.getByRole('heading', { name: 'Records and the audit trail.' }).waitFor()
  await page.getByText('Chain verified').waitFor()
  check('the audit page shows the rows in plain words and "Chain verified"',
    await page.getByRole('row', { name: /Bo Owner.*Role changed: Viewer to Trader.*Ada Viewer/ }).isVisible() || await page.getByRole('row', { name: /Maren Okafor.*Role changed: Viewer to Trader.*Ada Viewer/ }).isVisible())
  check('the request and the freeze are there too, and no raw code', await page.getByRole('row', { name: /Cy Admin.*Change requested: change a role.*Ada Viewer/ }).isVisible()
    && await page.getByRole('cell', { name: 'Seat unfrozen' }).isVisible() && !/session\.create|seat\.role|approval\./.test(await page.locator('main').innerText()))
  check('the audit page carries the footer line and fits a phone', await page.locator(".foot-line", { hasText: FOOTER }).isVisible() && await both(page, '14-audit'))
  const verified = async () => Number((await page.locator('p.chain').innerText()).match(/Rows 1 to (\d+) verified\. Newest verified row hash [0-9a-f]{10}\.\.\.[0-9a-f]{4}\./)?.[1])
  const verifiedBefore = await verified()
  check('the audit page says which rows it verified', verifiedBefore > 10)
  // The export comes in pages: the first answer is cut after 3 rows here, so the page must ask the server for the rest.
  await page.route('**/api/audit/export', async (route) => {
    if (route.request().postData() !== '{}') return route.continue()
    const response = await route.fetch({ headers: { ...(await route.request().allHeaders()), 'sec-fetch-site': 'same-origin' } }) // as the browser sent it
    if (!response.ok()) return route.fulfill({ response })
    const body = await response.json()
    await route.fulfill({ status: 200, json: { ...body, csv: body.csv.split('\r\n').slice(0, 4).map((l) => `${l}\r\n`).join(''), next: 3 } }) // not the response's headers: its length is the whole answer's
  })
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
  await page.unroute('**/api/audit/export')
  const csv = readFileSync(await download.path(), 'utf8')
  const numbers = csv.trim().split('\r\n').slice(1).map((l) => Number(l.slice(1, l.indexOf('"', 1))))
  check('the export downloads in pages as one file: every row in order with both hashes, the export itself last',
    /^ophis-audit-log-\d{4}-\d\d-\d\d\.csv$/.test(download.suggestedFilename()) && csv.startsWith('"No.","Time (UTC)","Who","Event","Target","Previous row hash","Row hash"\r\n')
    && numbers.length > 3 && numbers.every((n, i) => n === i + 1)
    && csv.includes('"Role changed: Viewer to Trader","Ada Viewer"') && /"Maren Okafor","Audit log exported","","[0-9a-f]{64}","[0-9a-f]{64}"\r\n$/.test(csv))
  await page.getByRole('cell', { name: 'Audit log exported' }).waitFor()
  check('the export is a row of the log, verified on the next load', await page.getByText('Chain verified').isVisible() && (await verified()) === numbers.length && numbers.length > verifiedBefore)
  await cy.page.goto(`${ORIGIN}/#/compliance`)
  await cy.page.getByText('The audit log is open to Owners, Compliance officers and Viewers.').waitFor()
  check('an Admin does not read the audit log', (await status('/api/audit', cy.page)) === 403)

  // ---- milestone 4: a wallet is linked by its own signature, then set as the recovery wallet, by two people ----
  // The wallet: the first public test key of anvil, held by a custodian as far as the console is told.
  const key = mnemonicToAccount('test test test test test test test test test test test junk')
  await arrive(owner, false)
  await page.getByRole('button', { name: 'Link a wallet' }).click()
  await page.getByLabel('Name in the console').fill('Custody wallet')
  await page.getByLabel('Address').fill(key.address)
  await page.getByLabel('Chain').selectOption({ label: 'OP Mainnet' })
  await page.getByLabel(/A custodian holds this wallet/).check()
  check('the link dialog says what the button does before the click', await page.getByText('This creates a signing link and stores nothing.').isVisible())
  await page.getByRole('button', { name: 'Create the signing link' }).click()
  const signingLink = await page.getByLabel('Signing link').inputValue()
  await page.getByRole('button', { name: 'Copy the link' }).click()
  await page.getByRole('button', { name: 'Copied' }).waitFor()
  check('the signing link is on the signing host, with the request in the fragment only, and the dialog says where to open it',
    /^http:\/\/127\.0\.0\.1:8787\/sign\/#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(signingLink) && await page.getByText('in the Safe interface open Apps').isVisible() && await both(page, '15-link-wallet'))
  await page.getByRole('button', { name: 'Done' }).click()
  check('nothing is stored before the wallet signs', await page.getByText('No wallet is linked.').isVisible())

  // The signing page, in the browser that holds the wallet: no session, no passkey, a fake injected provider.
  const holder = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const calls = []
  await holder.exposeFunction('walletCall', async (method, params) => {
    calls.push(method)
    return method === 'eth_requestAccounts' ? [key.address] : method === 'eth_signTypedData_v4' ? key.signTypedData(JSON.parse(params[1])) : null
  })
  await holder.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.walletCall(method, params) } })
  const signing = await holder.newPage()
  const elsewhere = []
  signing.on('console', (message) => /content security policy|refused to/i.test(message.text()) && violations.push(message.text()))
  signing.on('request', (request) => request.url().startsWith(`${SIGN}/`) || elsewhere.push(request.url()))
  const fonts = []
  signing.on('response', (response) => response.url().endsWith('.woff2') && response.ok() && fonts.push(response.url()))
  const opened = await signing.goto(signingLink)
  await signing.getByRole('heading', { name: 'What the wallet will sign' }).waitFor()
  const policy = opened.headers()['content-security-policy'] ?? ''
  check('the signing page carries its own policy, names only WalletConnect\'s relay and its Verify frame, and may be framed by the Safe interface only',
    policy === "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' wss://relay.walletconnect.org; frame-src https://verify.walletconnect.org; frame-ancestors https://app.safe.global https://*.safe.global" && !opened.headers()['x-frame-options'])
  await signing.evaluate(() => document.fonts.ready)
  check('the signing page shows the black logo of the console and the brand font, both from its own folder',
    await signing.evaluate(() => { const logo = document.querySelector('.brand img'); return logo.naturalWidth > 0 && new URL(logo.src).pathname.startsWith('/sign/assets/ophis-icon-mono-dark') })
      && await signing.evaluate(() => [...document.fonts].some((font) => font.family.includes('Ophis Inter') && font.status === 'loaded'))
      && fonts.length > 0 && fonts.every((url) => url.startsWith(`${SIGN}/sign/assets/Inter-`)))
  const shown = await signing.locator('#request dl.kv').innerText()
  check('it shows the action, the site, the organisation id, the chain, the wallet and the expiry as text',
    ['Link this wallet to this organisation', 'localhost', 'OP Mainnet (chain id 10)', key.address, 'UTC'].every((text) => shown.includes(text)) && /[0-9a-f]{32}/.test(shown))
  check('the signing page carries the footer line and fits a phone', await signing.locator(".foot-line", { hasText: FOOTER }).isVisible() && await both(signing, '16-signing-page'))
  const at = (url, on) => on.evaluate((target) => fetch(target).then((response) => response.status, () => 0), url)
  check('the signing host serves no console page and no console route, its own name opens the signing page; the console host serves no signing page',
    (await at('/index.html', signing)) === 404 && (await signing.evaluate(() => fetch('/').then((response) => new URL(response.url).pathname))) === '/sign/' && (await at('/api/me', signing)) === 404 && (await at('/assets/', signing)) === 404 && (await status('/sign/')) === 404 && (await status('/sign/manifest.json')) === 404)
  const manifest = await signing.evaluate(() => fetch('/sign/manifest.json').then(async (response) => ({ grant: response.headers.get('access-control-allow-origin'), ...(await response.json()) })))
  check('the manifest for the Safe interface is there, readable from any origin', manifest.grant === '*' && manifest.iconPath === 'icon.svg' && manifest.name.startsWith('Ophis Business'))
  check('no cookie of the console exists on the signing host', (await holder.cookies()).length === 0 && (await signing.evaluate(() => document.cookie)) === '')
  await signing.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
  await signing.getByText('The link now waits for a second person').waitFor()
  check('the wallet was asked for its account, the chain and one typed signature, and the result is stated in plain words',
    calls.join() === 'eth_requestAccounts,wallet_switchEthereumChain,eth_signTypedData_v4' && await both(signing, '17-signed'))
  await signing.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
  await signing.getByText('This request was already used.').waitFor()
  check('the same request does not work twice', true)
  check(`the signing page asked nothing of another origin (${elsewhere.length})`, elsewhere.length === 0)
  await holder.close()

  // The link waits for a second person. The requester cannot approve it; the second Owner does.
  await arrive(owner, false)
  check('the wallet is pending, in EIP-55 form, and its request waits under Approvals',
    await page.getByRole('row', { name: new RegExp(`Custody wallet.*${key.address}.*OP Mainnet.*Custodian wallet \\(declared, not checked by Ophis\\).*Pending`) }).isVisible() && await page.getByText('Requested by you').isVisible() && (await page.getByRole('button', { name: 'Approve' }).count()) === 0)
  await arrive(bo, false)
  await bo.page.getByRole('button', { name: 'Review' }).click()
  check('the second person reads what the link does, in plain words, before approving',
    await bo.page.getByText(`Links the wallet Custody wallet (${key.address} on OP Mainnet, Custodian wallet (declared, not checked by Ophis)) to the organisation.`).isVisible() && await both(bo.page, '18-approve-wallet'))
  await bo.page.getByRole('button', { name: 'Approve' }).click()
  await bo.page.getByRole('button', { name: 'Approve' }).first().waitFor({ state: 'detached' }) // the request left Approvals
  check('two people linked the wallet', await bo.page.getByRole('row', { name: /Custody wallet.*Linked/ }).isVisible())

  // The recovery wallet: one Owner asks, the other approves; in force 72 hours later.
  await arrive(owner, false)
  await page.getByRole('button', { name: 'Manage Custody wallet' }).click()
  await page.getByRole('heading', { name: 'Manage Custody wallet' }).waitFor()
  check('each choice for a wallet says what it does before its button, and fits a phone',
    await page.getByText('if every Owner is locked out, only this wallet can restore access').isVisible() && await page.getByText('The wallet itself is not touched.').isVisible() && await both(page, '19-manage-wallet'))
  await page.getByRole('button', { name: 'Request recovery wallet' }).click()
  await page.getByRole('button', { name: 'Cancel request' }).waitFor()
  await arrive(bo, false)
  check('the second person reads what the recovery wallet is before approving', await bo.page.getByText('It is in force 72 hours after the approval.').first().isVisible())
  await bo.page.getByRole('button', { name: 'Approve' }).click()
  await bo.page.getByRole('button', { name: 'Approve' }).first().waitFor({ state: 'detached' }) // the request left Approvals
  check('the wallet carries the "Recovery wallet" badge with the date it is in force, and an Owner can still cancel',
    await bo.page.getByRole('row', { name: /Custody wallet.*Linked.*Recovery wallet.*In force from \d{4}-\d\d-\d\d \d\d:\d\d UTC/ }).isVisible()
      && await bo.page.locator('#wallets .table-wrap').evaluate((wrap) => wrap.scrollWidth <= wrap.clientWidth) // at 1440 the whole row shows, Manage included
      && await both(bo.page, '20-wallets', '#wallets'))

  // The Organisation page, for an Owner: readiness, read on demand, at the end of the page.
  await arrive(owner, false)
  await page.goto(`${ORIGIN}/#/organisation`)
  await page.getByRole('heading', { name: 'Recovery readiness' }).waitFor()
  const readiness = await page.locator('#readiness').innerText()
  check('the Organisation page shows an Owner the readiness state: two Owners are Ready, and a recovery wallet that still waits is amber and says so',
    ['Ready', '2 Owners.', 'Amber', 'Custody wallet is in force from', 'Until then it does not count.'].every((text) => readiness.includes(text)) && await both(page, '21-readiness'))
  check('an Admin gets no readiness block', (await status('/api/readiness', cy.page)) === 403)
  // A read that fails clears the earlier answer and offers a retry: no old assessment is shown as current (CodeRabbit, PR #1653).
  await page.route('**/api/readiness', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }))
  await page.getByRole('button', { name: 'Invite member' }).click()
  await page.getByRole('button', { name: 'Close' }).last().click() // the page reads its state again, and readiness with it
  await page.locator('#readiness', { hasText: 'It could not be read just now' }).waitFor()
  check('a readiness read that fails shows no earlier answer, and offers Try again', !(await page.locator('#readiness').innerText()).includes('2 Owners.')
    && await page.locator('#readiness').getByRole('button', { name: 'Try again' }).isVisible())
  await page.unroute('**/api/readiness')
  await page.locator('#readiness').getByRole('button', { name: 'Try again' }).click()
  check('Try again reads it again', await page.locator('#readiness', { hasText: '2 Owners.' }).waitFor({ timeout: 5000 }).then(() => true, () => false))

  // Unlinking the recovery wallet is refused: by the page, and by the server when asked directly.
  await arrive(owner, false)
  await page.getByRole('button', { name: 'Manage Custody wallet' }).click()
  const walletId = await page.evaluate(() => fetch('/api/org').then((response) => response.json()).then((view) => view.wallets[0].id))
  const direct = await page.evaluate((id) => fetch(`/api/wallets/${id}/unlink`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (response) => [response.status, (await response.json()).error]), walletId)
  check('unlinking the recovery wallet is refused', await page.getByRole('button', { name: 'Unlink now' }).isDisabled() && await page.getByText('It cannot be unlinked.').isVisible() && direct.join() === '409,recovery_wallet')
  await page.getByRole('button', { name: 'Close' }).last().click()
  check('the wallet is still linked and still the recovery wallet', await page.getByRole('row', { name: /Custody wallet.*Linked.*Recovery wallet/ }).isVisible())

  // ---- milestone 4b: last-Owner recovery ----
  const skip = () => run('node', ['scripts/dev.mjs', 'skip', '--persist', STATE])
  const organisationId = await page.evaluate(() => fetch('/api/me').then((response) => response.json()).then((me) => me.organisation.id))
  const banner = (on) => on.getByRole('alert').filter({ hasText: 'Account recovery in progress.' })
  check('the skip command stood in for the 72 hours of the recovery wallet', skip().includes('Every wait'))
  // The wallet's holders: the test key behind a fake injected provider (no network), on the signing page.
  async function sign(signingLink, shot) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const asked = []
    await context.exposeFunction('walletCall', async (method, params) => {
      asked.push(method)
      return method === 'eth_requestAccounts' ? [key.address] : method === 'eth_chainId' ? '0xa' : method === 'eth_signTypedData_v4' ? key.signTypedData(JSON.parse(params[1])) : null
    })
    await context.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.walletCall(method, params) } })
    const on = await context.newPage()
    on.on('console', (message) => /content security policy|refused to/i.test(message.text()) && violations.push(message.text()))
    on.on('request', (request) => request.url().startsWith(`${SIGN}/`) || foreign.push(request.url()))
    await on.goto(signingLink)
    await on.getByRole('heading', { name: 'What the wallet will sign' }).waitFor()
    const before = await on.locator('main').innerText()
    const fits = !shot || await both(on, shot)
    const walletConnect = await on.getByRole('button', { name: 'Sign with WalletConnect' }).isVisible() // owner, 2026-11-18
    await on.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
    await on.getByRole('status').filter({ hasText: /Signed and checked|Refused/ }).waitFor()
    const after = await on.locator('main').innerText()
    if (shot) await both(on, `${shot}-done`)
    await context.close()
    return { before, after, asked: asked.join(), fits, walletConnect }
  }
  // The requester: somebody the console does not know, on the public page, with a new security key.
  async function ask(shot) {
    const who = await person()
    const opened = await who.page.goto(`${ORIGIN}/recover`)
    await who.page.getByRole('heading', { name: 'Start a recovery' }).waitFor()
    const open = opened.status() === 200 && (await who.context.cookies()).length === 0 && await who.page.locator(".foot-line", { hasText: FOOTER }).isVisible()
      && await who.page.getByText('Nothing is stored until the recovery wallet has signed.').isVisible() && (!shot || await both(who.page, shot))
    await who.page.getByText('Check that you are a person: the local stand-in passes it.').waitFor() // the bot check rendered, and solved
    await who.page.getByLabel('Organisation id, from the recovery sheet').fill(organisationId)
    await who.page.getByRole('button', { name: 'Create the passkey and the signing link' }).click()
    await who.page.getByRole('heading', { name: 'Give this link to the signers of the recovery wallet.' }).waitFor()
    return { ...who, open, link: await who.page.getByLabel(/^Signing link/).inputValue() }
  }
  const resume = async (who) => {
    await who.page.goto(`${ORIGIN}/recover`)
    await who.page.getByRole('button', { name: 'Continue with the new passkey' }).click()
  }
  const lost = await ask('22-recover')
  check('/recover is public: no session, the footer line, each button preceded by what it does, and it fits a phone', lost.open)
  check('the requester gets a link to the signing page, is told to send it by a channel the signers trust, and is not pointed at WalletConnect (the signing page offers none for the recovery wallet)',
    lost.link.startsWith(`${SIGN}/sign/#`) && await lost.page.getByText('Send it by a channel the signers trust, so that they know it comes from you.').isVisible()
      && (await lost.page.getByText(/WalletConnect/).count()) === 0 && await both(lost.page, '23-recover-link'))
  check('nothing is stored and no member sees anything before the wallet signs', !(await page.evaluate(() => fetch('/api/me').then((response) => response.json()).then((me) => me.alerts.some((alert) => alert.kind.startsWith('recovery'))))))
  const signed = await sign(lost.link, '24-recovery-signing')
  check('a recovery names no chain, so the signing page offers no WalletConnect: the browser wallet or the Safe fills it in', !signed.walletConnect)
  check('the signing page shows the Proof fields as text, says what to check, names no wallet before the wallet answers, and shows no words',
    ['Restore access to an organisation.', 'Replace all Owner passkeys of this organisation', 'localhost', organisationId, 'The wallet that signs', 'New passkey (hash)', 'Request number (nonce)',
      'Sign only if the request comes from your colleague by a channel you trust, and the organisation id matches the recovery sheet.'].every((text) => signed.before.includes(text)) && !/three words/i.test(signed.before) && signed.fits)
  check('the wallet gave its account and its chain, signed one typed message, and the page says in plain words that the request waits',
    signed.asked === 'eth_requestAccounts,eth_chainId,eth_signTypedData_v4' && [key.address, 'OP Mainnet (chain id 10)', 'The request now waits 72 hours'].every((text) => signed.after.includes(text)))

  // A member who is not an Owner: told at the door, then a banner on every page, with the one thing an Admin may do.
  await organisation(cy.page)
  check('a member is told at sign-in what is happening, until when, and who can cancel',
    await readAlerts('An account recovery is open. Read the notice above this panel', cy.page) && await banner(cy.page).getByText('The recovery wallet asked to replace all Owner passkeys').isVisible() && await banner(cy.page).getByText('Any Owner can cancel it after a passkey check').isVisible()
      && /Nothing changes before \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(await banner(cy.page).innerText()))
  await cy.page.getByRole('cell', { name: 'Cy Admin' }).first().waitFor()
  check('an Admin may object, and the banner says what that does before the button; it fits a phone',
    await banner(cy.page).getByText('Object adds 72 hours to the wait.').isVisible() && await banner(cy.page).getByRole('button', { name: 'Object: add 72 hours' }).isVisible()
      && (await banner(cy.page).getByRole('button', { name: 'Cancel this recovery' }).count()) === 0 && await both(cy.page, '25-recovery-banner', '.band'))
  // An Owner cancels.
  await organisation()
  await readAlerts('An account recovery is open. Read the notice above this panel')
  check('an Owner sees the banner with what a cancel does', await banner(page).getByText('Cancel ends the request at once').isVisible())
  await banner(page).getByRole('button', { name: 'Cancel this recovery' }).click()
  check('the Owner cancelled the recovery after a passkey check, and every member is told', await readAlerts('An account recovery was cancelled on') && (await banner(page).count()) === 0)
  await resume(lost)
  await lost.page.getByText('That did not work. Use the passkey you created for this recovery.').waitFor()
  check('the cancelled request cannot be continued', (await status('/api/me', lost.page)) === 401)
  await lost.context.close()

  // A second request, 24 hours later. It waits 72 hours, is completed with the new passkey, and an old Owner passkey stops it.
  const early = await sign((await ask()).link)
  check('within 24 hours of a cancel the recovery wallet opens nothing', early.after.includes('Refused.'))
  skip()
  const found = await ask()
  check('24 hours after the cancel a new request opens', (await sign(found.link)).after.includes('The request now waits 72 hours'))
  await resume(found)
  await found.page.getByText('The wait is not over. Come back after').waitFor()
  check('before the 72 hours are over the new passkey completes nothing', (await status('/api/me', found.page)) === 401)
  skip()
  await resume(found)
  check('after the wait the new passkey completes the recovery and is told about the quarantine first', await readAlerts('The organisation is in quarantine until', found.page))
  await found.page.getByRole('cell', { name: 'Recovery Owner' }).first().waitFor()
  check('the new Owner is signed in, the organisation is in quarantine, and the old Owner sessions are over',
    await found.page.getByRole('cell', { name: 'Recovery Owner' }).first().isVisible() && await found.page.getByText('The recovery wallet replaced all Owner passkeys.').isVisible()
      && (await status('/api/me')) === 401 && (await status('/api/me', bo.page)) === 401 && (await status('/api/me', cy.page)) === 200 && await both(found.page, '26-recovered'))
  // The first Owner comes back with a replaced passkey: no session, one action.
  await page.goto(ORIGIN)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await page.getByRole('heading', { name: 'This passkey was replaced.' }).waitFor()
  check('a replaced Owner passkey opens no session and reads what stopping the recovery does, before the button',
    (await status('/api/me')) === 401 && await page.getByText('It removes the new Owner and makes the Owner passkeys valid again.').isVisible() && await both(page, '27-recovery-stop'))
  await page.getByRole('button', { name: 'Stop this account recovery' }).click()
  await page.getByText('Account recovery stopped.').waitFor()
  check('the stop ended the session of the new Owner', (await status('/api/me', found.page)) === 401)
  await found.context.close()
  await page.getByRole('button', { name: 'Back to sign-in' }).click()
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  check('the old Owner signs in again and is told what happened', await readAlerts('An account recovery was completed on'))
  await page.getByRole('row', { name: /Recovery Owner/ }).first().waitFor()
  check('the organisation is out of quarantine and the new Owner seat is removed',
    (await page.getByText('The organisation is in quarantine until').count()) === 0 && await page.getByRole('row', { name: /Recovery Owner.*Removed/ }).first().isVisible())

  // The recovery sheet, for an Owner: on the Organisation page, and alone on paper.
  await page.goto(`${ORIGIN}/#/organisation`)
  await page.getByRole('heading', { name: 'Recovery sheet', exact: true }).waitFor()
  const sheet = await page.locator('.sheet').innerText()
  check('the recovery sheet names the console, the organisation id, the recovery wallet and its chain, the signing page, and three ways back in five lines each; it holds no secret',
    ['localhost:8787', organisationId, key.address, 'OP Mainnet', `${SIGN}/sign/`, 'localhost:8787/recover', 'This sheet holds no secret'].every((text) => sheet.includes(text))
      && (await page.locator('.sheet ol').count()) === 3 && (await page.locator('.sheet ol li').count()) === 15)
  check('the readiness block says that last-Owner recovery is in place, and fits a phone', (await page.locator('#readiness').innerText()).includes('Last-Owner recovery') && await both(page, '28-recovery-sheet', '.sheet'))
  await page.emulateMedia({ media: 'print' })
  check('printed, the sheet stands alone: no band, bar, rail or other section',
    await page.locator('.sheet').isVisible() && await page.getByRole('button', { name: 'Print the recovery sheet' }).isHidden() && await page.locator('.bar').isHidden() && await page.locator('.band').isHidden() && await page.getByRole('heading', { name: 'Recovery readiness' }).isHidden())
  await page.screenshot({ path: '.shots/29-recovery-sheet-print.png', fullPage: true })
  await page.emulateMedia({ media: 'screen' })

  await bo.context.close()
  await cy.context.close()
  await arrive(owner, false)
  const rolesOnOrganisation = await page.getByText('What each role can do').count() // moved to Support on 2026-11-13: none

  // Milestone 6: Support. A question, the help text the server selected, "No" until the hand-over card. With no
  // TYPESAFE_API_KEY in .dev.vars the server answers the hand-over at once, and only that path is checked.
  // With the key this part needs the network: the Worker asks the provider, the browser never does.
  const withKey = /^TYPESAFE_API_KEY=.+/m.test(readFileSync('.dev.vars', 'utf8'))
  await page.locator('.rail').getByRole('link', { name: 'Support' }).click()
  await page.getByRole('heading', { name: /Ask a question/ }).waitFor()
  check('the band at the top reads "Local build. Test data only." and nothing else', (await page.locator('.band').innerText()).trim() === 'Local build. Test data only.')
  check('Support opens from the rail and from the top button, with the footer line and no provider notice (owner, 2026-11-19)',
    (await page.locator('[data-support]').getAttribute('href')) === '/#/support' && await page.locator(".foot-line", { hasText: FOOTER }).isVisible()
    && !(await page.getByText(/TypeSafe|Leave out names and anything secret/).count()))
  const write = page.getByRole('link', { name: 'Write to Ophis' })
  // A wallet recovery phrase (a public test vector) is refused by the server and the page says so; nothing is asked of the provider.
  await page.getByLabel('Your question').fill('legal winner thank year wave sausage worth useful legal winner thank yellow')
  await page.getByRole('button', { name: 'Ask' }).click()
  check('a recovery phrase typed into the box is refused, and the page says that it was not passed on',
    await page.getByText('This looks like a wallet recovery phrase (seed phrase): 12 or more of its words in a row. It was not passed on and not stored.').waitFor({ timeout: 5000 }).then(() => true, () => false) && !(await write.count()))
  await page.getByLabel('Your question').fill('How do I add another passkey?')
  await page.getByRole('button', { name: 'Ask' }).click()
  await page.getByText('Did this answer your question?').or(write).first().waitFor({ timeout: 10000 })
  if (withKey) {
    check('a question gets a help text of the answer base', await page.getByRole('heading', { name: 'Add another passkey' }).isVisible())
    check('the help text fits at 1440 and at 390, and its link drawn as a button is not underlined',
      await both(page, '30-support-answer', '#sp-answer') && await page.getByRole('link', { name: /^Open / }).evaluate((a) => getComputedStyle(a).textDecorationLine === 'none'))
    // "No" shows the second best once, if the server sent one, then the hand-over card: two presses at most.
    for (let i = 0; i < 2 && !(await write.isVisible()); i++) await page.getByRole('button', { name: 'No' }).click()
  }
  await write.waitFor({ timeout: 5000 })
  check(`the hand-over card ${withKey ? 'follows "No"' : 'is shown at once without the key'}: an email to Ophis with the subject and three empty lines, nothing else`,
    (await write.getAttribute('href')) === 'mailto:clement@ophis.fi?subject=Ophis%20Business%20support&body=What%20I%20was%20doing%3A%0D%0A%0D%0AWhat%20I%20expected%3A%0D%0A%0D%0AWhat%20happened%3A%0D%0A')
  check(`the card says why: ${withKey ? 'the help texts did not answer' : 'no help text was found'}; "Write to Ophis" is a button without an underline; it fits at 1440 and at 390`,
    await page.getByText(withKey ? 'The help texts did not answer this question.' : 'No help text was found for this question.').isVisible()
    && !(await page.getByText('No help text fits').count()) && (!withKey || !(await page.getByText('No help text was found').count()))
    && await write.evaluate((a) => getComputedStyle(a).textDecorationLine === 'none') && await both(page, '31-support-handover', '#sp-person'))
  // "What each role can do": a FAQ item of Support, closed until opened, with the rows of the server's table. On a phone the
  // table scrolls inside its own box: the item hides what overflows it, so a page that does not scroll could still cut the table.
  const roles = page.locator('details', { hasText: 'What each role can do' })
  const closedAtFirst = !(await roles.evaluate((details) => details.open)) && !(await page.getByRole('cell', { name: 'Export the audit log' }).isVisible())
  await roles.locator('summary').click()
  await page.setViewportSize({ width: 390, height: 844 })
  const scrollsInItsBox = await roles.locator('table').evaluate((table) => getComputedStyle(table.parentElement).overflowX === 'auto' && table.parentElement.scrollWidth > table.parentElement.clientWidth)
  await page.setViewportSize({ width: 1440, height: 900 })
  check('"What each role can do" is not on the Organisation page; on Support it is a closed FAQ item that opens to the server\'s table, which scrolls inside its own box on a phone',
    rolesOnOrganisation === 0 && closedAtFirst && await page.getByRole('cell', { name: 'Export the audit log' }).isVisible() && scrollsInItsBox && await both(page, '37-support-roles', '.support > .sec'))
  // "Which tokens can I trade": the desk's tokens, moved here from the desk (owner, 2026-11-19). ETH is ETH itself, with no
  // token contract; 23 rows, each with its chain's logo and its token's, all loaded.
  const tokens = page.locator('details', { hasText: 'Which tokens can I trade, and how much per order?' })
  await tokens.locator('summary').click()
  const tokenRows = await tokens.locator('tbody tr').allInnerTexts()
  check('Support: "Which tokens can I trade" opens to every token of the desk by chain, ETH first on each chain that has it, with the most per order and their logos',
    tokenRows.length === 23 && tokenRows.filter((r) => r.startsWith('ETH')).length === 5 && tokenRows.filter((r) => r.startsWith('ETH')).every((r) => r.includes('No token contract') && r.includes('2,850'))
    && tokenRows.some((r) => r.includes('WETH') && r.includes('Arc')) && !tokenRows.some((r) => r.startsWith('ETH') && r.includes('Arc'))
    && await tokens.getByText('ETH is ETH itself: bought, it is paid into the wallet; sold, the wallet sends it in one transaction.').isVisible()
    && await tokens.locator('img.logo').evaluateAll((images) => Promise.all(images.map((image) => image.complete || new Promise((done) => { image.onload = image.onerror = done })))
      .then(() => images.length === 46 && images.every((image) => image.naturalWidth > 0)))
    && await tokens.getByRole('button', { name: 'Export CSV' }).isVisible() && await both(page, '38-support-tokens', '.support > .sec'))
  await arrive(owner, false)

  // The server cannot end the session: the app must not pretend that it did.
  await page.route('**/api/signout', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }))
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByText('Sign-out did not work.').waitFor({ timeout: 5000 })
  check('a failed sign-out keeps the app signed in and says so', await page.getByRole('button', { name: 'End session' }).first().isVisible() && (await status('/api/me')) === 200)
  await page.unroute('**/api/signout')

  // The revoke also clears the cookie, so the browser alone cannot show that the server forgot the token: replay it.
  cookie = await sessionCookie()
  // node:http, not fetch: the Host header names the console whatever port this run uses.
  const replay = () => new Promise((resolve, reject) => httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/me', headers: { host: 'localhost:8787', cookie: `__Host-session=${cookie.value}`, 'sec-fetch-site': 'same-origin' } }, (response) => resolve(response.resume().statusCode)).on('error', reject).end())
  const before = await replay()
  await page.getByRole('row', { name: /This session/ }).getByRole('button', { name: 'End session' }).click()
  await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor()
  check('after the revoke the app is back on sign-in and the session is dead', (await status('/api/me')) === 401)
  check('the revoked token is dead on the server: it worked before the revoke, not after', before === 200 && (await replay()) === 401)


  // ---- milestone 5a (first run 2026-11-11, on E2E_PORT=8797) ----
  // A company applies on /apply and creates the organisation (no DNS record since 2026-11-18); the applicant signs in,
  // names the recovery wallet with its one passkey, and the wallet signs the activation on the signing page; the Owner
  // submits; the operator approves through its command; the organisation is active and the KYB record shows.
  const applicant = await person()
  const on = applicant.page
  const domain = `e2e-${Date.now().toString(36)}.example`
  const operator = (...args) => run('node', ['scripts/operator.mjs', ...args])
  const refusedBy = (command) => { try { command(); return '' } catch (error) { return String(error.stderr ?? '') } } // what a refused command printed
  const code = operator('invite').trim().split('\n').pop() // G1: applications are by invitation
  check('the operator command issues an invitation code of 12 characters, in three groups of four', /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code))
  await on.goto(`${ORIGIN}/apply`)
  await on.getByLabel('Invitation code').fill(code)
  await on.getByLabel('Legal name').fill('Alder Custody S.A.')
  await on.getByLabel('Type of business').selectOption('fund')
  await on.getByLabel('Country of incorporation').selectOption('LU')
  check('the country is chosen by its name, and the type of business from a short list of names', await on.getByLabel('Country of incorporation').locator('option:checked').innerText() === 'Luxembourg'
    && (await on.getByLabel('Type of business').locator('option').allInnerTexts()).join('|') === 'Choose a type|Wallet|Exchange|App or dApp|Payments|DeFi protocol|Fund or asset manager|Venture capital|Bank|Broker|Family office|Company treasury')
  await on.getByLabel('Company registration number').fill('B123456')
  await on.getByLabel('LEI, if the company has one').fill('5493001KJTIIGC8Y1R12')
  await on.getByLabel('Registered address').fill('2 rue de la Gare, L-1611 Luxembourg')
  await on.getByLabel('Your name').fill('Ada Applicant')
  await on.getByLabel('Your position').fill('Chief Executive Officer')
  await on.getByLabel('Your work email', { exact: true }).fill(`ops@${domain}`)
  check('the company domain is filled in from the work email', await on.getByLabel('Company domain').inputValue() === domain)
  await on.getByLabel('Your phone').fill('+352 621 123 456')
  await on.getByLabel('Your Telegram username').fill('@ada_applicant')
  // Owner decision of 2026-11-13: the application names a second person, whom Ophis approves with the organisation.
  await on.getByRole('button', { name: 'Add a person' }).click()
  await on.getByLabel('Name of person 2', { exact: true }).fill('Ben Okoro')
  await on.getByLabel('Position of person 2').fill('Head of Treasury')
  await on.getByLabel('Work email of person 2').fill(`ben@${domain}`)
  await on.getByLabel('Phone of person 2').fill('+352 621 000 001')
  await on.getByLabel('Role of person 2').selectOption('admin')
  check('the form names a second person: a name, a position, a work email at the domain, a phone, the role Owner or Admin; it fits a phone', await both(on, '59-apply-people', 'fieldset'))
  check('the application page carries the footer line and says nothing is stored yet', await on.locator(".foot-line", { hasText: FOOTER }).isVisible() && await on.getByText('Ophis stores nothing until you create the organisation').isVisible())
  await on.getByRole('button', { name: 'Create the passkey', exact: true }).click()
  await on.getByRole('heading', { name: 'Your passkey is ready. Create the organisation.' }).waitFor()
  // Owner, 2026-11-18: the page asks for no DNS record.
  check('the panel offers exactly Create the organisation and Start again, and fits a phone',
    (await on.locator('section.recover .panel').getByRole('button').allInnerTexts()).map((text) => text.trim()).join('|') === 'Create the organisation|Start again' && await both(on, '32-apply-create'))
  check('the page shows no DNS record', (await on.getByText(/DNS|_ophis-verify/).count()) === 0)
  // A reload keeps the application (this browser remembers it).
  await on.reload()
  await on.getByRole('button', { name: 'Create the organisation' }).click()
  await on.getByRole('heading', { name: 'The organisation exists.' }).waitFor()
  await on.getByRole('link', { name: 'Sign in' }).last().click()
  await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await on.getByRole('heading', { name: /From application to a verified organisation|Read this before you continue/ }).waitFor()
  if (await on.getByRole('button', { name: 'I have read this' }).count()) await on.getByRole('button', { name: 'I have read this' }).click()
  await on.getByRole('heading', { name: 'From application to a verified organisation.' }).waitFor()
  const newOrg = await on.evaluate(() => fetch('/api/me').then((response) => response.json()).then((me) => me.organisation))
  check('the applicant signs in to an organisation that is not yet verified, and lands on Onboarding, which names Ben and says not to invite him', newOrg.state === 'unverified' && newOrg.name === 'Alder Custody S.A.' && await on.getByText('Not submitted.').isVisible()
    && await on.getByText(`Other people named in the application: Ben Okoro, Head of Treasury (Admin, ben@${domain}). Ophis checks them with the company. When Ophis approves, each gets a seat. Do not invite them yourself.`).isVisible())
  check('an unverified organisation does not reach the audit log', (await status('/api/audit', on)) === 403)
  check('its menu shows Overview and Desk switched off', await on.getByRole('button', { name: 'Overview', exact: true }).isDisabled() && await on.getByRole('button', { name: 'Desk', exact: true }).isDisabled())
  // One passkey is enough (owner, 2026-11-18): the applicant names the recovery wallet with the passkey it applied with.
  await on.goto(`${ORIGIN}/#/onboarding`)
  await on.reload()
  await on.getByLabel('Wallet address').fill(key.address)
  await on.getByLabel('Chain').selectOption({ label: 'OP Mainnet' })
  await on.getByLabel('A name for it').fill('Treasury')
  // Regression: a personal wallet and a named Admin can submit without declaring a custodian.
  const firstHash = await on.locator('article.sheet dt:has-text("First Owner passkey (hash)") + dd').innerText()
  await on.getByRole('button', { name: 'Create the signing link' }).click()
  const activationLink = await on.getByLabel(/Signing link/).inputValue()
  const signNow = on.getByRole('link', { name: 'Sign with your wallet' })
  check('"Sign with your wallet" opens that same signing link in a new tab, with no opener (owner, 2026-11-18)',
    await signNow.getAttribute('href') === activationLink && await signNow.getAttribute('target') === '_blank' && (await signNow.getAttribute('rel'))?.includes('noopener'))
  check('the Onboarding page gives a signing link on the signing host and the first Owner\'s passkey hash', activationLink.startsWith(`${SIGN}/sign/#`) && /^0x[0-9a-f]{64}$/.test(firstHash) && await both(on, '33-onboarding'))
  const activated = await sign(activationLink, '34-activation-sign')
  check('the signing page shows the fourth action, the organisation id, the same passkey hash and what to check, and the wallet signs',
    activated.before.includes('Activate this organisation and confirm its first Owner passkey') && activated.before.includes('First Owner passkey (hash)') && !activated.before.includes('New passkey (hash)') && activated.before.includes(newOrg.id) && activated.before.includes(firstHash) && activated.before.includes(key.address)
    && activated.before.includes('Sign only if the request comes from your colleague by a channel you trust, and the organisation named is theirs.') && !/three words/i.test(activated.before)
    && activated.after.includes('Signed and checked. The wallet is stored') && activated.asked.includes('eth_signTypedData_v4') && activated.fits)
  check('an activation names its wallet and chain, so the signing page offers WalletConnect first', activated.walletConnect)
  await on.getByRole('button', { name: 'The wallet has signed' }).click()
  await on.getByText('Wallet verified: it signed the activation', { exact: false }).waitFor()
  // Milestone 5b: the declaration, printed alone; the signed scan, sealed in this browser; the Worker keeps it sealed.
  check('without the sealed declaration "Submit for review" is closed, and the page says why', await on.getByRole('button', { name: 'Submit for review' }).isDisabled() && await on.getByText('The signed declaration is still missing.').isVisible())
  const paper = on.locator('article.sheet')
  const paperText = await paper.innerText()
  check('the declaration holds the server\'s values, a line for the signatory and the sentence that the signatory may bind the company; nothing on it can be typed',
    ['Alder Custody S.A.', domain, key.address, 'OP Mainnet', `Ben Okoro, Head of Treasury, Admin, ben@${domain}`, 'Registered address', '2 rue de la Gare, L-1611 Luxembourg', '5493001KJTIIGC8Y1R12', 'Ada Applicant, Chief Executive Officer', 'each person named above acts for the company', 'Name of the signatory', 'Role', 'Date', 'Signature', 'the undersigned may bind the company', 'Ophis is a software provider. It is not a crypto-asset service provider.'].every((text) => paperText.includes(text))
      && /[0-9a-f]{64}/.test(paperText) && (await paper.locator('input, textarea, select, button, [contenteditable]').count()) === 0)
  await on.emulateMedia({ media: 'print' })
  check('printed, the declaration stands alone', await paper.isVisible() && await on.getByRole('button', { name: 'Print the declaration' }).isHidden() && await on.locator('.bar').isHidden() && await on.locator('.band').isHidden() && await on.getByRole('button', { name: 'Submit for review' }).isHidden())
  await on.screenshot({ path: '.shots/42-declaration-print.png', fullPage: true })
  await on.setViewportSize({ width: 390, height: 844 })
  await on.screenshot({ path: '.shots/42-declaration-print-phone.png', fullPage: true })
  check('printed at the width of a phone, the declaration fits', await on.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await on.setViewportSize({ width: 1440, height: 900 })
  // What the signatory gets on paper: the browser's own print, as a PDF (print media still emulated).
  const paperPdf = await on.pdf({ format: 'A4' })
  writeFileSync('.shots/42-declaration.pdf', paperPdf)
  check('the declaration prints on one A4 page', (paperPdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length === 1)
  await on.emulateMedia({ media: 'screen' })
  const MARKER = 'E2E-CLEAR-TEXT-MARKER-5b'
  const scan = Buffer.from(`%PDF-1.4\n% ${MARKER}\n${'a signed declaration '.repeat(300)}\n%%EOF\n`)
  const sent = []
  const around = [] // the address and the headers of that request: the name and the type of the clear file stay in the browser too
  on.on('request', (request) => request.url().includes('/api/onboarding/declaration') && (sent.push(request.postDataBuffer()), around.push(request.url() + JSON.stringify(request.headers()))))
  // The key's hash is computed in the browser after the page shows: wait for it (isVisible alone raced it on 11-18).
  check('the page names the key it seals to', await on.getByText(/Sealed to key [0-9a-f]{64}/).waitFor().then(() => true, () => false))
  await on.getByLabel(/Signed scan/).setInputFiles({ name: 'declaration.pdf', mimeType: 'application/pdf', buffer: scan })
  await on.getByRole('button', { name: 'Seal and upload' }).click()
  await on.getByText('Uploaded on').waitFor({ timeout: 15000 }).catch(async () => check(`the sealed file was uploaded (the page says: ${(await on.locator('[role=alert]').allInnerTexts()).join(' ')})`, false))
  const stepText = await on.locator('.srow', { hasText: 'Uploaded on' }).innerText()
  const shownSha = /SHA-256 of the sealed file\s+([0-9a-f]{64})/.exec(stepText)?.[1]
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  // The local D1 is one SQLite file under the state folder: the sealed file is its pieces in sealed_chunks, in order.
  const d1 = readdirSync(STATE, { recursive: true }).filter((name) => /D1DatabaseObject.[0-9a-f]+\.sqlite$/.test(name))
  const pieces = d1.flatMap((name) => new DatabaseSync(`${STATE}/${name}`, { readOnly: true }).prepare('SELECT item_id, data FROM sealed_chunks ORDER BY item_id, n').all())
  const stored = Object.values(Object.groupBy(pieces, (piece) => piece.item_id)).map((own) => Buffer.concat(own.map((piece) => piece.data)))
  check('what left the browser is the sealed file: the age header, no marker, and neither the name nor the type of the clear file', sent.length === 1 && sent[0].subarray(0, 22).toString('latin1') === 'age-encryption.org/v1\n' && !sent[0].includes(MARKER)
    && around.length === 1 && !/declaration\.pdf|application\/pdf/i.test(around[0] + sent[0].toString('latin1')))
  check('the stored object is that sealed file: it starts with the age header, it does not hold the marker, and the step shows its date, size and SHA-256',
    stored.length === 1 && stored[0].subarray(0, 22).toString('latin1') === 'age-encryption.org/v1\n' && !stored[0].includes(MARKER) && stored[0].equals(sent[0])
      && sha256(stored[0]) === shownSha && stepText.includes(`${stored[0].length.toLocaleString('en-GB')} bytes, sealed`) && await both(on, '43-declaration-step', '.srow:has-text("Uploaded on")'))
  // Review of 5b: an uploaded declaration reads as done, and the Owner is told what a second upload does.
  check('once uploaded the step says Done, and that a new upload replaces the file and needs a new submit', /Declaration\s+Done/.test(stepText) && await on.getByText('A new upload replaces this file. If the organisation is under review, submit it again.').isVisible())
  await on.getByRole('button', { name: 'Submit for review' }).click()
  await on.getByText('Under review since').waitFor()
  check('a verified personal wallet with a named Admin can submit, and recovery is explicitly separate',
    await on.getByText('Wallet verified: it signed the activation', { exact: false }).isVisible()
      && await on.getByText('This single-key wallet cannot recover an organisation with other people.', { exact: false }).isVisible())
  const listed = operator('list')
  const itemId = /^(\w{32}) {2}declaration/m.exec(operator('items', newOrg.id))?.[1] ?? ''
  check('the operator\'s list and "items" show the sealed declaration with its size and SHA-256', new RegExp(`declaration +${itemId}  declaration  ${stored[0].length} bytes .* sha256 ${shownSha}`).test(listed) && itemId.length === 32)
  const out = `${STATE}/item.age`
  check('a download without a reason of the list is refused, and writes no file', refusedBy(() => operator('get', itemId, '--reason', 'curiosity', '--out', out)).includes('Refused (400): invalid') && !existsSync(out))
  check('the operator command takes the item, still sealed', operator('get', itemId, '--reason', 'kyb_review', '--out', out).includes('Written, still sealed') && readFileSync(out).equals(stored[0]))
  // Review of 5b: the command never writes over a file, and asks for nothing when the file is there (no row in the client's log for bytes thrown away).
  check('a second "get" to the same file is refused before anything is asked, and the file stays', refusedBy(() => operator('get', itemId, '--reason', 'incident', '--out', out)).includes('Refused: the file exists') && readFileSync(out).equals(stored[0])) // and no second row: the KYB block below holds one download
  // A server that names another SHA-256 than the bytes it sends: the command writes nothing.
  const liar = createServer((_, response) => response.writeHead(200, { 'x-sha256': '0'.repeat(64), 'x-seal-key': 'f'.repeat(64) }).end('age-encryption.org/v1\n')).listen(0, '127.0.0.1')
  await new Promise((resolve) => liar.once('listening', resolve))
  const lied = await new Promise((resolve) => { // not execFileSync: this process must answer as the server meanwhile
    let said = ''
    spawn('node', ['scripts/operator.mjs', 'get', itemId, '--reason', 'incident', '--out', `${out}.2`], { env: { ...env, E2E_PORT: String(liar.address().port) }, stdio: ['ignore', 'ignore', 'pipe'] }).on('close', () => resolve(said)).stderr.on('data', (chunk) => (said += chunk))
  })
  liar.close()
  check('a file whose SHA-256 is not the one the server names is not written', lied.includes('does not have the SHA-256') && !existsSync(`${out}.2`))
  check('an item id that is a path is refused by the command, which asks nothing (Codex: it reached another route of the operator)', refusedBy(() => operator('get', `../organisations/${newOrg.id}/freeze?`, '--reason', 'kyb_review', '--out', `${out}.3`)).includes('usage:') && !existsSync(`${out}.3`))
  const opener = new Decrypter()
  opener.addIdentity(readFileSync('.dev.seal-identity', 'utf8').trim()) // the local test identity; never printed
  check('the local test identity opens the downloaded file, offline: equal to the original', Buffer.from(await opener.decrypt(readFileSync(out))).equals(scan))
  check('the operator command lists the organisation with its domain, the first Owner\'s passkey hash, the person the application named and the wallet', listed.includes(newOrg.id) && listed.includes(domain) && listed.includes(`first Owner     Ada Applicant, Chief Executive Officer, ops@${domain}, +352621123456, @ada_applicant, passkey hash ${firstHash}`)
    && listed.includes(`person          Ben Okoro, Head of Treasury, ben@${domain}, +352621000001, admin`)
    && listed.includes('address         2 rue de la Gare, L-1611 Luxembourg') && listed.includes('LEI 5493001KJTIIGC8Y1R12') && listed.includes(key.address) && listed.includes('ready           yes'))
  const submission = /submission ([0-9a-f]{16}) /.exec(listed)?.[1] ?? ''
  // Sanctions screening: an approval carries a screening that says "clear". "--list eu=<file>": the command reads the file here and sends its SHA-256.
  const approve = (...more) => ['decide', newOrg.id, 'approve', '--tier', 'standard', '--source', 'registry', '--evidence', 'e2e register extract', '--sha256', 'ab'.repeat(32), '--next-review', '2030-01-01', ...more]
  const screened = ['--screening', 'clear', '--list', `eu=${LIST.eu}`]
  check('an approval that names no submission, or another one, is refused', refusedBy(() => operator(...approve('--submission', '0'.repeat(16), ...screened))).includes('submitted again since that list'))
  check('an approval with no screening, or with one that does not say "clear", is refused', refusedBy(() => operator(...approve('--submission', submission))).includes('Refused (400): screening_required')
    && refusedBy(() => operator(...approve('--submission', submission, '--screening', 'hit', '--list', `eu=${LIST.eu}`))).includes('Refused (409): screening_not_clear'))
  // The operator's review page (owner, 2026-11-19): the same list in a browser, and the approval, with no token. Locally
  // OPERATOR_EMAIL (dev.mjs) stands for the person Cloudflare Access signs in.
  const opDesk = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const opPage = await opDesk.newPage()
  opPage.on('console', (message) => /content security policy|trusted ?type/i.test(message.text()) && violations.push(message.text()))
  const opOffSite = [], opTokens = []
  opPage.on('request', (request) => {
    if (!request.url().startsWith(`${OPERATOR_SITE}/`)) opOffSite.push(request.url())
    if (request.headers().authorization) opTokens.push(request.url())
  })
  const opAnswer = await opPage.goto(`${OPERATOR_SITE}/`)
  const opCard = opPage.locator('article', { hasText: newOrg.id })
  await opCard.waitFor()
  const opShown = await opCard.innerText()
  check('the operator sees that approval will not configure wallet recovery', opShown.includes('Activation verified only. Approval leaves wallet recovery unconfigured.'))
  check('the review page lists the application with what to compare, under the strict policy, and fits a phone',
    opAnswer.status() === 200 && /require-trusted-types-for 'script'/.test(opAnswer.headers()['content-security-policy'] ?? '') && opAnswer.headers()['x-frame-options'] === 'DENY'
      && ['Alder Custody S.A.', domain, 'Ada Applicant', 'Ben Okoro, Head of Treasury', key.address, '2 rue de la Gare, L-1611 Luxembourg', 'Yes'].every((text) => opShown.includes(text))
      && await opCard.getByLabel(/^SHA-256 of the evidence/).inputValue() === /declaration .* sha256 ([0-9a-f]{64})/.exec(listed)?.[1] && await both(opPage, '73-operator-review'))
  await opCard.getByLabel(/^Next review/).fill('2030-01-01')
  await opCard.getByLabel(/^SHA-256 of the evidence/).fill('ab'.repeat(32)) // the field takes another document's hash, as the command's --sha256
  await opCard.getByLabel(/^Evidence reference/).fill('e2e register extract')
  await opCard.getByLabel(/I searched these files/).check()
  await opCard.getByLabel(/^EU consolidated list/).setInputFiles(LIST.eu)
  opPage.once('dialog', (dialog) => dialog.accept())
  await opCard.getByRole('button', { name: 'Approve', exact: true }).click()
  await opPage.getByText('Approved: Alder Custody S.A. is now active.').waitFor()
  check('the operator approves on the page, with a clear screening; the page sent no token and asked nothing of another site',
    await opPage.getByText('Nothing is under review.').isVisible() && opTokens.length === 0 && opOffSite.length === 0)
  check('"All organisations" lists every organisation, the one just approved too, with its state (owner, 2026-11-19)',
    /^Alder Custody S\.A\. \(institution, LU\): active, \d+ active members?, next review 2030-01-01\. [0-9a-f]{32}$/m.test(await opPage.locator('#all').innerText()))
  await opPage.getByRole('button', { name: 'New invitation code' }).click()
  await opPage.locator('#code').waitFor()
  check('the page makes an invitation code', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}, valid until /.test(await opPage.locator('#code').innerText()))
  // A list read that never answers (network down, or an expired sign-in redirected to Access) shows no card to decide on.
  await opPage.route('**/api/operator/organisations', (route) => route.abort())
  await opPage.reload()
  await opPage.locator('#status', { hasText: 'The network failed' }).waitFor()
  check('a list read that never answers says so and shows no card', /could not be read/.test(await opPage.locator('#apps').innerText()))
  await opDesk.close()
  const afterApproval = operator('list')
  check('nothing is left under review, and the list names the reviews that are due: the seeded organisation, never screened; not the one just approved',
    afterApproval.includes('Nothing is under review.') && /Reviews due[^\n]*\n[0-9a-f]{32} {2}Northwind Vaults {2}active {2}last screening none {2}next review none/.test(afterApproval) && !afterApproval.includes(newOrg.id))
  await on.reload()
  await on.getByText('Verified on').waitFor()
  check('the organisation is active with its next review, and no recovery wallet is claimed', await on.getByText('Next review 2030-01-01').isVisible() && await on.getByText('No recovery wallet is configured. Set one under Organisation.').isVisible() && (await status('/api/audit', on)) === 200)
  const approvedWallets = await on.evaluate(() => fetch('/api/org').then((response) => response.json()).then((org) => org.wallets))
  check('the personal wallet is linked without recovery authority after approval', approvedWallets.some((wallet) => wallet.address.toLowerCase() === key.address.toLowerCase() && wallet.state === 'linked' && wallet.recovery === null))
  check('once active the declaration stays: the step shows it and offers no upload', await on.getByText('Uploaded on').isVisible() && (await on.getByLabel(/Signed scan/).count()) === 0 && (await on.locator('article.sheet').count()) === 0)
  // The person the application named has a seat, approved by Ophis. The Owner gives a link (the console shows it; Ophis
  // sends no email), the person enrols, the Owner confirms with a passkey check: active at once, with no second person.
  check('the Onboarding page names the person Ophis approved with the organisation', await on.getByText(`Approved by Ophis with the organisation: Ben Okoro, Head of Treasury (Admin, ben@${domain}).`).isVisible())
  await arrive(applicant, false)
  check('the member table shows the invited seat as approved by Ophis', await on.getByRole('row', { name: /Ben Okoro.*Admin.*Invited.*Approved by Ophis with the organisation/ }).isVisible())
  await on.getByRole('button', { name: 'New link for Ben Okoro' }).click()
  await on.getByRole('button', { name: 'Create the link' }).click()
  const benLink = await on.getByLabel('Enrolment link').inputValue()
  check('the link dialog says that this person needs no second person', await on.getByText('Ophis approved this person with the organisation, so no second person is needed').isVisible())
  await on.getByRole('button', { name: 'Done' }).click()
  const ben = await person()
  await enrolAt(benLink, ben)
  await organisation(on)
  check('the Owner is told at the door that the passkey of the approved person waits', await readAlerts('A new passkey of Ben Okoro waits for you', on))
  const benCard = on.locator('article.appr', { hasText: 'Ben Okoro' })
  await benCard.waitFor()
  check('the card says that this confirmation makes the passkey active at once', await benCard.getByText('Ophis approved this person. Your confirmation makes the passkey active at once, with no second person.').isVisible())
  await confirmAt('Ben Okoro', on)
  await on.getByRole('row', { name: /Ben Okoro.*Admin.*Active/ }).waitFor()
  check('the Owner confirmed: the approved person is active at once, with no second person and no 72 hour wait', (await on.getByRole('heading', { name: 'Waiting for confirmation' }).count()) === 0
    && (await on.getByText('Approved by Ophis with the organisation').count()) === 0 && await both(on, '60-approved-person-active', '#approvals'))
  await arrive(ben)
  check('the approved person signs in', (await status('/api/me', ben.page)) === 200)
  await ben.context.close()
  await on.goto(`${ORIGIN}/#/compliance`)
  await on.reload()
  await on.getByRole('heading', { name: 'KYB record' }).waitFor()
  check('the Compliance page shows the KYB record and the operator\'s row in the audit log',
    await on.getByText('The one document stored is the signed declaration, sealed in your browser.').isVisible() && await on.locator('dl.kv dd', { hasText: 'Alder Custody S.A.' }).isVisible() && await on.locator('dl.kv dd', { hasText: 'Approved' }).isVisible()
    && await on.locator('dl.kv dd', { hasText: 'ab'.repeat(32) }).isVisible() && await on.getByText('Ophis operator: verification approved, organisation active').isVisible() && await both(on, '35-kyb-record', '#root dl.kv >> nth=0'))
  check('the KYB block lists the sealed declaration and the operator\'s download with its reason; the audit log has the row',
    await on.locator('dl.kv dd', { hasText: shownSha }).isVisible() && await on.getByText('still sealed, for the review of the organisation.').isVisible() && (await on.getByText(/still sealed, for/).count()) === 1
      && await on.getByText('Ophis operator: downloaded the sealed declaration, still sealed. Reason: the review of the organisation').isVisible() && await both(on, '44-kyb-sealed', '#root dl.kv >> nth=1'))
  check('the footer line is on the Onboarding and Compliance pages', await on.locator(".foot-line", { hasText: FOOTER }).isVisible())
  // Sanctions screening on the Compliance page. The version is the first 16 hex of the SHA-256 of the stored lists, which hold the SHA-256 of each list file: computed here again from the files.
  const today = new Date().toISOString().slice(0, 10)
  const version = (lists) => sha256(Buffer.from(JSON.stringify(lists))).slice(0, 16)
  const section = on.locator('#screening')
  await section.getByText('Result: no match.').waitFor()
  check('Compliance shows the screening of the approval: the date, the list, "no match", the list version, the next review; and that no address list is loaded yet',
    (await section.innerText()).includes(`Checked on ${today} against: EU consolidated financial sanctions list. Result: no match. List version ${version({ eu: fileSha(LIST.eu) })}. Next review by 2030-01-01.`)
    && await section.getByText('No address list is loaded yet. Wallets have not been compared.').isVisible() && (await section.locator('table').count()) === 0
    && await section.getByText('A check is a search of public lists on that date. It is repeated at each review.').isVisible())
  const loadedList = operator('addresses', `un=${LIST.addresses}`) // by hand, under the code "un": "ofac" is left to the list file (M10, below)
  check('the operator loads the test address list: two addresses (lower case, each once, 40 hex characters exactly), and no wallet is on it', loadedList.includes(`Loaded 2 addresses of the list "un" (file SHA-256 ${fileSha(LIST.addresses)})`) && loadedList.includes('No linked or pending wallet is on a loaded list.'))
  check('the operator records a clear screening against two lists', operator('screen', newOrg.id, '--outcome', 'clear', '--list', `un=${LIST.un}`, '--list', `eu=${LIST.eu}`, '--next-review', '2031-01-01').includes(`${newOrg.id} is now active`))
  await on.reload()
  await section.getByText('Not on a loaded list').waitFor()
  check('Compliance shows both: the new screening with its two lists and its version, and the wallet compared with the loaded address list',
    (await section.innerText()).includes(`Checked on ${today} against: EU consolidated financial sanctions list, UN Security Council consolidated list. Result: no match. List version ${version({ eu: fileSha(LIST.eu), un: fileSha(LIST.un) })}. Next review by 2031-01-01.`)
    && (await section.innerText()).includes(`Linked wallets are compared with the addresses of: UN Security Council consolidated list (2 addresses, loaded ${today}, version ${fileSha(LIST.addresses).slice(0, 16)}).`)
    && await section.getByRole('row', { name: new RegExp(`Treasury.*Not on a loaded list.*OP Mainnet.*${key.address}`) }).isVisible() // the result comes second: it shows on a phone
    && await on.getByText('Ophis operator: sanctions screening recorded. Result: no match').isVisible() && !/\b(hit|clear)\b/.test(await section.innerText()) && await both(on, '57-screening', '.pager')) // from the end of the audit log, so that the heading of the section is in the picture
  // G4: the operator freezes the organisation: its sessions end, and a member who signs in gets the plain page.
  check('the operator freezes the organisation', operator('freeze', newOrg.id).includes(`${newOrg.id} is now frozen`))
  await on.reload()
  await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await on.getByRole('heading', { name: 'This organisation is frozen.' }).waitFor()
  check('a freeze ends the session, and a sign-in shows the plain page, not "Sign-in did not work"', (await status('/api/me', on)) === 401 && await on.locator(".foot-line", { hasText: FOOTER }).isVisible() && await both(on, '36-org-frozen'))
  check('the operator unfreezes it', operator('unfreeze', newOrg.id).includes(`${newOrg.id} is now active`))
  await on.getByRole('button', { name: 'Back to sign-in' }).click()
  await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await on.getByRole('button', { name: 'Sign out' }).first().waitFor()
  check('after the unfreeze the member signs in again', (await status('/api/me', on)) === 200)
  // Sanctions screening: a "hit" freezes the organisation in the same step, and it stays frozen until a clear screening is recorded and the operator unfreezes it.
  const signInAgain = async () => {
    await on.getByRole('button', { name: 'Back to sign-in' }).click()
    await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
    await on.getByRole('button', { name: 'Sign out' }).first().waitFor()
  }
  const frozenPage = async () => {
    await on.reload()
    await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
    await on.getByRole('heading', { name: 'This organisation is frozen.' }).waitFor()
    return (await status('/api/me', on)) === 401 && await on.locator(".foot-line", { hasText: FOOTER }).isVisible()
  }
  check('a screening "hit" freezes the organisation', operator('screen', newOrg.id, '--outcome', 'hit', '--list', `eu=${LIST.eu}`, '--next-review', '2031-01-01').includes(`${newOrg.id} is now frozen`))
  check('its member lands on the frozen page, which does not say why, with no session', await frozenPage() && !/screening|sanction|\bhit\b/i.test(await on.locator('#root').innerText()) && await both(on, '58-screening-frozen'))
  check('the operator cannot unfreeze it while the newest screening says "hit"', refusedBy(() => operator('unfreeze', newOrg.id)).includes('Refused (409): screening_not_clear'))
  check('the operator\'s list names the frozen organisation with its last event', operator('list').includes(`${newOrg.id}  Alder Custody S.A.  frozen  last screening hit on ${today}  next review 2031-01-01  frozen by kyb.screen (hit) on ${today}`))
  check('a clear screening is recorded for the frozen organisation, which stays frozen; then the operator unfreezes it',
    operator('screen', newOrg.id, '--outcome', 'clear', '--list', `eu=${LIST.eu}`, '--next-review', '2031-01-01').includes(`${newOrg.id} is now frozen`) && operator('unfreeze', newOrg.id).includes(`${newOrg.id} is now active`))
  await signInAgain()
  // A list that names the organisation's wallet: the load freezes it and prints the hit; a load without the address lets the operator unfreeze.
  const hitList = `${STATE}/hit-list.txt`
  writeFileSync(hitList, `TEST DATA, made by this run. The wallet of the end-to-end organisation: ${key.address}\n`)
  const hit = operator('addresses', `un=${hitList}`)
  check('a load that names the organisation\'s wallet freezes it and prints the hit', hit.includes('Loaded 1 address of the list "un"') && hit.includes(`HIT  ${newOrg.id}  Alder Custody S.A.  was active  ${key.address.toLowerCase()}  frozen now`) && await frozenPage()
    && operator('list').includes(`frozen by screening.wallet (${key.address.toLowerCase()}) on ${today}`)) // F6: the list says why it is frozen, with the address
  check('the operator cannot unfreeze it while that wallet is on a loaded list; the same load again changes nothing', refusedBy(() => operator('unfreeze', newOrg.id)).includes('Refused (409): wallet_listed') && operator('addresses', `un=${hitList}`).includes(`was frozen  ${key.address.toLowerCase()}  not changed`))
  check('after a load without the address the operator unfreezes it', operator('addresses', `un=${LIST.addresses}`).includes('No linked or pending wallet is on a loaded list.') && operator('unfreeze', newOrg.id).includes(`${newOrg.id} is now active`))
  await signInAgain()
  await on.goto(`${ORIGIN}/#/compliance`)
  await on.reload()
  await on.getByRole('heading', { name: /Records and the audit trail|Read this before you continue/ }).waitFor()
  if (await on.getByRole('button', { name: 'I have read this' }).count()) await on.getByRole('button', { name: 'I have read this' }).click() // a new session is told of the passkey added in an earlier one
  await on.getByText('Chain verified').waitFor()
  check('unfrozen, the member reads each step in the audit log, in plain words, with the wallet by its name; no outcome but "no match" is said',
    await on.getByRole('row', { name: /A wallet of the organisation is on a loaded sanctions list, organisation frozen.*Treasury/ }).isVisible()
    && await on.getByRole('cell', { name: 'Ophis operator: sanctions screening recorded, organisation frozen', exact: true }).isVisible() && !/Result: (hit|review)|\bhit\b/.test(await on.locator('#root').innerText()))
  await applicant.context.close()

  // ---- the institution: the real desk (orders on a live quote of the local stand-in orderbook), and its overview from
  // its wallets (balances read on the stand-in's endpoints) and its orders ----
  // An institution from "seed --demo": an Owner, a Trader and an Approver, the linked "Demo wallet" (the address of the
  // first public test key of anvil, which signs here against the stand-in orderbook only) and the linked "Demo Safe".
  const BANNER = /Example figures|examples|Illustrative/
  const seeded = (...more) => run('node', ['scripts/dev.mjs', 'seed', ...more, '--persist', STATE])
  const demoSeed = seeded('--demo')
  check('seed --demo says what it made', demoSeed.includes('an institution with one linked wallet named "Demo wallet"'))
  async function firstOwner(link) {
    const who = await person()
    await who.page.goto(link)
    await who.page.getByRole('button', { name: 'Create passkey' }).click()
    await who.page.getByRole('heading', { name: 'Your passkey waits for approval.' }).waitFor()
    check('the activate command confirmed the new Owner', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
    await who.page.getByRole('link', { name: 'Go to sign-in' }).click()
    await who.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    return who
  }
  const dana = await firstOwner(demoSeed.match(/http\S+\/#\/enrol\/\S+/)[0])
  await dana.page.getByRole('heading', { name: 'Your position, in one view.' }).waitFor()
  const balanceRows = dana.page.locator('section', { has: dana.page.getByRole('heading', { name: 'Balances by wallet' }) }).locator('tbody tr')
  const testWeth = (Number(TEST_BALANCES.weth / 10n ** 14n) / 10_000).toFixed(4) // the stand-in's test balance, as the page shows it (4 decimals)
  check('an institution lands on its overview: no example figure, the footer, the balances of its two linked wallets read on the stand-in endpoints, no approval and no order yet',
    !(await dana.page.getByText(BANNER).count()) && await dana.page.locator(".foot-line", { hasText: FOOTER }).isVisible() && (await balanceRows.count()) === 8
    && JSON.stringify(await balanceRows.allInnerTexts()).includes(`WETH\\t${testWeth}`) && JSON.stringify(await balanceRows.allInnerTexts()).includes('"ETH\\t3.2500"') && (await balanceRows.nth(4).innerText()).includes('Demo Safe')
    && (await dana.page.locator('[data-waiting]').textContent()) === '0' && await dana.page.getByText('No order yet. Orders are prepared on the desk.').isVisible() && await dana.page.getByText('No filled order yet.').isVisible())
  await toOrganisation(dana.page)
  await secondKey(dana)
  async function inviteAt(who, name, role) {
    await who.page.getByRole('button', { name: 'Invite member' }).click()
    await who.page.getByLabel('Name shown to colleagues').fill(name)
    await who.page.getByLabel('Role').selectOption(role)
    await who.page.getByRole('button', { name: 'Create the link' }).click()
    const link = await who.page.getByLabel('Enrolment link').inputValue()
    await who.page.getByRole('button', { name: 'Done' }).click()
    return link
  }
  const tess = await person()
  await enrolAt(await inviteAt(dana, 'Tess Trader', 'trader'), tess)
  await arrive(dana, false)
  await confirmAt('Tess Trader', dana.page)
  await dana.page.getByRole('button', { name: 'Re-enrol Tess Trader' }).waitFor()
  await arrive(tess)
  const abe = await person()
  await enrolAt(await inviteAt(dana, 'Abe Approver', 'approver'), abe)
  await arrive(dana, false)
  await confirmAt('Abe Approver', dana.page)
  await dana.page.getByText('a 72 hour wait stands in for the second person').waitFor()
  check('the activate command stood in for the Approver\'s wait', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
  await arrive(abe)
  await abe.devtools.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: abe.authenticatorId })
  await abe.devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
  await abe.page.getByRole('button', { name: 'Add a passkey' }).click()
  await abe.page.getByText('2: Security key 1, Security key 2').waitFor()

  // M10: the desk sends only while the OFAC list file was read (F1: an empty list passes every address), so it is read first.
  const listMode = (mode) => fetch(`http://127.0.0.1:${LIST_PORT}/stub/${mode}`)
  // "sync" makes the Worker read the list stand-in, which lives in this process: the command must not block it (not execFileSync).
  const operatorSync = () => new Promise((resolve) => {
    let said = ''
    const child = spawn('node', ['scripts/operator.mjs', 'sync'], { env, stdio: ['ignore', 'pipe', 'pipe'] }).on('close', () => resolve(said))
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (said += chunk))
  })
  const synced = await operatorSync()
  check('"operator sync" reads the list file and loads it: the two addresses of the test file, with its publish day', synced.includes('Loaded 2 addresses of the list "ofac", published 2026-11-09.') && synced.includes('No linked or pending wallet is on a loaded list.'))

  // The Trader prepares an order on the desk.
  // Open a page of the console afresh; what is shown at the door is read first.
  const open = async (who, hash, heading) => {
    await who.page.goto(`${ORIGIN}/#/${hash}`)
    await who.page.reload()
    await who.page.getByRole('heading', { name: new RegExp(`${heading}|Read this before you continue`) }).waitFor()
    if (await who.page.getByRole('button', { name: 'I have read this' }).count()) await who.page.getByRole('button', { name: 'I have read this' }).click()
    await who.page.getByRole('heading', { name: heading }).waitFor()
  }
  const desk = (who) => open(who, 'desk', 'Order blotter')
  await desk(tess)
  const ticket = tess.page.locator('form.ticket')
  // The routes of the asset the ticket sells, on its chain, beside the ticket (owner, 2026-11-19). The stand-in's price is
  // the same at every size: one route, Deep.
  const routes = tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Routes and liquidity' }) })
  await routes.locator('li.route').first().waitFor()
  const routeRows = await routes.locator('li.route').allInnerTexts()
  const loaded = (where) => where.locator('img.logo').evaluateAll((images) => Promise.all(images.map((image) => image.complete || new Promise((done) => { image.onload = image.onerror = done })))
    .then(() => images.length > 0 && images.every((image) => image.naturalWidth > 0)))
  // Every chain of the desk is listed (owner, 2026-11-19); one with no linked wallet cannot be picked. Each logo loads under the page's policy.
  check('the desk shows the ticket with every chain, its linked wallets, ETH first and what selling it means, the routes of ETH beside it with their liquidity, the three steps, and no example',
    await ticket.getByLabel('Settle from').locator('option', { hasText: 'Demo wallet' }).count() === 1 && await ticket.getByLabel('Settle from').locator('option', { hasText: 'Demo Safe' }).count() === 1
    && (await ticket.getByLabel('Chain').locator('option:not([disabled])').allTextContents()).join() === 'OP Mainnet'
    && (await ticket.getByLabel('Chain').locator('option').allTextContents()).join() === 'Ethereum (no wallet linked),OP Mainnet,Robinhood Chain (no wallet linked),Arc (no wallet linked),Base (no wallet linked),Arbitrum One (no wallet linked)'
    && !(await tess.page.getByText(BANNER).count()) && await ticket.getByRole('link', { name: 'link a wallet there' }).isVisible()
    && await loaded(ticket))
  check('the ticket opens on ETH, says what selling it means, and lists ETH, USDC and WETH on OP Mainnet',
    (await ticket.getByLabel('Sell asset').inputValue()) === 'ETH' && (await ticket.getByLabel('Sell asset').locator('option').allTextContents()).join() === 'ETH,USDC,WETH'
    && await ticket.getByText('The wallet sends the ETH in one transaction, which places the order. Keep a little ETH for its network fee.').isVisible())
  check(`beside the ticket, the routes of ETH on OP Mainnet: USDC, Deep, the price impact at about 50k, 500k and 5M EUR, live, with logos; the tokens table is gone (${JSON.stringify(routeRows)})`,
    !(await tess.page.getByText('Tokens you can trade').count()) && routeRows.length === 1
    && /^USDC\s+Deep\s+About €50k\s+0\.0\d% impact\s+About €500k\s+0\.0\d% impact\s+About €5M\s+0\.0\d% impact$/.test(routeRows[0].trim())
    && await routes.getByText(/^Price impact: how much less an order gets, per unit, than an order of about €1,000\./).isVisible() && await routes.getByText(/^Live quotes, \d\d:\d\d$/).isVisible()
    && await loaded(routes) && await both(tess.page, '46-desk-routes'))
  check('the three steps and the review note', await tess.page.getByText('The Safe owners or your custodian sign on the signing page. Ophis cannot.').isVisible() && await ticket.getByText('Nothing is signed at this step.').isVisible())
  check('at phone width the ticket gives way to "Use a larger screen", the blotter stays, and nothing scrolls sideways', await both(tess.page, '47-desk-ticket')
    && await (async () => {
      await tess.page.setViewportSize({ width: 390, height: 844 })
      const ok = await tess.page.getByText('Use a larger screen.').isVisible() && !(await ticket.isVisible()) && await tess.page.getByRole('heading', { name: 'Order blotter' }).isVisible()
      await tess.page.setViewportSize({ width: 1440, height: 900 })
      return ok && await ticket.isVisible() && !(await tess.page.getByText('Use a larger screen.').isVisible())
    })())
  // The flows below sell WETH: the routes follow the asset sold.
  await ticket.getByLabel('Sell asset').selectOption('WETH')
  await routes.getByText('Where WETH can go on OP Mainnet, and how well each route holds a large order.').waitFor()
  await routes.locator('li.route').first().waitFor() // its quotes are read after the panel shows
  check('the routes follow the ticket: WETH sells for USDC on OP Mainnet (ETH is the same asset)', (await routes.locator('li.route').allInnerTexts()).map((r) => r.trim().split(/\s+/)[0]).join() === 'USDC')
  // A limit order: its price is units of the asset bought per unit sold, within 20% of the live quote.
  await ticket.getByLabel('Amount to sell').fill('1')
  await ticket.getByLabel('Limit', { exact: true }).check()
  await ticket.getByLabel('Limit price (USDC per WETH)').fill('1')
  await ticket.getByRole('button', { name: 'Review order' }).click()
  await tess.page.getByText('The limit price is outside the allowed range: within 20% of the live quote').waitFor()
  check('a limit price far from the live quote is refused, and the ticket fits the screenshots', await both(tess.page, '54-desk-limit-range'))
  await ticket.getByLabel('Market', { exact: true }).check()
  await ticket.getByLabel('Amount to sell').fill('1e9')
  await ticket.getByRole('button', { name: 'Review order' }).click()
  await tess.page.getByText('Enter the amount as a plain number above zero').waitFor()
  await ticket.getByLabel('Amount to sell').fill('1')
  // Five minutes pass (the local command): every passkey check is stale. The review needs none; sending asks for the passkey.
  check('the stale command aged the passkey checks', run('node', ['scripts/dev.mjs', 'stale', '--persist', STATE]).includes('Every passkey check is stale'))
  const orderCalls = []
  tess.page.on('request', (request) => orderCalls.push(`${request.method()} ${new URL(request.url()).pathname}`))
  await ticket.getByRole('button', { name: 'Review order' }).click()
  const review = tess.page.locator('[data-step="review"]')
  await review.getByRole('heading', { name: 'Review order' }).waitFor()
  const reviewed = await review.locator('dl.kv').innerText()
  check('the review step shows the server\'s terms from the live quote, the fee, the wallet that receives, and says that nothing is signed',
    ['1 WETH', 'at least ', ' USDC', 'Market, slippage 0.5%', 'OP Mainnet', '30 minutes after signing', '0.01% of the volume', 'The wallet receives what is bought.'].every((text) => reviewed.includes(text))
    && await review.getByText('Nothing is signed at this step.').isVisible() && await review.getByText(/live quote of the orderbook/).isVisible() && await both(tess.page, '48-desk-review', '[data-step="review"]'))
  const least = /at least (\S+) USDC/.exec(reviewed)[1]
  const BINDING = `Sell exactly 1 WETH. Receive at least ${least} USDC. Valid for 30 minutes after signing.`
  check('the review states the binding terms in words and the live quote', (await review.locator('[data-binding]').innerText()) === BINDING && /Live quote\s+[\d.]+ USDC for 1 WETH, from the orderbook now/.test(reviewed))
  const SENTENCE = `Sell 1 WETH for at least ${least} USDC, market, OP Mainnet, from Demo wallet`
  check('the review asked for no passkey', orderCalls.join() === 'POST /api/desk/orders' && await review.getByText('Sending asks for your passkey.').isVisible())
  await review.getByRole('button', { name: 'Send for approval' }).click()
  await tess.page.getByText('Sent for approval.').waitFor()
  check('sending the order asked for the passkey first: refused, a passkey check, then sent',
    orderCalls.slice(1, 5).join() === 'POST /api/desk/orders,POST /api/stepup/start,POST /api/stepup/finish,POST /api/desk/orders')
  const blotter = (who) => who.page.locator('section', { has: who.page.getByRole('heading', { name: 'Order blotter' }) }).locator('tbody tr')
  check('the order is sent for approval, reads in words, and is the one row of the blotter with its real state',
    await tess.page.getByText(new RegExp(`${SENTENCE.replace(/\./g, '\\.')} \\(0x[0-9a-fA-F]{4}\\.{3}[0-9a-fA-F]{4}\\)\\.`)).isVisible() && /^ORD-[0-9a-f]{8}.*Pending approval/.test(await blotter(tess).first().textContent()) && (await blotter(tess).count()) === 1)
  await arrive(tess, false)
  check('the Trader sees the own request under Approvals, with no way to approve it', await tess.page.getByText(SENTENCE).first().isVisible()
    && await tess.page.getByRole('button', { name: 'Cancel request' }).isVisible() && (await tess.page.getByRole('button', { name: 'Approve' }).count()) === 0)

  // The Approver approves it with a passkey.
  await arrive(abe, false)
  const card = abe.page.locator('article.appr', { hasText: SENTENCE })
  await card.getByRole('button', { name: 'Review' }).click()
  check('the Approver reads the order in words, the least amount received first, who asked, and that the wallet signs it within 1 hour (a market order)', await card.getByRole('heading', { name: 'Order' }).isVisible()
    && (await card.locator('p').first().innerText()).startsWith(BINDING) && await card.getByText(/Live quote/).isVisible()
    && await card.getByText('Requested by Tess Trader (Trader)').first().isVisible() && await card.getByText(/the wallet signs these terms within 1 hour, or they expire/).isVisible()
    && /^0x[0-9a-fA-F]{40}$/.test(await card.locator('dl.kv .mono').textContent()) && await both(abe.page, '50-order-approval', 'article.appr >> nth=0'))
  await card.getByRole('button', { name: 'Approve' }).click()
  await card.waitFor({ state: 'detached' })
  await desk(tess)
  check('after the approval the blotter says "Approved: waiting for signature"', (await blotter(tess).first().textContent()).includes('Approved: waiting for signature'))
  await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).click()
  const record = tess.page.locator('#record')
  await record.waitFor()
  await record.getByRole('button', { name: 'Signing link' }).click()
  const orderLink = await record.getByLabel('Link for the wallet').inputValue()
  check('the record of the order: who prepared it, the quote and the binding terms, who approved it, until when it can be signed, and a one-time signing link after a passkey check, with its two ways and a copy button',
    await record.getByText(SENTENCE).isVisible() && await record.getByText(/Tess Trader \(Trader\) on 20\d\d-/).isVisible() && await record.getByText(/Approved by Abe Approver on 20\d\d-/).isVisible()
    && (await record.locator('[data-binding]').innerText()) === BINDING && await record.getByText(/USDC for 1 WETH, when it was prepared/).isVisible()
    && await record.getByText('Sign before').isVisible() && /^http:\/\/127\.0\.0\.1:8787\/sign\/#order\.[A-Za-z0-9_-]{43}$/.test(orderLink) && await record.getByRole('heading', { name: 'Hand over the signing link' }).isVisible()
    && await record.getByText('A wallet in a browser, or a custodian\'s browser extension:').isVisible()
    && (await record.locator('[data-step="link"] .fine').innerText()).includes(`add ${SIGN}/sign/ as a custom app`) && await record.getByRole('button', { name: 'Copy the link' }).isVisible() && await both(tess.page, '49-desk-record', '#record'))
  await tess.page.setViewportSize({ width: 390, height: 844 })
  check('at phone width the blotter and the record stay usable', await record.getByText(SENTENCE).isVisible() && await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).isVisible())
  await tess.page.setViewportSize({ width: 1440, height: 900 })

  // The wallet's holder opens the link: the test key behind a fake provider. Its allowance is short, so it approves the exact amount first.
  const signer = mnemonicToAccount('test test test test test test test test test test test junk')
  // A browser that holds the test key: an injected provider whose calls are answered here, with the key's own signatures.
  // allowance: what the token's allowance read answers, in atoms (none by default).
  async function keyWallet(allowance = 0n) {
    const calls = []
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await context.exposeFunction('walletCall', async (method, params) => {
      calls.push([method, params])
      // The EthFlow contract's orders(): no owner, no expiry (never placed). Any other read: the token's allowance.
      const read = method === 'eth_call' && params[0].to.toLowerCase() === ETHFLOW_OP.toLowerCase() ? `0x${'0'.repeat(128)}` : `0x${allowance.toString(16).padStart(64, '0')}`
      return method === 'eth_requestAccounts' ? [signer.address] : method === 'eth_call' ? read : method === 'eth_sendTransaction' ? `0x${'ab'.repeat(32)}`
        : method === 'eth_getTransactionReceipt' ? { status: '0x1' } : method === 'eth_signTypedData_v4' ? signer.signTypedData(JSON.parse(params[1])) : null
    })
    await context.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.walletCall(method, params) } })
    return { context, calls, page: await context.newPage() }
  }
  const { context: holderOfDesk, calls: walletCalls, page: signOrder } = await keyWallet()
  const offOrigin = []
  signOrder.on('request', (request) => request.url().startsWith(`${SIGN}/`) || offOrigin.push(request.url()))
  const orderReads = [] // the order read at the page's load, and again just before its allowance is checked (Codex, PR #1646)
  signOrder.on('request', (request) => request.method() === 'POST' && request.url() === `${SIGN}/api/order` && orderReads.push(request.url()))
  signOrder.on('console', (message) => /content security policy|refused to/i.test(message.text()) && violations.push(message.text()))
  await signOrder.goto(orderLink)
  await signOrder.getByRole('heading', { name: 'The order the wallet will sign' }).waitFor()
  const fields = await signOrder.locator('#order dl.kv').innerText()
  const stepsOf = async (on) => (await on.locator('#o-steps li').evaluateAll((items) => items.map((li) => `${li.dataset.step} ${li.dataset.state}`))).join()
  check('the signing page shows the order in words, built by the server: the binding terms, amounts, chain, the wallet that receives, validity, fee, order id, and its three steps to do',
    ['1 WETH', `at least ${least} USDC`, 'OP Mainnet', `Demo wallet (${signer.address})`, 'Until ', ' UTC', '0.01% of the volume'].every((text) => fields.includes(text)) && /0x[0-9a-f]{112}/.test(fields)
    && new RegExp(`^Sell exactly 1 WETH\\. Receive at least ${least.replace(/\./g, '\\.')} USDC\\. Valid until 20\\d\\d-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\.$`).test(await signOrder.locator('#o-binding').innerText())
    && await stepsOf(signOrder) === 'approve todo,sign todo,sent todo' && await both(signOrder, '66-sign-order'))
  await signOrder.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
  await signOrder.getByText('Signed and sent. The order is open on the orderbook').waitFor()
  check('each step of the signing page is done: the approval, the signature, the send', await stepsOf(signOrder) === 'approve done,sign done,sent done')
  check('the signing page read the order again just before it checked the allowance: an order of the same wallet sent meanwhile is covered', orderReads.length === 2)
  const approval = walletCalls.find(([method]) => method === 'eth_sendTransaction')?.[1][0]
  check('the wallet was asked for its account, the chain, the allowance, an approval of the exact amount and its receipt, then one typed signature',
    walletCalls.map(([method]) => method).join() === 'eth_requestAccounts,wallet_switchEthereumChain,eth_call,eth_sendTransaction,eth_getTransactionReceipt,eth_signTypedData_v4'
    && approval.to === '0x4200000000000000000000000000000000000006' && approval.data === `0x095ea7b3${'83847eab41ad9ea43809ce71569eb2e9daf51830'.padStart(64, '0')}${(10n ** 18n).toString(16).padStart(64, '0')}`
    && await both(signOrder, '67-order-sent'))
  check(`the signing page of an order asked nothing of another origin (${offOrigin.length})`, offOrigin.length === 0)
  await signOrder.reload()
  await signOrder.getByText('This link is not valid any more').waitFor()
  check('the link works once', true)
  await holderOfDesk.close()
  await desk(tess)
  check('the blotter says "Open" once the orderbook has it', (await blotter(tess).first().textContent()).includes('Open'))
  await fetch(`http://127.0.0.1:${ORDERBOOK_PORT}/stub/fulfilled`)
  await desk(tess)
  await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).click()
  const recordText = await record.innerText()
  check('once the orderbook says it is filled, the desk reads it: "Filled", who gave the signing link, when it was sent, the order id, the amounts in units, the fee, and the transaction linked to the explorer',
    (await blotter(tess).first().textContent()).includes('Filled') && await record.getByText('Order id').isVisible() && /Given by Tess Trader on 20\d\d-/.test(recordText) && recordText.includes('Sent to the orderbook')
    && new RegExp(`Executed\\s+1 WETH sold, ${least.replace(/\./g, '\\.')} USDC bought`).test(recordText) && /Fee at settlement\s+0\.0078\d* WETH/.test(recordText)
    && (await record.getByRole('link', { name: /^0x[0-9a-f]{64}$/ }).getAttribute('href')).startsWith('https://optimistic.etherscan.io/tx/0x') && await both(tess.page, '68-desk-filled', '#record'))

  // The same for an order the Approver refuses.
  await ticket.getByLabel('Sell asset').selectOption('WETH')
  await ticket.getByLabel('Amount to sell').fill('0.123456789012345678') // every decimal a member typed is kept
  await ticket.getByRole('button', { name: 'Review order' }).click()
  await review.getByRole('button', { name: 'Send for approval' }).click()
  await tess.page.getByText('Sent for approval.').waitFor()
  await arrive(abe, false)
  const refusedCard = abe.page.locator('article.appr', { hasText: 'Sell 0.123456789012345678 WETH for at least' })
  await refusedCard.getByRole('button', { name: 'Reject' }).click()
  await refusedCard.waitFor({ state: 'detached' })
  await desk(tess)
  await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).click()
  check('a refused order shows as refused in the blotter and in its record, with who refused it',
    (await blotter(tess).first().textContent()).includes('Refused') && await record.getByText(/Refused by Abe Approver on 20\d\d-/).isVisible() && await record.getByText(/Sell 0\.123456789012345678 WETH for at least/).isVisible()
    && (await blotter(tess).nth(1).textContent()).includes('Filled'))

  // One CSV, downloaded and read back.
  const [orderFile] = await Promise.all([tess.page.waitForEvent('download'), tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Order blotter' }) }).getByRole('button', { name: 'Export CSV' }).click()])
  const orderLines = readFileSync(await orderFile.path(), 'utf8').split('\r\n').filter(Boolean)
  check('the export of the blotter downloads: named ophis-orders-, the orders with their real state, every row with source = live',
    /^ophis-orders-\d{4}-\d\d-\d\d\.csv$/.test(orderFile.suggestedFilename()) && orderLines[0].endsWith(',"Transaction","source"') && orderLines.length === 3 && orderLines.slice(1).every((row) => row.endsWith(',"live"'))
    && orderLines[1].includes('"0.123456789012345678"') && orderLines[1].includes('"Refused"') && orderLines[2].includes('"Filled"') && /"0x[0-9a-f]{64}","live"$/.test(orderLines[2]))

  await open(tess, 'overview', 'Your position, in one view.')
  const recent = tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Recent orders' }) }).locator('tbody tr')
  const statementRows = tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Monthly statement' }) }).locator('tbody tr')
  const month = new Date().toISOString().slice(0, 7)
  check('the institution overview: its linked wallets and their balances, the own orders with their real state, and the statement of the filled order: this month, WETH sold, one order, its volume and fee',
    (await recent.first().textContent()).includes('Refused') && (await recent.nth(1).textContent()).includes('Filled') && (await recent.count()) === 2
    && await tess.page.getByText('Your linked wallets, read on the chain. Only the assets of the desk are shown.').isVisible() && (await statementRows.count()) === 1
    && new RegExp(`^${month}\\s*WETH sold\\s+1\\s+1\\.0000\\s+0\\.0078`).test(await statementRows.first().innerText())
    && await both(tess.page, '45-overview-institution'))
  const [statementFile] = await Promise.all([tess.page.waitForEvent('download'), tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Monthly statement' }) }).getByRole('button', { name: 'Export CSV' }).click()])
  const [balanceFile] = await Promise.all([tess.page.waitForEvent('download'), tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Balances by wallet' }) }).getByRole('button', { name: 'Export CSV' }).click()])
  const statementLines = readFileSync(await statementFile.path(), 'utf8').split('\r\n').filter(Boolean)
  const balanceLines = readFileSync(await balanceFile.path(), 'utf8').split('\r\n').filter(Boolean)
  check('the statement and the balances download as ophis- files: one line per month and asset, one per wallet and asset',
    /^ophis-statement-\d{4}-\d\d-\d\d\.csv$/.test(statementFile.suggestedFilename()) && /^ophis-balances-\d{4}-\d\d-\d\d\.csv$/.test(balanceFile.suggestedFilename())
    && statementLines.length === 2 && statementLines[1].startsWith(`"${month}","WETH","1","1",`) && balanceLines.length === 7 && balanceLines[1].startsWith(`"Demo wallet","${signer.address}","OP Mainnet","ETH","0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE","3.25",`))

  // The Trader prepares an order, the Approver approves it; then the record of the newest order gives its link.
  async function approved(amount, wallet = 'Demo wallet') {
    await desk(tess)
    await ticket.getByLabel('Settle from').selectOption(await ticket.getByLabel('Settle from').locator('option', { hasText: wallet }).getAttribute('value'))
    await ticket.getByLabel('Sell asset').selectOption('WETH')
    await ticket.getByLabel('Amount to sell').fill(amount)
    await ticket.getByRole('button', { name: 'Review order' }).click()
    await review.getByRole('button', { name: 'Send for approval' }).click()
    await tess.page.getByText('Sent for approval.').waitFor()
    await arrive(abe, false)
    const asked = abe.page.locator('article.appr', { hasText: `Sell ${amount} WETH for at least` })
    await asked.getByRole('button', { name: 'Approve' }).click()
    await asked.waitFor({ state: 'detached' })
  }
  async function linkOf(button) {
    await desk(tess)
    await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).click()
    await record.getByRole('button', { name: button }).click()
    return record.getByLabel('Link for the wallet').inputValue()
  }
  // A cancel: an order the key wallet signed is open on the orderbook; the wallet cancels it on a cancel link.
  await fetch(`http://127.0.0.1:${ORDERBOOK_PORT}/stub/open`)
  await approved('2')
  const toSign = await keyWallet()
  await toSign.page.goto(await linkOf('Signing link'))
  await toSign.page.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
  await toSign.page.getByText('Signed and sent. The order is open on the orderbook').waitFor()
  await desk(tess)
  check('the second order is open on the orderbook', (await blotter(tess).first().textContent()).includes('Open'))
  const cancelPage = await toSign.context.newPage() // a new tab: the page reads its link when it opens
  await cancelPage.goto(await linkOf('Cancel link'))
  await cancelPage.getByRole('heading', { name: 'Cancel an approved order.' }).waitFor()
  check('the cancel link opens the open order to cancel: one signature, then the send', await stepsOf(cancelPage) === 'sign todo,sent todo')
  await cancelPage.getByRole('button', { name: 'Cancel with the wallet in this browser' }).click()
  await cancelPage.getByText('Signed and sent. The orderbook cancelled the order.').waitFor()
  check('the wallet signed the off-chain cancellation once, and each step is done', toSign.calls.filter(([method]) => method === 'eth_signTypedData_v4').length === 2
    && JSON.parse(toSign.calls.at(-1)[1][1]).primaryType === 'OrderCancellations' && await stepsOf(cancelPage) === 'sign done,sent done' && await both(cancelPage, '71-sign-cancel'))
  await toSign.context.close()
  await desk(tess)
  check('the blotter reads the cancel at the orderbook: "Cancelled"', (await blotter(tess).first().textContent()).includes('Cancelled') && (await blotter(tess).nth(1).textContent()).includes('Refused'))

  // A Safe: its order is a presign order, sent from inside the Safe interface. The stand-in here is a page at
  // app.safe.global (served by this browser, never fetched) that frames the signing page and answers the Safe Apps SDK.
  await approved('3', 'Demo Safe')
  const safeLink = await linkOf('Signing link')
  check('the record of a Safe order says to use the Safe interface', await record.getByText('This wallet is a Safe: use the Safe interface.', { exact: false }).isVisible())
  const safeAddress = (await tess.page.evaluate(async () => (await (await fetch('/api/desk')).json()).wallets)).find((w) => w.label === 'Demo Safe').address
  const outsideSafe = await keyWallet()
  await outsideSafe.page.goto(safeLink)
  await outsideSafe.page.getByText('This wallet is a Safe. In the Safe interface open Apps').waitFor()
  check('outside the Safe interface, the signing page of a Safe order offers no wallet signature and says where to open it', !(await outsideSafe.page.getByRole('button', { name: /Sign with/ }).isVisible()))
  await outsideSafe.context.close()
  // The Safe interface, opened on a signing link: what the Safe was asked to propose is kept in `proposed`.
  async function safeFrame(link, shown = true) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const proposed = []
    await context.exposeFunction('safeSent', (txs) => void proposed.push(...txs))
    await context.route('https://app.safe.global/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Safe</title><body style="margin:0"><iframe id="app" title="Ophis" src="${link}" style="width:100%;height:100vh;border:0"></iframe><script>
      addEventListener('message', async ({ data, source }) => {
        if (!data || !data.method) return
        const answer = data.method === 'getSafeInfo' ? { safeAddress: ${JSON.stringify(safeAddress)}, chainId: 10, threshold: 2, owners: [], isReadOnly: false }
          : data.method === 'rpcCall' ? '0x${'0'.repeat(64)}' : data.method === 'sendTransactions' ? (await window.safeSent(data.params.txs), { safeTxHash: '0x${'cd'.repeat(32)}' }) : null
        source.postMessage({ id: data.id, success: true, version: '9.1.0', data: answer }, '*')
      })</script></body>` }))
    // The public Safe page frames a page on this machine: Chrome asks for local network access first, granted here.
    await context.grantPermissions(['local-network-access'])
    const page = await context.newPage()
    page.on('console', (message) => /content security policy|refused to/i.test(message.text()) && violations.push(message.text()))
    await page.goto('https://app.safe.global/apps/open')
    const inSafe = page.frameLocator('#app')
    if (shown) await inSafe.getByRole('heading', { name: 'The order the wallet will sign' }).waitFor()
    const steps = async () => (await inSafe.locator('#o-steps li').evaluateAll((items) => items.map((li) => `${li.dataset.step} ${li.dataset.state}`))).join()
    return { context, proposed, page, inSafe, steps }
  }
  const safeHome = await safeFrame(safeLink)
  const { inSafe, proposed } = safeHome
  check('inside the Safe interface the page shows the Safe order and its steps: the send to the orderbook first, then the approval and the presignature in one Safe transaction', await safeHome.steps() === 'sent todo,approve todo,safe todo'
    && (await inSafe.locator('#o-wallet').innerText()).startsWith('Demo Safe') && await both(safeHome.page, '69-sign-safe'))
  await inSafe.getByRole('button', { name: 'Sign with this Safe' }).click()
  await inSafe.getByText('Sent. The order waits for the Safe owners to execute the transaction').waitFor()
  await inSafe.locator('#o-steps li[data-step="safe"][data-state="proposed"]').waitFor()
  const uid = await inSafe.locator('#o-uid').innerText()
  check('the order went to the orderbook, then the Safe was asked for one batch: an approval of exactly 3 WETH to the vault relayer, then setPreSignature(order, true) on the settlement; the steps say sent, and proposed',
    proposed.length === 2 && proposed[0].to === '0x4200000000000000000000000000000000000006' && proposed[0].data === `0x095ea7b3${'83847eab41ad9ea43809ce71569eb2e9daf51830'.padStart(64, '0')}${(3n * 10n ** 18n).toString(16).padStart(64, '0')}`
    && proposed[1].to.toLowerCase() === '0x310784c7fce12d578da6f53460777bac9718b859' && proposed[1].data.startsWith('0xec6cb13f') && proposed[1].data.includes(uid.slice(2))
    && await safeHome.steps() === 'sent done,approve proposed,safe proposed')
  await safeHome.context.close()
  await desk(tess)
  check('the blotter says the Safe order waits for the Safe transaction (the orderbook: presignature pending)', (await blotter(tess).first().textContent()).includes('Sent: waiting for the Safe transaction') && await both(tess.page, '70-desk-safe-pending'))

  // A Safe order whose asset sold is on a loaded sanctions list: the server refuses it before the Safe is asked for anything.
  await approved('4', 'Demo Safe')
  const listedLink = await linkOf('Signing link')
  const tokenList = `${STATE}/token-list.txt`
  writeFileSync(tokenList, 'TEST DATA, made by this run. The asset sold, WETH on OP Mainnet: 0x4200000000000000000000000000000000000006\n')
  check('the operator loads a list that names the asset sold', operator('addresses', `un=${tokenList}`).includes('Loaded 1 address of the list "un"'))
  const listedSafe = await safeFrame(listedLink, false)
  await listedSafe.inSafe.getByText('Refused: an address of this order is on a public sanctions list that Ophis loaded.').waitFor()
  check('a Safe order of a listed asset is refused as its page opens, before the Safe is asked for anything: no order shown, nothing to sign, no transaction proposed',
    listedSafe.proposed.length === 0 && !(await listedSafe.inSafe.getByRole('button', { name: 'Sign with this Safe' }).count()) && !(await listedSafe.inSafe.getByRole('heading', { name: 'The order the wallet will sign' }).count()))
  await listedSafe.context.close()
  check('the list is loaded again as it was', operator('addresses', `un=${LIST.addresses}`).includes('No linked or pending wallet is on a loaded list.'))
  await desk(tess)
  check('the blotter says the listed Safe order is refused', (await blotter(tess).first().textContent()).includes('Refused'))

  // Two open orders of one wallet in one asset: the second asks the wallet to approve what both still need, though its
  // allowance would cover the second alone.
  await approved('5')
  const fifth = await keyWallet()
  await fifth.page.goto(await linkOf('Signing link'))
  await fifth.page.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
  await fifth.page.getByText('Signed and sent. The order is open on the orderbook').waitFor()
  await fifth.context.close()
  await approved('6')
  const sixth = await keyWallet(6n * 10n ** 18n)
  await sixth.page.goto(await linkOf('Signing link'))
  await sixth.page.getByRole('heading', { name: 'The order the wallet will sign' }).waitFor()
  const approveStep = await sixth.page.locator('#o-steps li[data-step="approve"]').innerText()
  const advice = await sixth.page.locator('#o-advice').innerText()
  await sixth.page.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
  await sixth.page.getByText('Signed and sent. The order is open on the orderbook').waitFor()
  const wide = sixth.calls.find(([method]) => method === 'eth_sendTransaction')?.[1][0]
  check('with an order of 5 WETH open on the same wallet, the order of 6 WETH has the wallet, whose allowance is 6 WETH, approve exactly 11 WETH, and the page says why',
    approveStep.startsWith('Approve exactly 11 WETH for the vault relayer of the settlement contract') && advice.includes('The approval covers this order and the other open orders of this wallet in this asset.')
    && wide?.data === `0x095ea7b3${'83847eab41ad9ea43809ce71569eb2e9daf51830'.padStart(64, '0')}${(11n * 10n ** 18n).toString(16).padStart(64, '0')}`)
  await sixth.context.close()

  // One person withdraws an approved order before the wallet signs it, after a passkey check: its link stops working.
  await approved('7')
  const withdrawnLink = await linkOf('Signing link')
  await record.getByRole('button', { name: 'Withdraw the order' }).click()
  await record.getByText('Withdrawn', { exact: true }).waitFor()
  const late = await keyWallet()
  await late.page.goto(withdrawnLink)
  await late.page.getByText('This link is not valid any more').waitFor()
  check('a Trader withdraws an approved order from its record: the blotter and the record say Withdrawn, no link is offered, and the link given opens nothing',
    (await blotter(tess).first().textContent()).includes('Withdrawn') && !(await record.getByRole('button', { name: /Signing link|Withdraw the order/ }).count())
    && late.calls.length === 0 && await both(tess.page, '72-desk-withdrawn', '#record'))
  await late.context.close()

  // An ETH sale (owner, 2026-11-19): no approval and no signature. The page has the server check the order, reads the
  // EthFlow contract (never placed), then the wallet sends the one transaction that places the order with its ETH.
  await desk(tess)
  await ticket.getByLabel('Amount to sell').fill('0.5')
  await ticket.getByRole('button', { name: 'Review order' }).click()
  await review.getByRole('button', { name: 'Send for approval' }).click()
  await tess.page.getByText('Sent for approval.').waitFor()
  await arrive(abe, false)
  const ethCard = abe.page.locator('article.appr', { hasText: 'Sell 0.5 ETH for at least' })
  await ethCard.getByRole('button', { name: 'Approve' }).click()
  await ethCard.waitFor({ state: 'detached' })
  const ethSale = await keyWallet()
  await ethSale.page.goto(await linkOf('Signing link'))
  await ethSale.page.getByRole('heading', { name: 'The order the wallet will sign' }).waitFor()
  const ethTodo = await stepsOf(ethSale.page)
  const ethAdvice = await ethSale.page.locator('#o-advice').innerText()
  await ethSale.page.getByRole('button', { name: 'Send with the wallet in this browser' }).click()
  await ethSale.page.getByText('Sent. The transaction placed the order and sent its ETH.').waitFor()
  const placedTx = ethSale.calls.find(([method]) => method === 'eth_sendTransaction')?.[1][0]
  check('an ETH sale: the server checks it, the page reads the EthFlow contract, and the wallet sends one transaction of 0.5 ETH to the EthFlow contract of OP Mainnet, which places the order; no approval, no signature',
    ethTodo === 'checked todo,send todo' && await stepsOf(ethSale.page) === 'checked done,send done' && ethAdvice.includes(`0.5 ETH to ${ETHFLOW_OP}`)
    && ethSale.calls.map(([method]) => method).join() === 'eth_requestAccounts,wallet_switchEthereumChain,eth_call,eth_sendTransaction,eth_getTransactionReceipt'
    && placedTx.to === ETHFLOW_OP && placedTx.value === `0x${(5n * 10n ** 17n).toString(16)}` && placedTx.data.startsWith('0x322bba21') && await both(ethSale.page, '68-eth-sale-sent'))
  await ethSale.context.close()
  await desk(tess)
  check('the blotter says the ETH sale waits for its transaction', (await blotter(tess).first().textContent()).includes('Sent: waiting for the ETH transaction'))
  for (const who of [dana, tess, abe]) await who.context.close()

  // ---- partner figures: live ----
  // The stand-in for the rebate indexer answers the contract file of the indexer's own test, read where it is. Every
  // number asserted below is read from that file, none is typed here.
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
  const [P] = contract.wallets // the partner wallet; the second wallet of the file has zero fees
  const usd = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const weth = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 6 })
  const STUB = `http://127.0.0.1:${INDEXER_PORT}`
  const stubMode = async (name) => check(`the stand-in is in mode ${name}`, (await (await fetch(`${STUB}/stub/${name}`)).json()).mode === name)
  const askStub = (headers, wallets = [P.wallet, `0x${'d'.repeat(40)}`], listed = P.sanctioned.map((x) => x.wallet)) => fetch(`${STUB}/business/partner`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ wallets, listed }) })
  const stubBearer = { authorization: `Bearer ${readFileSync('.dev.vars', 'utf8').match(/^INDEXER_TOKEN=(.+)$/m)?.[1]}` } // never printed
  const goodAnswer = await askStub(stubBearer)
  const answered = await goodAnswer.json()
  const notListed = await (await askStub(stubBearer, [P.wallet], [])).json()
  check('the stand-in has the real route\'s bearer rule and serves the contract file: its partner wallet as it is, any other wallet with zero fees and no wallet that traded, and no referral dashboard; a listed wallet only when it was sent as listed, and listed is required',
    (await askStub({})).status === 401 && (await askStub({ authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' })).status === 401 && (await askStub(stubBearer, [])).status === 400 && (await askStub(stubBearer, [P.wallet, P.wallet])).status === 400
    && goodAnswer.status === 200 && JSON.stringify(answered.wallets[0]) === JSON.stringify(P) && JSON.stringify(Object.keys(answered.wallets[1])) === '["wallet","fees","traders","breakdown","sanctioned"]' && answered.wallets[1].sanctioned.length === 0
    && P.sanctioned.length === 1 && notListed.wallets[0].sanctioned.length === 0 && (await askStub(stubBearer, [P.wallet], null)).status === 400 && answered.wallets[1].fees.currentCycle.owedUsd === 0 && answered.wallets[1].fees.recipient === `0x${'d'.repeat(40)}`
    && answered.wallets[1].traders.wallets.length === 0 && Object.values(answered.wallets[1].breakdown).every((rows) => rows.length === 0))
  // The console sends every address it holds (three lists of 1,000 at most, about 135 kB): the real route reads up to 3 MB.
  const manyListed = [...Array.from({ length: 1000 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`), ...P.sanctioned.map((x) => x.wallet)]
  const big = await askStub(stubBearer, [P.wallet], manyListed).then((r) => r.json()).catch(() => null)
  check('the stand-in reads a body as large as the console sends: 1,001 listed addresses (45 kB), its listed wallet kept', JSON.stringify(manyListed).length > 45_000 && big?.wallets[0].sanctioned.length === 1)

  // A partner from "seed --live": one linked "Demo wallet" at the contract's partner address.
  const liveSeed = seeded('--live')
  check('seed --live says what it made', liveSeed.includes('a partner with one linked wallet named "Demo wallet"'))
  const pat = await firstOwner(liveSeed.match(/http\S+\/#\/enrol\/\S+/)[0])
  await pat.page.getByRole('heading', { name: 'Your flow, in one view.' }).waitFor()
  await pat.page.getByText('Figures from the Ophis rebate service, read at').waitFor()
  check('a partner\'s Overview has the monthly statement of its desk orders too (owner, 2026-11-19)', await pat.page.getByRole('heading', { name: 'Monthly statement' }).isVisible() && await pat.page.getByText('No filled order yet.').isVisible())
  const reportingOrg = await pat.page.evaluate(() => fetch('/api/me').then((r) => r.json()).then((me) => me.organisation.id))
  const reportingWallets = () => pat.page.evaluate(() => fetch('/api/org').then((r) => r.json()).then((org) => org.wallets))
  const beforeReporting = await reportingWallets()
  check('the operator command excludes a wallet from reporting', operator('reporting', reportingOrg, 'exclude', '--wallet', P.wallet).includes('excluded in partner reporting'))
  await pat.page.reload()
  await pat.page.getByText('No wallet is included in partner reporting.').waitFor()
  check('an excluded wallet has no partner figures', (await pat.page.locator('.pw').count()) === 0)
  await pat.page.goto(`${ORIGIN}/#/organisation`)
  await pat.page.getByText('Excluded from partner reporting').waitFor()
  const afterReporting = await reportingWallets()
  check('reporting exclusion keeps the linked wallet and its recovery state visible',
    JSON.stringify(afterReporting) === JSON.stringify(beforeReporting.map((w) => ({ ...w, reporting: false })))
    && await pat.page.locator('#wallets').getByText('Linked', { exact: true }).isVisible())
  check('the operator command restores reporting', operator('reporting', reportingOrg, 'include', '--wallet', P.wallet).includes('included in partner reporting'))
  await pat.page.goto(`${ORIGIN}/#/`)
  await pat.page.getByText('Figures from the Ophis rebate service, read at').waitFor()
  const partnerMain = pat.page.locator('main')
  const feeSection = pat.page.locator('.pw section', { has: pat.page.getByRole('heading', { name: 'Partner fee' }) })
  const tradedSection = pat.page.locator('.pw section', { has: pat.page.getByRole('heading', { name: 'Wallets that traded through your integration' }) })
  const monthRows = feeSection.locator('tbody tr')
  const partnerTile = (caption, within = feeSection) => within.locator('.stats .c', { has: pat.page.locator('.cap', { hasText: new RegExp(`^${caption.replace(/[()]/g, '\\$&')}$`) }) }).locator('.num').textContent()
  check('the partner overview shows the stand-in\'s partner fee for the linked wallet: the tiles, read from the contract file',
    (await partnerTile('Owed this cycle')) === `$${usd(P.fees.currentCycle.owedUsd)}` && (await partnerTile('Trades waiting for a price')) === String(P.fees.currentCycle.pendingUnpricedTrades)
    && (await partnerTile('Paid to date (WETH)')) === weth(P.fees.lifetime.paidWeth) && (await partnerTile('Trades')) === String(P.fees.lifetime.tradeCount))
  check('the wallet as the console shows wallets, the parts of what is owed, and the line under the estimate',
    await pat.page.getByRole('heading', { name: /Demo wallet/ }).isVisible() && (await pat.page.locator('.pw-head .mono').textContent()).toLowerCase() === P.wallet && await pat.page.locator('.pw-head', { hasText: 'OP Mainnet' }).isVisible()
    && await pat.page.getByText(`Your share $${usd(P.fees.currentCycle.partnerShareUsd)} plus $${usd(P.fees.currentCycle.carriedInUsd)} carried.`).isVisible() && (await pat.page.getByText('Estimate. The amount is fixed when a payout is made.').count()) === 1)
  check('the months of the partner fee, read from the contract file',
    (await monthRows.count()) === P.fees.recentBatches.length && (await monthRows.allTextContents()).every((row, i) => row.startsWith(P.fees.recentBatches[i].cycleMonth) && row.includes(usd(P.fees.recentBatches[i].owedUsd)) && row.includes(usd(P.fees.recentBatches[i].carriedUsd))))
  // The wallets that traded through the integration, read from the contract file: the totals, then each wallet, largest first,
  // then the trades of no known wallet. A volume with trades not priced yet says how many under it.
  const tradedCells = async () => Promise.all((await tradedSection.locator('tbody tr').all()).map(async (row) => (await row.locator('td').allInnerTexts()).map((cell, i) => (i ? cell : cell.toLowerCase()))))
  const notPriced = (n) => (n ? `\n${n} ${n === 1 ? 'trade' : 'trades'} not priced yet` : '')
  const UNKNOWN_ROW = 'not known (native eth sales)'
  const S = P.sanctioned[0] // on the list "un" the operator loaded above (tests/fixtures/sanctions-addresses.txt), and on the OFAC test file read before the desk
  const tag = (wallet) => (wallet === S.wallet ? '\nsanctions list' : '')
  check('the wallets that traded through the integration: the totals, every wallet of the contract file, largest first, with its trades and volume, then the trades of no known wallet; trades not priced yet under each volume and in one line',
    (await partnerTile('Wallets', tradedSection)) === String(P.traders.totals.walletCount) && (await partnerTile('Trades', tradedSection)) === String(P.traders.totals.trades) && (await partnerTile('Volume (USD)', tradedSection)) === usd(P.traders.totals.volumeUsd)
    && JSON.stringify(await tradedCells()) === JSON.stringify([...P.traders.wallets, { ...P.traders.unknown, wallet: UNKNOWN_ROW }].map((w) => [w.wallet + tag(w.wallet), String(w.trades), usd(w.volumeUsd) + notPriced(w.unpriced)]))
    && P.traders.wallets.some((w) => w.unpriced && !w.volumeUsd) && P.traders.unknown.trades > 0
    && await tradedSection.getByText(`Volume is priced each night. ${P.traders.totals.unpriced} trades are not priced yet.`).isVisible() && !(await tradedSection.getByText(/largest wallets/).count()))
  // The breakdown, read from the contract file: the payouts with each transaction linked to the chain's explorer, the
  // daily volume as bars with every day in a table under them, by chain, by fee token.
  const B = P.breakdown
  const sectionOf = (name) => pat.page.locator('.pw section', { has: pat.page.getByRole('heading', { name, exact: true }) })
  const cellsOf = async (section) => Promise.all((await section.locator('tbody tr').all()).map((row) => row.locator('td').allInnerTexts()))
  const CHAIN_NAMES = { 10: 'OP Mainnet', 100: 'Gnosis', 130: 'Unichain' }
  const shortTx = (tx) => `${tx.slice(0, 6)}...${tx.slice(-4)}`
  const nTrades = (n) => `${n} ${n === 1 ? 'trade' : 'trades'}`
  const payoutsSection = sectionOf('Payouts')
  const txLink = payoutsSection.getByRole('link', { name: shortTx(B.payouts[0].txHash) })
  check('the payouts of the contract file, newest first: date and chain, WETH, Paid with the transaction linked to the chain\'s explorer in a new tab',
    JSON.stringify(await cellsOf(payoutsSection)) === JSON.stringify(B.payouts.map((x) => [`${x.date}\n${CHAIN_NAMES[x.chainId]}`, weth(x.weth), `Paid\n${shortTx(x.txHash)}`]))
    && await txLink.getAttribute('href') === `https://gnosisscan.io/tx/${B.payouts[0].txHash}` && await txLink.getAttribute('target') === '_blank' && await txLink.getAttribute('title') === B.payouts[0].txHash)
  const dailySection = sectionOf('Daily volume')
  const bars = dailySection.locator('svg[role="img"] rect')
  const top = Math.max(...B.daily.map((d) => d.volumeUsd))
  const barOf = async (i) => bars.nth(i).evaluate((r) => ({ x: Number(r.getAttribute('x')), h: Number(r.getAttribute('height')), title: r.querySelector('title').textContent }))
  const [firstBar, highest, onlyUnpriced] = [await barOf(0), await barOf(B.daily.findIndex((d) => d.volumeUsd === top)), await barOf(B.daily.length - 1)]
  check('the daily volume: one bar per day of the contract file at its place in the 90 days, the highest full height, a day of trades not priced only a thin bar; the dates and the highest day under it; a line on trades not priced yet',
    (await bars.count()) === B.daily.length && firstBar.x === (89 - (Date.parse('2026-11-12') - Date.parse(B.daily[0].day)) / 86_400_000) * 10 + 1 && highest.h === 100 && onlyUnpriced.h === 1
    && firstBar.title === `${B.daily[0].day}: ${usd(B.daily[0].volumeUsd)} USD, ${B.daily[0].trades} trades` && (await dailySection.locator('svg[role="img"]').getAttribute('aria-label')).startsWith('Daily volume in USD from 2026-08-15 to 2026-11-12. 11 days with trades.')
    && (await dailySection.locator('figcaption').innerText()).replace(/\s+/g, ' ') === `2026-08-15 Highest day: ${usd(top)} USD 2026-11-12`
    && await dailySection.getByText(`${B.daily.reduce((n, d) => n + d.unpriced, 0)} trades are not priced yet: in the table, not in the bars.`).isVisible())
  const dayTable = dailySection.locator('details table')
  const shut = !(await dayTable.isVisible())
  await dailySection.getByText('Each day as a table').click()
  check('the table under the chart, shut until asked: every day with its trades, volume (trades not priced yet under it) and share',
    shut && await dayTable.isVisible() && JSON.stringify(await cellsOf(dailySection)) === JSON.stringify(B.daily.map((d) => [`${d.day}\n${nTrades(d.trades)}`, usd(d.volumeUsd) + notPriced(d.unpriced), usd(d.shareUsd)])))
  const txSection = sectionOf('Recent transactions')
  await txSection.locator('summary').click()
  const settlement = B.transactions[0]
  check('opens the settlement transaction on its chain and shows its priced volume',
    (await txSection.locator('tbody a').getAttribute('href')) === 'https://optimistic.etherscan.io/tx/' + settlement.txHash
    && await txSection.getByText(usd(settlement.volumeUsd), { exact: true }).isVisible())
  const [chainSection, tokenSection] = [sectionOf('By chain'), sectionOf('By fee token')]
  check('by chain and by fee token, read from the contract file: the chain by its name, the token whole, trades not priced yet under the volume or the share',
    JSON.stringify(await cellsOf(chainSection)) === JSON.stringify(B.byChain.map((c) => [`${CHAIN_NAMES[c.chainId]}\n${nTrades(c.trades)}`, usd(c.volumeUsd) + notPriced(c.unpriced), usd(c.shareUsd)]))
    && JSON.stringify((await cellsOf(tokenSection)).map(([token, share]) => [token.toLowerCase(), share])) === JSON.stringify(B.byToken.map((t) => [`${t.token}\n${CHAIN_NAMES[t.chainId]}, ${nTrades(t.trades)}`.toLowerCase(), usd(t.shareUsd) + notPriced(t.unpriced)])))
  // The wallets on a sanctions list that traded: owner decision of 2026-11-14, "i want interactions with ofac sanctioned wallets flagged".
  const flagged = pat.page.locator('.note.flagged')
  // The line under the alert: the lists checked, then what they did not reach. The sales of no known wallet are the
  // trades the indexer could not check (it gives a trade one wallet in both answers).
  const checkedLine = () => pat.page.locator('.checked').innerText()
  const CHECKED = `The wallets whose orders carried the reported fee are checked against: OFAC SDN list, published 2026-11-09, loaded ${today}; UN Security Council consolidated list, loaded ${today}.`
  const HIDDEN = ' Not checked: the orders of linked wallets whose figures are not shown.'
  check('a wallet of the contract file is on the loaded list "un": a red alert before the figures with the wallets, trades, USD and trades not priced yet, that it is information, and its table (wallet, list, trades, volume, first and last trade); a line names the list checked and the sales of native ETH of no known wallet, not checked; the wallet is tagged once in the wallets that traded',
    (await flagged.getAttribute('role')) === 'alert' && (await flagged.evaluate((box) => !!(box.compareDocumentPosition(document.querySelector('.pw')) & Node.DOCUMENT_POSITION_FOLLOWING)))
    && (await flagged.locator('p').first().innerText()).includes(`1 wallet on a sanctions list traded through your integration: ${S.trades} trades, $${usd(S.volumeUsd)}, ${nTrades(S.unpriced)} not priced yet. This is for your information. Nothing in your account changes.`) && S.unpriced > 0
    && JSON.stringify((await cellsOf(flagged)).map(([wallet, ...rest]) => [wallet.toLowerCase(), ...rest])) === JSON.stringify([[`${S.wallet}\nofac sdn list, un security council consolidated list\n${S.trades} trades`, usd(S.volumeUsd) + notPriced(S.unpriced), `${S.firstAt.slice(0, 10)}\nLast ${S.lastAt.slice(0, 10)}`]])
    && (await checkedLine()) === `${CHECKED} Not checked: ${P.traders.unknown.trades} sales of native ETH with no known wallet.` && P.traders.unknown.trades > 1
    && (await tradedSection.locator('tbody tr', { hasText: 'Sanctions list' }).count()) === 1 && (await status('/api/me', pat.page)) === 200) // information only: the organisation is not frozen
  check('the alert of the wallets on a sanctions list fits a phone', await both(pat.page, '65-overview-partner-sanctioned', '.note.flagged'))
  await pat.page.setViewportSize({ width: 390, height: 844 })
  check('at phone width the table of the alert needs no sideways scroll: the address wraps', await flagged.locator('.table-wrap').evaluate((box) => box.scrollWidth <= box.clientWidth))
  await pat.page.setViewportSize({ width: 1440, height: 900 })
  check('the payouts fit a phone', await both(pat.page, '62-overview-partner-payouts', '.pw section:has(h2:text-is("Payouts"))'))
  check('the daily volume and its table fit a phone', await both(pat.page, '63-overview-partner-daily', '.pw section:has-text("Daily volume")'))
  check('by chain and by fee token fit a phone', await both(pat.page, '64-overview-partner-chains-tokens', '.pw .g.even'))
  await pat.page.setViewportSize({ width: 390, height: 844 })
  await pat.page.waitForTimeout(200)
  check('at phone width the bars span the width and the tables of the breakdown need no sideways scroll',
    (await dailySection.locator('svg[role="img"]').evaluate((svg) => svg.getBoundingClientRect().width)) > 300
    && (await Promise.all([payoutsSection, dailySection, txSection, chainSection, tokenSection].map((x) => x.locator('.table-wrap').evaluate((box) => box.scrollWidth <= box.clientWidth)))).every(Boolean))
  await pat.page.setViewportSize({ width: 1440, height: 900 })

  // The statement of its desk orders (owner, 2026-11-19) names what an order paid, "the Ophis fee among them", word for
  // word as an institution's does; the partner-fee figures never do.
  const partnerText = (await partnerMain.innerText()).replace(await pat.page.locator('section', { has: pat.page.getByRole('heading', { name: 'Monthly statement' }) }).innerText(), '')
  check('no demo banner, no example, no referral share, none of the withheld figures, no word of a licence or of payout terms; the footer line',
    !(await pat.page.getByText(BANNER).count()) && !/example|demo data|illustrative/i.test(partnerText) && !/referr|partner code|net fee|earning|payout run/i.test(partnerText)
    && [P.fees.currentCycle.grossFeeUsd, P.fees.minPayoutUsd].every((n) => !partnerText.includes(usd(n))) && !partnerText.includes(String(P.fees.partnerShareBps)) && !/bps|minimum/i.test(partnerText)
    && !/Ophis fee|licen[cs]ed|regulated|authori[sz]ed|MiCA|compliant|paid (weekly|monthly)|guarantee|honest|—/i.test(partnerText) && await pat.page.locator(".foot-line", { hasText: FOOTER }).isVisible())
  await pat.page.evaluate(() => scrollTo(0, 0)) // the checks above scrolled down: this shot is the top of the page
  check('the live partner overview fits a phone', await both(pat.page, '52-overview-partner-live'))
  await pat.page.waitForTimeout(200) // the desk size just came back: let it paint before the next shot
  check('the wallets that traded fit a phone', await both(pat.page, '61-overview-partner-wallets', '.pw section:has-text("Wallets that traded through your integration")'))
  await pat.page.setViewportSize({ width: 390, height: 844 })
  check('at phone width the table of those wallets needs no sideways scroll: an address wraps', await tradedSection.locator('.table-wrap').evaluate((box) => box.scrollWidth <= box.clientWidth))
  await pat.page.setViewportSize({ width: 1440, height: 900 })

  // The two CSV, downloaded and read back.
  const [monthsFile] = await Promise.all([pat.page.waitForEvent('download'), pat.page.getByRole('button', { name: 'Fee months CSV' }).click()])
  const monthLines = readFileSync(await monthsFile.path(), 'utf8').split('\r\n').filter(Boolean)
  check('the export of the fee months downloads: named ophis-partner-, the partner wallet and source = live in every row, every month of the contract file',
    /^ophis-partner-months-\d{4}-\d\d-\d\d\.csv$/.test(monthsFile.suggestedFilename()) && monthLines[0] === '"Partner wallet","Wallet name","Month","Status","Owed (USD)","Owed (WETH)","Carried (USD)","source"'
    && monthLines.length === P.fees.recentBatches.length + 1 && monthLines.slice(1).every((row, i) => row.toLowerCase().startsWith(`"${P.wallet}","demo wallet","${P.fees.recentBatches[i].cycleMonth}",`) && row.endsWith(`,"${P.fees.recentBatches[i].carriedUsd}","live"`)))
  const [tradedFile] = await Promise.all([pat.page.waitForEvent('download'), pat.page.getByRole('button', { name: 'Trading wallets CSV' }).click()])
  const tradedLines = readFileSync(await tradedFile.path(), 'utf8').split('\r\n').filter(Boolean)
  const tradedRow = (wallet, w, list = '') => `"${P.wallet}","demo wallet","${wallet}","${list}","${w.trades}","${w.volumeUsd}","${w.unpriced}","live"`
  check('the export of the wallets that traded downloads: named ophis-partner-traders-, every wallet of the contract file beside the partner wallet with its trades not priced yet, the trades of no known wallet, the total, source = live; the two are the only CSV',
    /^ophis-partner-traders-\d{4}-\d\d-\d\d\.csv$/.test(tradedFile.suggestedFilename()) && tradedLines[0] === '"Partner wallet","Wallet name","Wallet","Sanctions list","Trades","Volume (USD)","Trades not priced yet","source"'
    && JSON.stringify(tradedLines.slice(1).map((row) => row.toLowerCase())) === JSON.stringify([...P.traders.wallets.map((w) => tradedRow(w.wallet, w, w.wallet === S.wallet ? 'ofac sdn list; un security council consolidated list' : '')), tradedRow(UNKNOWN_ROW, P.traders.unknown), tradedRow('total, 3 wallets', P.traders.totals)])
    && (await pat.page.getByRole('button', { name: /CSV/ }).count()) === 8) // and the statement's (owner, 2026-11-19)
  const [listedFile] = await Promise.all([pat.page.waitForEvent('download'), pat.page.getByRole('button', { name: 'Sanctioned wallets CSV' }).click()])
  const listedLines = readFileSync(await listedFile.path(), 'utf8').split('\r\n').filter(Boolean)
  check('the export of the wallets on a sanctions list downloads: named ophis-partner-sanctioned-, the wallet with its list, trades, volume, trades not priced yet, first and last trade, source = live',
    /^ophis-partner-sanctioned-\d{4}-\d\d-\d\d\.csv$/.test(listedFile.suggestedFilename()) && listedLines[0] === '"Partner wallet","Wallet name","Wallet","Sanctions list","Trades","Volume (USD)","Trades not priced yet","First trade","Last trade","source"'
    && JSON.stringify(listedLines.slice(1).map((row) => row.toLowerCase())) === JSON.stringify([`"${P.wallet}","demo wallet","${S.wallet}","ofac sdn list; un security council consolidated list","${S.trades}","${S.volumeUsd}","${S.unpriced}","${S.firstAt}","${S.lastAt}","live"`.toLowerCase()]))
  // The four CSV of the breakdown, downloaded and read back.
  const breakdownFile = async (label) => {
    const [file] = await Promise.all([pat.page.waitForEvent('download'), pat.page.getByRole('button', { name: label }).click()])
    return { name: file.suggestedFilename(), lines: readFileSync(await file.path(), 'utf8').split('\r\n').filter(Boolean).map((row) => row.toLowerCase()) }
  }
  const csvLine = (...cells) => [P.wallet, 'demo wallet', ...cells, 'live'].map((cell) => `"${String(cell).toLowerCase()}"`).join(',')
  const [dailyFile, chainsFile, tokensFile, payoutsFile] = [await breakdownFile('Daily CSV'), await breakdownFile('Chains CSV'), await breakdownFile('Fee tokens CSV'), await breakdownFile('Payouts CSV')]
  check('the four CSV of the breakdown download, named ophis-partner-, with every row of the contract file beside the partner wallet, source = live',
    [[dailyFile, 'daily'], [chainsFile, 'chains'], [tokensFile, 'tokens'], [payoutsFile, 'payouts']].every(([file, table]) => new RegExp(`^ophis-partner-${table}-\\d{4}-\\d\\d-\\d\\d\\.csv$`).test(file.name))
    && JSON.stringify(dailyFile.lines.slice(1)) === JSON.stringify(B.daily.map((d) => csvLine(d.day, d.trades, d.volumeUsd, d.shareUsd, d.unpriced)))
    && JSON.stringify(chainsFile.lines.slice(1)) === JSON.stringify(B.byChain.map((c) => csvLine(CHAIN_NAMES[c.chainId], c.trades, c.volumeUsd, c.shareUsd, c.unpriced)))
    && JSON.stringify(tokensFile.lines.slice(1)) === JSON.stringify(B.byToken.map((t) => csvLine(CHAIN_NAMES[t.chainId], t.token, t.trades, t.shareUsd, t.unpriced)))
    && JSON.stringify(payoutsFile.lines.slice(1)) === JSON.stringify(B.payouts.map((x) => csvLine(x.date, x.weth, CHAIN_NAMES[x.chainId], x.txHash, x.status)))
    && payoutsFile.lines[0] === '"partner wallet","wallet name","date","amount (weth)","chain","transaction","status","source"')

  // The figures are not available: status 500, a wrong shape, an answer after 6 seconds. Never an example, never a part.
  const patOverview = () => pat.page.goto(`${ORIGIN}/#/overview`).then(() => pat.page.reload())
  const unavailable = pat.page.locator('[data-state="figures_unavailable"]')
  for (const failing of ['500', 'shape', 'slow']) {
    await stubMode(failing)
    await patOverview()
    await unavailable.waitFor({ timeout: 15_000 })
    check(`the indexer answers with ${failing}: "The figures are not available right now", a Retry button, and no figure at all`,
      await unavailable.getByText('The figures are not available right now.').isVisible() && await unavailable.getByRole('button', { name: 'Retry' }).isVisible()
      && !(await pat.page.locator('.stats').count()) && !(await partnerMain.innerText()).includes('$')
      // The one CSV left is the statement's (owner, 2026-11-19): its own desk orders, which the indexer does not give.
      && (await pat.page.getByRole('button', { name: /CSV/ }).count()) === 1 && await pat.page.getByRole('button', { name: 'Export CSV', exact: true }).isVisible())
    if (failing === '500') check('the unavailable state fits a phone', await both(pat.page, '53-overview-partner-unavailable'))
  }
  await stubMode('ok')
  await unavailable.getByRole('button', { name: 'Retry' }).click()
  await pat.page.getByText('Figures from the Ophis rebate service, read at').waitFor()
  check('Retry reads again: the figures are back', (await partnerTile('Owed this cycle')) === `$${usd(P.fees.currentCycle.owedUsd)}`)

  // The rules of the block that the contract file does not reach, on the console's own answer changed in this browser.
  const overviewWith = async (edit) => {
    // route.fetch() sends the cookie but not sec-fetch-site, which the server asks of every API call. Nothing here may
    // throw: an error in a route handler ends the run with the server still up.
    await pat.page.route('**/api/overview', async (route) => {
      const response = await route.fetch({ headers: { ...route.request().headers(), 'sec-fetch-site': 'same-origin' } }).catch(() => null)
      const body = await response?.json().catch(() => null)
      if (body?.figures?.wallets) edit(body.figures)
      await (response ? route.fulfill({ response, json: body }) : route.abort()).catch(() => undefined)
    })
    await patOverview()
    await pat.page.getByText('Figures from the Ophis rebate service, read at').waitFor()
    await pat.page.unroute('**/api/overview')
  }
  const tradedWith = (traders, key = 'traders', sanctioned = []) => overviewWith((f) => Object.assign(f.wallets[0], { sanctioned, [key]: traders }))
  const tradersList = (n) => Array.from({ length: n }, (_, i) => ({ wallet: `0x${(i + 1).toString(16).padStart(40, '0')}`, trades: 1, volumeUsd: n - i, unpriced: 0 }))
  const none = { trades: 0, volumeUsd: 0, unpriced: 0 }
  await tradedWith({ wallets: tradersList(100), unknown: none, totals: { walletCount: 105, trades: 105, volumeUsd: 5100, unpriced: 0 } })
  check('more than 100 wallets: the table lists 100 and says it shows the largest; no trade of an unknown wallet: no row for it, and the line under the alert names none not checked; every trade priced: no line about pricing; no listed wallet: no alert, no tag',
    (await tradedSection.locator('tbody tr').count()) === 100 && await tradedSection.getByText('The table shows the 100 largest wallets by volume.', { exact: true }).isVisible() && (await partnerTile('Wallets', tradedSection)) === '105'
    && !(await tradedSection.getByText(/priced each night|not priced yet|Not known/).count()) && !(await flagged.count()) && !(await tradedSection.getByText('Sanctions list').count()) && (await checkedLine()) === CHECKED)
  const outside = { wallet: `0x${'e'.repeat(40)}`, lists: ['OFAC SDN list'], trades: 1, volumeUsd: 0.5, unpriced: 0, firstAt: null, lastAt: null }
  await tradedWith({ wallets: tradersList(100), unknown: none, totals: { walletCount: 105, trades: 105, volumeUsd: 5100, unpriced: 0 } }, 'traders', [outside])
  check('a listed wallet outside the 100 largest: added at the end of the table with its tag, and the line says so; the alert in the singular, its block time not known yet',
    (await tradedSection.locator('tbody tr').count()) === 101 && JSON.stringify((await tradedCells()).at(-1)) === JSON.stringify([`${outside.wallet}\nsanctions list`, '1', '0.50'])
    && await tradedSection.getByText('The table shows the 100 largest wallets by volume. The wallets on a sanctions list are added at the end.').isVisible()
    && (await flagged.locator('p').first().innerText()).includes('1 wallet on a sanctions list traded through your integration: 1 trade, $0.50.') && JSON.stringify(await cellsOf(flagged)) === JSON.stringify([[`${outside.wallet}\nOFAC SDN list\n1 trade`, '0.50', 'Not known yet']]))
  // Two partner wallets: a listed wallet that traded through both is one row of the alert, its trades added up, its first and last trade over both.
  await overviewWith((f) => {
    const [w] = f.wallets
    f.wallets = [w, { ...w, wallet: `0x${'f'.repeat(40)}`, label: 'Second', sanctioned: [{ ...w.sanctioned[0], trades: 2, volumeUsd: 10, unpriced: 2, firstAt: '2026-07-01T00:00:00.000Z', lastAt: '2026-11-10T00:00:00.000Z' }, { ...outside, unpriced: 1 }] }]
  })
  check('two partner wallets: the alert counts each listed wallet once, its trades, volume and trades not priced yet added up over both, the first trade the earliest and the last the latest',
    (await flagged.locator('p').first().innerText()).includes(`2 wallets on a sanctions list traded through your integration: ${S.trades + 3} trades, $${usd(S.volumeUsd + 10.5)}, ${nTrades(S.unpriced + 3)} not priced yet.`)
    && JSON.stringify((await cellsOf(flagged)).map(([wallet, ...rest]) => [wallet.toLowerCase(), ...rest])) === JSON.stringify([
      [`${S.wallet}\nofac sdn list, un security council consolidated list\n${S.trades + 2} trades`, usd(S.volumeUsd + 10) + notPriced(S.unpriced + 2), `2026-07-01\nLast 2026-11-10`], [`${outside.wallet}\nofac sdn list\n1 trade`, '0.50' + notPriced(1), 'Not known yet']]))
  // What the lists did not reach: a contract wallet whose figures are not shown, the wallets after the 10 read, and a sale of native ETH of no known wallet.
  await overviewWith((f) => {
    const [w] = f.wallets
    f.wallets = [{ ...w, traders: { ...w.traders, unknown: { trades: 1, volumeUsd: 0, unpriced: 1 } } }, { ...w, wallet: `0x${'f'.repeat(40)}`, label: 'Safe', fees: null, traders: null, breakdown: null, sanctioned: null }]
  })
  check('a contract wallet whose figures are not shown and one sale of native ETH of no known wallet: the line says neither was checked, in the singular',
    (await checkedLine()) === `${CHECKED} Not checked: 1 sale of native ETH with no known wallet.${HIDDEN}` && await pat.page.getByText('The figures of this wallet are not shown.').isVisible())
  await overviewWith((f) => {
    const [w] = f.wallets
    Object.assign(f, { leftOut: 2, wallets: [w, { ...w, wallet: `0x${'f'.repeat(40)}`, label: 'Second', traders: { ...w.traders, unknown: { trades: 1, volumeUsd: 0, unpriced: 1 } } }] })
  })
  check('wallets linked after the 10 read: the line says their orders were not checked; the sales of no known wallet added up over two partner wallets',
    (await checkedLine()) === `${CHECKED} Not checked: ${P.traders.unknown.trades + 1} sales of native ETH with no known wallet.${HIDDEN}` && await pat.page.getByText('Figures are read for the 10 included wallets linked first. 2 more included wallets are not shown.').isVisible())
  await tradedWith({ wallets: [{ ...tradersList(2)[0], trades: 2, unpriced: 1 }, tradersList(2)[1]], unknown: none, totals: { walletCount: 2, trades: 3, volumeUsd: 3, unpriced: 1 } })
  check('every wallet listed: no line about the largest; one trade not priced: under its volume and in the line, in the singular',
    !(await tradedSection.getByText(/largest wallets/).count()) && await tradedSection.getByText('Volume is priced each night. 1 trade is not priced yet.').isVisible()
    && JSON.stringify((await tradedCells()).map((row) => row[2])) === JSON.stringify(['2.00\n1 trade not priced yet', '1.00']))
  await tradedWith({ wallets: [], unknown: { trades: 2, volumeUsd: 1500, unpriced: 2 }, totals: { walletCount: 0, trades: 2, volumeUsd: 1500, unpriced: 2 } })
  check('only sales of native ETH from no known wallet: the totals, one row for them with its trades not priced yet in the plural, and no line saying nobody traded',
    (await partnerTile('Wallets', tradedSection)) === '0' && (await partnerTile('Trades', tradedSection)) === '2' && JSON.stringify(await tradedCells()) === JSON.stringify([[UNKNOWN_ROW, '2', '1,500.00\n2 trades not priced yet']])
    && !(await tradedSection.getByText('No wallet has traded through your integration yet.').count()))
  await tradedWith({ wallets: [], unknown: none, totals: { walletCount: 0, trades: 0, volumeUsd: 0, unpriced: 0 } })
  check('no wallet has traded yet: one line says so, with no total and no table', await tradedSection.getByText('No wallet has traded through your integration yet.').isVisible() && !(await tradedSection.locator('.stats, table').count()))
  await tradedWith({ daily: [], byChain: [], byToken: [], payouts: [{ date: '2026-12-01', weth: 0.05, chainId: 100, chain: 'Gnosis', tx: null, status: 'proposed' }] }, 'breakdown')
  check('a payout not executed yet: no transaction and no link, "Waiting for signatures"; no trade in 90 days: one line, no chart; no trade at all: no table by chain or token',
    JSON.stringify(await cellsOf(payoutsSection)) === JSON.stringify([['2026-12-01\nGnosis', '0.05', 'Waiting for signatures\nNo transaction yet']]) && !(await payoutsSection.getByRole('link').count())
    && await dailySection.getByText('No trade in the last 90 days.').isVisible() && !(await dailySection.locator('svg[role="img"], table').count()) && !(await pat.page.getByRole('heading', { name: /^By (chain|fee token)$/ }).count()))
  await pat.page.setViewportSize({ width: 390, height: 844 })
  await pat.page.waitForTimeout(200)
  check('at phone width the payout waiting for signatures needs no sideways scroll: its status wraps', await payoutsSection.locator('.table-wrap').evaluate((box) => box.scrollWidth <= box.clientWidth))
  await pat.page.setViewportSize({ width: 1440, height: 900 })
  await tradedWith({ daily: [], byChain: [], byToken: [], payouts: [] }, 'breakdown')
  check('no payout yet: one line says so, with no table', await payoutsSection.getByText('No payout recorded by Ophis.').isVisible() && !(await payoutsSection.locator('table').count()))
  await patOverview()
  await pat.page.getByText('Figures from the Ophis rebate service, read at').waitFor()

  // ---- M10: the OFAC list as a file the console reads (its first read is before the desk) ----
  const lists = operator('list')
  check('"operator list" prints the line of the list, with no warning',
    lists.includes(`LIST  ofac  2 addresses  published 2026-11-09  loaded ${today}  last good read of the list file ${today}  file made ${today}`) && !lists.includes('WARNING') && !lists.includes('FLAG'))
  await listMode('shrunk')
  const held = await operatorSync()
  const heldList = operator('list')
  check('a shrunk file is held: not loaded, with its warning in "sync" and in "list"', held.includes('WARNING  held (shrunk): the list file was not loaded') && heldList.includes('WARNING  held (shrunk)') && heldList.includes('LIST  ofac  2 addresses  published 2026-11-09'))
  await listMode('down')
  check('a list file that cannot be read changes nothing', (await operatorSync()).includes('WARNING  the list file could not be read') && operator('list').includes('WARNING  held (shrunk)'))
  await listMode('ok')
  check('the loaded file again: nothing changes, and nothing is held any more', (await operatorSync()).includes('The list file is the one already loaded.') && !operator('list').includes('WARNING'))
  await pat.page.getByRole('link', { name: 'Desk' }).first().click()
  await pat.page.getByRole('heading', { name: 'Order ticket' }).waitFor()
  check('a partner gets the desk too (owner, 2026-11-19): the ticket and the routes beside it, and the server answers the desk',
    !(await pat.page.getByText('The desk is for institutions.').count()) && await pat.page.getByRole('heading', { name: 'Routes and liquidity' }).isVisible() && (await status('/api/desk', pat.page)) === 200 && await both(pat.page, '51-desk-partner'))

  // A partner with no linked wallet (the plain seed).
  const nell = await firstOwner(seeded().match(/http\S+\/#\/enrol\/\S+/)[0])
  await nell.page.getByRole('heading', { name: 'Your flow, in one view.' }).waitFor()
  const noWallet = nell.page.locator('[data-state="no_wallet"]')
  await noWallet.waitFor()
  check('a partner with no reporting wallet: a link to Organisation, and no figure',
    await noWallet.getByText('No wallet is included in partner reporting.').isVisible() && (await noWallet.getByRole('link', { name: 'Link a wallet under Organisation' }).getAttribute('href')) === '/#/organisation'
    && !(await nell.page.locator('.stats').count()) && !(await nell.page.getByText(BANNER).count()) && await both(nell.page, '55-overview-partner-no-wallet'))
  await nell.context.close()

  // Not connected: the same server without the indexer's address. The session survives the restart (it is a row).
  await stopServer()
  server = serve('--var', 'INDEXER_URL:off')
  for (let i = 0; i < 60 && !(await reachable()); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  await patOverview()
  const notConnected = pat.page.locator('[data-state="not_connected"]')
  await notConnected.waitFor({ timeout: 15_000 })
  check('without the indexer\'s address: "Your figures are not connected yet", a link to Support, and no figure',
    await notConnected.getByText('Your figures are not connected yet.').isVisible() && (await notConnected.getByRole('link', { name: 'Ask Support' }).getAttribute('href')) === '/#/support'
    && !(await pat.page.locator('.stats').count()) && await both(pat.page, '56-overview-partner-not-connected'))
  await pat.context.close()

  if (violations.length) console.error(violations.join("\n"))
  check(`no policy violation in the browser (${violations.length})`, violations.length === 0)
  check(`no request left the origin (${foreign.length})`, foreign.length === 0)
  console.log('\nEnd-to-end run passed. Screenshots in .shots/: 01-signin to 72-desk-withdrawn')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  stopIndexer()
  stopLists()
  stopTurnstile()
  await stopOrderbook()
  await browser?.close()
  await stopServer()
}
