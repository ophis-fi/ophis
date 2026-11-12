// End-to-end proof in the installed Google Chrome, headless, with Chrome's virtual authenticators
// (DevTools protocol). Milestone 1: seed, enrol, activate, sign in, see the Organisation page, end the
// session. Milestone 2: the Owner adds a second key and invites a Viewer; the Viewer enrols in a second
// browser context with its own authenticator and reads three words; the Owner types them; the Viewer signs
// in. Then the Viewer is re-enrolled from a third context, and the Viewer's old passkey stops that.
// Milestone 3: a second Owner and an Admin join (the Admin with the second Owner as second person), two people
// unfreeze the Viewer, the Admin asks for a role change, an Owner approves it, the audit page shows the rows and
// "Chain verified", and the export downloads.
// Milestone 4: an Owner asks to link a wallet; the wallet (a test key behind a fake injected provider, no network)
// signs on the signing page, which lives on its own hostname; the second Owner approves the link, then the wallet
// as recovery wallet; the Security page shows the readiness state; unlinking the recovery wallet is refused.
// Milestone 4b: somebody asks for a recovery on the public page /recover and reads three words; the recovery wallet
// signs on the signing page; a member sees the banner and an Owner cancels; a second request waits (the local "skip"
// command stands in for the waits), is completed with the new passkey, and an old Owner passkey stops it; the
// recovery sheet prints alone.
// Milestone 6: the Owner opens Support, asks a question, reads a help text, presses "No" and gets the hand-over card.
// Milestone 5b: the declaration prints alone; a scan with a marker is sealed in the browser and uploaded; the stored
// object is sealed; the operator's command takes it for a reason, and the local test identity opens it: the original.
// Milestone 5a: an application, its DNS proof, the activation by the recovery wallet, the review and the operator's approval.
// Company sign-in: the applicant Owner sets Microsoft on the Onboarding page by signing in at the local stand-in provider
// (scripts/idp-stub.mjs), invites a member by work address, the member signs in there and creates a passkey, the Owner approves.
// Starts and stops its own local server on a throwaway database. Run: pnpm test:e2e
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { Decrypter } from 'age-encryption' // milestone 5b: opens the downloaded file with the local test identity, as the operator would offline
import { chromium } from 'playwright-core'
import { mnemonicToAccount } from 'viem/accounts'
import { publish as publishTxt, start as startDnsStubs } from '../scripts/dns-stub.mjs' // milestone 5: the two local resolvers of "Check DNS"
import { start as startIdp } from '../scripts/idp-stub.mjs' // company sign-in: the local stand-in for Microsoft and Google
import { CONTRACT, PORT as INDEXER_PORT, start as startIndexer } from '../scripts/indexer-stub.mjs' // partner figures: the local stand-in for the rebate indexer

process.chdir(new URL('..', import.meta.url).pathname)
const ORIGIN = 'http://localhost:8787'
const SIGN = 'http://127.0.0.1:8787' // the signing page's own hostname
const IDP = 'http://127.0.0.1:8792' // the stand-in provider of the local environment
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

const stopDnsStubs = startDnsStubs() // ports 8790 and 8791
const stopIdp = startIdp() // port 8792
const stopIndexer = startIndexer() // port 8793
// detached: the server gets its own process group, so the whole group can be stopped at the end.
const server = spawn('node_modules/.bin/wrangler', ['dev', '--persist-to', STATE, '--port', PORT], { env, detached: true, stdio: 'ignore' })
let browser
try {
  for (let i = 0; i < 60 && !(await reachable()); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  check('the local server answers', await reachable())

  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: PORT === '8787' ? [] : [`--host-resolver-rules=MAP localhost:8787 127.0.0.1:${PORT}, MAP 127.0.0.1:8787 127.0.0.1:${PORT}`] })
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
    page.on('request', (request) => request.url().startsWith(`${ORIGIN}/`) || request.url().startsWith(`${IDP}/`) || foreign.push(request.url())) // the company sign-in goes to the provider and back
    return { context, page, devtools, authenticatorId }
  }
  const FOOTER = 'Ophis is a software provider. It is not a crypto-asset service provider.'
  const { context, page, devtools, authenticatorId } = await person()
  const status = (path, on = page) => on.evaluate((url) => fetch(url).then((response) => response.status), path)
  const sessionCookie = async () => (await context.cookies()).find((c) => c.name === '__Host-session')

  const first = await page.goto(ORIGIN)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor()
  const headers = first.headers()
  check('the page carries the strict policy', ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"].every((part) => headers['content-security-policy']?.includes(part)))
  check('the page carries the other security headers', headers['x-content-type-options'] === 'nosniff' && headers['referrer-policy'] === 'no-referrer' && headers['cross-origin-resource-policy'] === 'same-origin' && headers['x-frame-options'] === 'DENY')
  check('the footer line is on the sign-in page', await page.getByText(FOOTER).isVisible())
  check('the sign-in page has no username or password field', (await page.locator('input').count()) === 0)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: '.shots/01-signin.png' })

  await page.goto(link)
  await page.getByRole('button', { name: 'Create passkey' }).waitFor()
  check('the ticket left the address bar', (await page.evaluate(() => location.hash)) === '#/enrol')
  check('the enrolment page names the organisation and the site', await page.getByText('Northwind Vaults').first().isVisible() && await page.locator('dd.site', { hasText: 'localhost:8787' }).isVisible())
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await page.getByRole('heading', { name: 'Send these three words to your colleague.' }).waitFor()
  check('a real browser enrolled a passkey and shows three words', (await page.locator('.phrase span').count()) === 3)

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
  check('after sign-in an active organisation lands on Overview, with the demo banner and the footer line',
    await page.getByText('Demo data. No order is sent and no funds move. Figures are examples.').isVisible() && await page.getByText(FOOTER).isVisible() && (await page.evaluate(() => location.hash)) !== '#/organisation')
  await toOrganisation(page)
  await page.getByRole('button', { name: 'End session' }).waitFor()
  check('the Organisation page shows the member, the passkey and the session',
    await page.getByRole('cell', { name: 'Maren Okafor' }).first().isVisible() && await page.getByText('1: Security key 1').isVisible() && await page.getByText('This session').isVisible())
  let cookie = await sessionCookie()
  check('the session cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/', Boolean(cookie) && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/' && cookie.domain === 'localhost')
  check('scripts cannot read the session cookie', !(await page.evaluate(() => document.cookie)).includes('session'))
  check('the footer line is on the Organisation page', await page.getByText(FOOTER).isVisible())
  await page.screenshot({ path: '.shots/02-organisation.png', fullPage: true })

  await page.getByRole('link', { name: 'Security and data' }).first().click()
  await page.getByRole('heading', { name: 'What we store, and what we never hold.' }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: 'What we store, and what we never hold.' }).waitFor()
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
  // The member's side of the ceremony, on their own device: open the link, create the passkey, read the words.
  async function enrolAt(link, who, label) {
    await who.page.goto(link)
    if (label) await who.page.getByLabel('Name for this key (no personal data)').fill(label)
    await who.page.getByRole('button', { name: 'Create passkey' }).click()
    await who.page.getByRole('heading', { name: 'Send these three words to your colleague.' }).waitFor()
    return who.page.locator('.phrase span').allTextContents()
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
  async function typeWords(words, name, on = page) {
    await on.getByLabel(`Three words from ${name}`).fill(words.join(' '))
    await on.getByRole('button', { name: 'Confirm with passkey' }).click()
  }

  check('an Owner with one key is asked for the second and cannot invite yet',
    await page.getByText('Add your second hardware key.').isVisible() && (await page.getByRole('button', { name: 'Invite member' }).count()) === 0)
  // The first key goes back in the drawer; a second security key is plugged in.
  await devtools.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
  await devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  await page.getByRole('button', { name: 'Invite member' }).waitFor()
  check('the Owner added a second hardware key and may now invite', await page.getByText('2: Security key 1, Security key 2').isVisible() && (await page.getByText('Add your second hardware key.').count()) === 0)

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
  const words = await enrolAt(invitation, viewer)
  check('the Viewer enrolled on their own device and sees three words, large, with what to do with them',
    words.length === 3 && words.every((word) => /^[a-z-]{3,10}$/.test(word)) && await viewer.page.getByText('Send these words to the colleague who invited you, over a channel you both trust').isVisible()
    && (await viewer.page.locator('.phrase').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))) >= 34)
  check('the footer line is on the three-word page', await viewer.page.getByText(FOOTER).isVisible())
  check('the three-word page fits a phone', await both(viewer.page, '03-three-words'))

  await organisation()
  check('the Owner is told at the door that a passkey waits for the words', await readAlerts('A new passkey of Ada Viewer waits for you'))
  await page.getByRole('heading', { name: 'Waiting for confirmation' }).waitFor()
  const ownerText = (await page.locator('body').innerText()).toLowerCase().split(/[^a-z-]+/)
  check('the Owner\'s screen does not show the three words', !words.every((word) => ownerText.includes(word)))
  await page.screenshot({ path: '.shots/04-waiting.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '.shots/08-waiting-phone.png', fullPage: true })
  check('at phone width the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.setViewportSize({ width: 1440, height: 900 })
  await typeWords(words[0] === 'aardvark' ? ['zucchini', 'zoology', 'zipfile'] : ['aardvark', 'abandoned', 'abbreviate'], 'Ada Viewer')
  await page.getByText('Those are not the words. 2 tries left.').waitFor()
  check('wrong words are refused and counted', (await status('/api/me', viewer.page)) === 401)
  await typeWords(words, 'Ada Viewer')
  await page.getByRole('button', { name: 'Re-enrol Ada Viewer' }).waitFor()
  check('the Owner typed the words: the Viewer is active', (await page.getByRole('heading', { name: 'Waiting for confirmation' }).count()) === 0)

  await viewer.page.getByRole('link', { name: 'Go to sign-in' }).click()
  await viewer.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await toOrganisation(viewer.page)
  await viewer.page.getByRole('button', { name: 'End session' }).waitFor()
  check('the Viewer signs in and sees only their own seat', (await viewer.page.getByRole('cell', { name: 'Maren Okafor' }).count()) === 0 && await viewer.page.getByRole('cell', { name: 'Ada Viewer' }).first().isVisible()
    && (await viewer.page.getByRole('button', { name: 'Invite member' }).count()) === 0)

  // Re-enrolment: someone with a third device gets the Viewer's seat a new passkey, and the Owner is talked into the words.
  const second = await issue(() => page.getByRole('button', { name: 'Re-enrol Ada Viewer' }).click())
  const replacement = await person()
  await replacement.page.goto(second)
  await replacement.page.getByRole('button', { name: 'Create passkey' }).click()
  await replacement.page.getByText('This seat already has a passkey with that name.').waitFor()
  check('a second passkey with the same name on one seat is refused', (await replacement.page.locator('.phrase').count()) === 0)
  const newWords = await enrolAt(second, replacement, 'Replacement key')
  await organisation()
  await readAlerts('A new passkey of Ada Viewer waits for you')
  await typeWords(newWords, 'Ada Viewer')
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
    (await status('/api/me', viewer.page)) === 401 && await viewer.page.getByText(FOOTER).isVisible() && (await viewer.page.getByRole('button', { name: /Stop|Back/ }).count()) === 2)
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
    && (await status('/api/me', viewer.page)) === 401 && await viewer.page.getByText(FOOTER).isVisible() && await both(viewer.page, '11-frozen'))
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
    await who.page.getByRole('button', { name: 'Add a passkey' }).click()
    await who.page.getByRole('button', { name: 'Invite member' }).waitFor()
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
  const boWords = await enrolAt(await invite('Bo Owner', 'owner'), bo)
  await arrive(owner, false)
  await typeWords(boWords, 'Bo Owner')
  await page.getByText('a 72 hour wait stands in for the second person').waitFor()
  check('with no other key-role member, the second Owner waits 72 hours', (await status('/api/me', bo.page)) === 401)
  check('the activate command stood in for the wait', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
  await arrive(bo)
  await secondKey(bo)

  // An Admin, through the full ceremony: the first Owner types the words, then the second Owner does.
  const cy = await person()
  const cyWords = await enrolAt(await invite('Cy Admin', 'admin'), cy)
  await arrive(owner, false)
  await typeWords(cyWords, 'Cy Admin')
  await page.getByText('Waiting for a second person with a key role').waitFor()
  check('after the first Owner\'s words the Admin still cannot sign in', (await status('/api/me', cy.page)) === 401)
  await arrive(bo, false)
  await typeWords(cyWords, 'Cy Admin', bo.page)
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
  await bo.page.getByText('Nothing waits.').waitFor()
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
  await page.getByText('Nothing waits.').waitFor()
  check('the Owner approved it: the Viewer is a Trader', await page.getByRole('row', { name: /Ada Viewer.*Trader/ }).first().isVisible())
  check('"What each role can do" is on the page, from the server\'s table', await page.getByRole('heading', { name: 'What each role can do' }).isVisible() && await page.getByRole('cell', { name: 'Export the audit log' }).isVisible())

  // The audit log: rows in plain words, the chain state, and the export.
  await page.getByRole('link', { name: 'Compliance' }).first().click()
  await page.getByRole('heading', { name: 'Records and the audit trail.' }).waitFor()
  await page.getByText('Chain verified').waitFor()
  check('the audit page shows the rows in plain words and "Chain verified"',
    await page.getByRole('row', { name: /Bo Owner.*Role changed: Viewer to Trader.*Ada Viewer/ }).isVisible() || await page.getByRole('row', { name: /Maren Okafor.*Role changed: Viewer to Trader.*Ada Viewer/ }).isVisible())
  check('the request and the freeze are there too, and no raw code', await page.getByRole('row', { name: /Cy Admin.*Change requested: change a role.*Ada Viewer/ }).isVisible()
    && await page.getByRole('cell', { name: 'Seat unfrozen' }).isVisible() && !/session\.create|seat\.role|approval\./.test(await page.locator('main').innerText()))
  check('the audit page carries the footer line and fits a phone', await page.getByText(FOOTER).isVisible() && await both(page, '14-audit'))
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
  const csv = readFileSync(await download.path(), 'utf8')
  check('the export downloads: every row with both hashes, the export itself last',
    /^ophis-audit-log-\d{4}-\d\d-\d\d\.csv$/.test(download.suggestedFilename()) && csv.startsWith('"No.","Time (UTC)","Who","Event","Target","Previous row hash","Row hash"\r\n')
    && csv.includes('"Role changed: Viewer to Trader","Ada Viewer"') && /"Maren Okafor","Audit log exported","","[0-9a-f]{64}","[0-9a-f]{64}"\r\n$/.test(csv))
  await page.getByRole('cell', { name: 'Audit log exported' }).waitFor()
  check('the export is a row of the log', await page.getByText('Chain verified').isVisible())
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
  check('the signing page carries its own policy and may be framed by the Safe interface only',
    policy === "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors https://app.safe.global https://*.safe.global" && !opened.headers()['x-frame-options'])
  await signing.evaluate(() => document.fonts.ready)
  check('the signing page shows the black logo of the console and the brand font, both from its own folder',
    await signing.evaluate(() => { const logo = document.querySelector('.brand img'); return logo.naturalWidth > 0 && new URL(logo.src).pathname.startsWith('/sign/assets/ophis-icon-mono-dark') })
      && await signing.evaluate(() => [...document.fonts].some((font) => font.family.includes('Ophis Inter') && font.status === 'loaded'))
      && fonts.length > 0 && fonts.every((url) => url.startsWith(`${SIGN}/sign/assets/Inter-`)))
  const shown = await signing.locator('dl.kv').innerText()
  check('it shows the action, the site, the organisation id, the chain, the wallet and the expiry as text',
    ['Link this wallet to this organisation', 'localhost', 'OP Mainnet (chain id 10)', key.address, 'UTC'].every((text) => shown.includes(text)) && /[0-9a-f]{32}/.test(shown))
  check('the signing page carries the footer line and fits a phone', await signing.getByText(FOOTER).isVisible() && await both(signing, '16-signing-page'))
  const at = (url, on) => on.evaluate((target) => fetch(target).then((response) => response.status, () => 0), url)
  check('the signing host serves no console page and no console route; the console host serves no signing page',
    (await at('/', signing)) === 404 && (await at('/api/me', signing)) === 404 && (await at('/assets/', signing)) === 404 && (await status('/sign/')) === 404 && (await status('/sign/manifest.json')) === 404)
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
  await bo.page.getByText('Nothing waits.').waitFor()
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
  await bo.page.getByText('Nothing waits.').waitFor()
  check('the wallet carries the "Recovery wallet" badge with the date it is in force, and an Owner can still cancel',
    await bo.page.getByRole('row', { name: /Custody wallet.*Linked.*Recovery wallet.*In force from \d{4}-\d\d-\d\d \d\d:\d\d UTC/ }).isVisible()
      && await bo.page.locator('#wallets .table-wrap').evaluate((wrap) => wrap.scrollWidth <= wrap.clientWidth) // at 1440 the whole row shows, Manage included
      && await both(bo.page, '20-wallets', '#wallets'))

  // The Security page, for an Owner: readiness, read on demand.
  await arrive(owner, false)
  await page.goto(`${ORIGIN}/#/security`)
  await page.getByRole('heading', { name: 'Recovery readiness' }).waitFor()
  const readiness = await page.locator('#readiness').innerText()
  check('the Security page shows the readiness state: two Owners with two hardware keys are Ready, and a recovery wallet that still waits is amber and says so',
    ['Ready', '2 Owners, each with two hardware keys.', 'Amber', 'Custody wallet is in force from', 'Until then it does not count.'].every((text) => readiness.includes(text)) && await both(page, '21-readiness'))
  check('an Admin gets no readiness block', (await status('/api/readiness', cy.page)) === 403)

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
    await on.getByRole('button', { name: 'Sign with the wallet in this browser' }).click()
    await on.getByRole('status').filter({ hasText: /Signed and checked|Refused/ }).waitFor()
    const after = await on.locator('main').innerText()
    if (shot) await both(on, `${shot}-done`)
    await context.close()
    return { before, after, asked: asked.join(), fits }
  }
  // The requester: somebody the console does not know, on the public page, with a new security key.
  async function ask(shot) {
    const who = await person()
    const opened = await who.page.goto(`${ORIGIN}/recover`)
    await who.page.getByRole('heading', { name: 'Start a recovery' }).waitFor()
    const open = opened.status() === 200 && (await who.context.cookies()).length === 0 && await who.page.getByText(FOOTER).isVisible()
      && await who.page.getByText('Nothing is stored until the recovery wallet has signed.').isVisible() && (!shot || await both(who.page, shot))
    await who.page.getByLabel('Organisation id, from the recovery sheet').fill(organisationId)
    await who.page.getByRole('button', { name: 'Create the passkey and the signing link' }).click()
    await who.page.getByRole('heading', { name: 'Read these three words to the signers of the recovery wallet.' }).waitFor()
    return { ...who, open, words: (await who.page.locator('.phrase span').allInnerTexts()).join(' '), link: await who.page.getByLabel(/^Signing link/).inputValue() }
  }
  const resume = async (who) => {
    await who.page.goto(`${ORIGIN}/recover`)
    await who.page.getByRole('button', { name: 'Continue with the new passkey' }).click()
  }
  const lost = await ask('22-recover')
  check('/recover is public: no session, the footer line, each button preceded by what it does, and it fits a phone', lost.open)
  check('the requester gets three words and a link to the signing page, and is told to read the words to the signers',
    lost.words.split(' ').length === 3 && lost.link.startsWith(`${SIGN}/sign/#`) && await lost.page.getByText('Read the words aloud, face to face or on a call.').isVisible() && await both(lost.page, '23-recover-words'))
  check('nothing is stored and no member sees anything before the wallet signs', !(await page.evaluate(() => fetch('/api/me').then((response) => response.json()).then((me) => me.alerts.some((alert) => alert.kind.startsWith('recovery'))))))
  const signed = await sign(lost.link, '24-recovery-signing')
  check('the signing page shows the Proof fields as text, the three words among them, and names no wallet before the wallet answers',
    ['Restore access to an organisation.', 'Replace all Owner passkeys of this organisation', 'localhost', organisationId, lost.words, 'The wallet that signs', 'New passkey (hash)', 'Request number (nonce)'].every((text) => signed.before.includes(text)) && signed.fits)
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

  // The recovery sheet, for an Owner: on the Security page, and alone on paper.
  await page.goto(`${ORIGIN}/#/security`)
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

  // Milestone 6: Support. A question, the help text the server selected, "No" until the hand-over card. With no
  // TYPESAFE_API_KEY in .dev.vars the server answers the hand-over at once, and only that path is checked.
  // With the key this part needs the network: the Worker asks the provider, the browser never does.
  const withKey = /^TYPESAFE_API_KEY=.+/m.test(readFileSync('.dev.vars', 'utf8'))
  await page.locator('.rail').getByRole('link', { name: 'Support' }).click()
  await page.getByRole('heading', { name: /Ask a question/ }).waitFor()
  check('the band at the top reads "Local build. Test data only." and nothing else', (await page.locator('.band').innerText()).trim() === 'Local build. Test data only.')
  check('Support opens from the rail and from the top button, with the provider notice under the box and the footer line',
    (await page.locator('[data-support]').getAttribute('href')) === '/#/support' && await page.getByText(FOOTER).isVisible() && await page.getByText('Leave out names and anything secret.').isVisible()
    && await page.getByText('An outside provider, TypeSafe AI (USA), matches your question to our help texts. It receives your question without your name, organisation or wallet. Ophis does not store your question.').isVisible())
  const write = page.getByRole('link', { name: 'Write to Ophis' })
  // A wallet recovery phrase (a public test vector) is refused by the server and the page says so; nothing is asked of the provider.
  await page.getByLabel('Your question').fill('legal winner thank year wave sausage worth useful legal winner thank yellow')
  await page.getByRole('button', { name: 'Ask' }).click()
  check('a recovery phrase typed into the box is refused, and the page says that it was not passed on',
    await page.getByText('This looks like a wallet recovery phrase (seed phrase): 12 or more of its words in a row. It was not passed on and not stored.').waitFor({ timeout: 5000 }).then(() => true, () => false) && !(await write.count()))
  await page.getByLabel('Your question').fill('How do I add a second passkey?')
  await page.getByRole('button', { name: 'Ask' }).click()
  await page.getByText('Did this answer your question?').or(write).first().waitFor({ timeout: 10000 })
  if (withKey) {
    check('a question gets a help text of the answer base', await page.getByRole('heading', { name: 'Add a second passkey' }).isVisible())
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
  // A company applies on /apply and proves its domain by DNS (the two local stub resolvers); the applicant signs in,
  // adds the second passkey and names the recovery wallet, which signs the activation on the signing page; the Owner
  // submits; the operator approves through its command; the organisation is active and the KYB record shows.
  const applicant = await person()
  const on = applicant.page
  const domain = `e2e-${Date.now().toString(36)}.example`
  const operator = (...args) => run('node', ['scripts/operator.mjs', ...args])
  const refusedBy = (command) => { try { command(); return '' } catch (error) { return String(error.stderr ?? '') } } // what a refused command printed
  const code = operator('invite').trim().split('\n').pop() // G1: applications are by invitation
  check('the operator command issues an application code', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(code))
  await on.goto(`${ORIGIN}/apply`)
  await on.getByLabel('Application code, from Ophis').fill(code)
  await on.getByLabel('Legal name of the company').fill('Alder Custody S.A.')
  await on.getByLabel('Country, two-letter code').fill('LU')
  await on.getByLabel('Registration number or LEI').fill('B123456')
  await on.getByLabel('The company is a').selectOption('institution')
  await on.getByLabel('Email domain of the company').fill(domain)
  await on.getByLabel('Your work email, at that domain').fill(`ops@${domain}`)
  await on.getByLabel('Your name').fill('Ada Applicant')
  check('the application page carries the footer line and says nothing is stored yet', await on.getByText(FOOTER).isVisible() && await on.getByText('Nothing is stored until that record is found.').isVisible())
  await on.getByRole('button', { name: 'Create the passkey and the DNS record' }).click()
  await on.getByRole('heading', { name: 'Ask your DNS administrator to publish this record.' }).waitFor()
  const [, recordName, recordValue] = await on.locator('dl.kv dd').allInnerTexts()
  check('the record is a TXT at _ophis-verify.<domain> with a short code', recordName === `_ophis-verify.${domain}` && /^ophis-verify=[A-Za-z0-9_-]{20}$/.test(recordValue) && await both(on, '32-apply-record'))
  check('the page offers a link to come back, with the application in the fragment', (await on.getByLabel(/Link to come back/).inputValue()).startsWith(`${ORIGIN}/apply#`))
  await on.getByRole('button', { name: 'Check DNS' }).click()
  await on.getByText('The record is not there yet on both resolvers').waitFor()
  check('before the record is published the check is refused', await on.getByRole('button', { name: 'Check DNS' }).isVisible())
  // A reload keeps the application (this browser remembers it), and shows the record again.
  await on.reload()
  await on.getByText(recordValue).waitFor()
  publishTxt(recordName, recordValue) // what the company's DNS administrator does
  await on.getByRole('button', { name: 'Check DNS' }).click()
  await on.getByRole('heading', { name: 'The domain is proved and the organisation exists.' }).waitFor()
  await on.getByRole('link', { name: 'Sign in' }).last().click()
  await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await on.getByRole('heading', { name: /From application to a verified organisation|Read this before you continue/ }).waitFor()
  if (await on.getByRole('button', { name: 'I have read this' }).count()) await on.getByRole('button', { name: 'I have read this' }).click()
  await on.getByRole('heading', { name: 'From application to a verified organisation.' }).waitFor()
  const newOrg = await on.evaluate(() => fetch('/api/me').then((response) => response.json()).then((me) => me.organisation))
  check('the applicant signs in to an organisation that is not yet verified, and lands on Onboarding', newOrg.state === 'unverified' && newOrg.name === 'Alder Custody S.A.' && await on.getByText('Not submitted.').isVisible())
  check('an unverified organisation does not reach the audit log', (await status('/api/audit', on)) === 403)
  check('its menu shows Overview and Desk switched off', await on.getByRole('button', { name: 'Overview', exact: true }).isDisabled() && await on.getByRole('button', { name: 'Desk', exact: true }).isDisabled())
  await arrive(applicant, false)
  await secondKey(applicant)
  await on.goto(`${ORIGIN}/#/onboarding`)
  await on.reload()
  // Company sign-in (C1): the Owner chooses Microsoft on the Onboarding page and signs in once with the own company account, at the local stand-in.
  await on.getByRole('button', { name: 'Continue with Microsoft' }).click()
  await on.getByRole('heading', { name: 'Local stand-in for Microsoft sign-in' }).waitFor()
  check('the Owner is sent to the provider (locally: the stand-in), with nothing of the flow but the state, the nonce and the PKCE challenge in the address',
    on.url().startsWith(`${IDP}/microsoft/authorize?`) && ['state', 'nonce', 'code_challenge'].every((name) => new URL(on.url()).searchParams.get(name)) && !on.url().includes('verifier'))
  await on.getByLabel('Work address').fill(`ops@${domain}`)
  await on.getByRole('button', { name: 'Sign in as this address' }).click()
  await on.getByText('The company sign-in is set, and your company account is linked to your seat.').waitFor()
  const address = await on.evaluate(() => location.search + location.hash)
  check(`the outcome word left the address bar (${address})`, address === '#/onboarding')
  await on.getByText('Microsoft: members you invite sign in once with their company account').waitFor()
  check('a step that is done offers a change, not a "Continue"', await on.getByRole('button', { name: 'Change to Google' }).isVisible() && await on.getByRole('button', { name: 'Change to none: three words' }).isVisible() && (await on.getByRole('button', { name: /^Continue with/ }).count()) === 0)
  check('back on the Onboarding page the company sign-in is Microsoft, pinned to the tenant', await on.getByText('Your own company account is linked to your seat.').isVisible() && await both(on, '37-company-signin-step'))
  await on.getByLabel('Wallet address').fill(key.address)
  await on.getByLabel('Chain').selectOption({ label: 'OP Mainnet' })
  await on.getByLabel('A name for it').fill('Treasury')
  const firstWords = (await on.locator('.phrase span').allInnerTexts()).join(' ')
  await on.getByRole('button', { name: 'Create the signing link' }).click()
  const activationLink = await on.getByLabel(/Signing link/).inputValue()
  check('the Onboarding page gives a signing link on the signing host and three words', activationLink.startsWith(`${SIGN}/sign/#`) && firstWords.split(' ').length === 3 && await both(on, '33-onboarding'))
  const activated = await sign(activationLink, '34-activation-sign')
  check('the signing page shows the fourth action, the organisation id and the same three words, and the wallet signs',
    activated.before.includes('Activate this organisation and confirm its first Owner passkey') && activated.before.includes('First Owner passkey (hash)') && !activated.before.includes('New passkey (hash)') && activated.before.includes(newOrg.id) && activated.before.includes(firstWords) && activated.before.includes(key.address)
    && activated.after.includes('Signed and checked. The wallet is stored') && activated.asked.includes('eth_signTypedData_v4') && activated.fits)
  await on.getByRole('button', { name: 'The wallet has signed' }).click()
  await on.getByText('It signed the activation.').waitFor()
  // Milestone 5b: the declaration, printed alone; the signed scan, sealed in this browser; the Worker keeps it sealed.
  check('without the sealed declaration "Submit for review" is closed, and the page says why', await on.getByRole('button', { name: 'Submit for review' }).isDisabled() && await on.getByText('The signed declaration is still missing.').isVisible())
  const paper = on.locator('article.sheet')
  const paperText = await paper.innerText()
  check('the declaration holds the server\'s values, a line for the signatory and the sentence that the signatory may bind the company; nothing on it can be typed',
    ['Alder Custody S.A.', domain, key.address, 'OP Mainnet', 'Microsoft', 'Name of the signatory', 'Role', 'Date', 'Signature', 'the undersigned may bind the company', FOOTER].every((text) => paperText.includes(text))
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
  check('the page names the key it seals to', await on.getByText(/Sealed to key [0-9a-f]{64}/).isVisible())
  await on.getByLabel(/Signed scan/).setInputFiles({ name: 'declaration.pdf', mimeType: 'application/pdf', buffer: scan })
  await on.getByRole('button', { name: 'Seal and upload' }).click()
  await on.getByText('Uploaded on').waitFor({ timeout: 15000 }).catch(async () => check(`the sealed file was uploaded (the page says: ${(await on.locator('[role=alert]').allInnerTexts()).join(' ')})`, false))
  const stepText = await on.locator('.srow', { hasText: 'Uploaded on' }).innerText()
  const shownSha = /SHA-256 of the sealed file\s+([0-9a-f]{64})/.exec(stepText)?.[1]
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  // The local R2 simulation keeps each object as one file under the state folder.
  const stored = readdirSync(STATE, { recursive: true }).filter((name) => /r2.*blobs.[^/\\]+$/.test(name)).map((name) => readFileSync(`${STATE}/${name}`))
  check('what left the browser is the sealed file: the age header, no marker, and neither the name nor the type of the clear file', sent.length === 1 && sent[0].subarray(0, 22).toString('latin1') === 'age-encryption.org/v1\n' && !sent[0].includes(MARKER)
    && around.length === 1 && !/declaration\.pdf|application\/pdf/i.test(around[0] + sent[0].toString('latin1')))
  check('the stored object is that sealed file: it starts with the age header, it does not hold the marker, and the step shows its date, size and SHA-256',
    stored.length === 1 && stored[0].subarray(0, 22).toString('latin1') === 'age-encryption.org/v1\n' && !stored[0].includes(MARKER) && stored[0].equals(sent[0])
      && sha256(stored[0]) === shownSha && stepText.includes(`${stored[0].length.toLocaleString('en-GB')} bytes, sealed`) && await both(on, '43-declaration-step', '.srow:has-text("Uploaded on")'))
  // Review of 5b: an uploaded declaration reads as done, and the Owner is told what a second upload does.
  check('once uploaded the step says Done, and that a new upload replaces the file and needs a new submit', /Declaration\s+Done/.test(stepText) && await on.getByText('A new upload replaces this file. If the organisation is under review, submit it again.').isVisible())
  await on.getByRole('button', { name: 'Submit for review' }).click()
  await on.getByText('Under review since').waitFor()
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
  check('the operator command lists the organisation with its domain, the three words and the wallet', listed.includes(newOrg.id) && listed.includes(domain) && listed.includes(firstWords) && listed.includes(key.address) && listed.includes('ready           yes'))
  const submission = /submission ([0-9a-f]{16}) /.exec(listed)?.[1] ?? ''
  check('an approval that names no submission, or another one, is refused', refusedBy(() => operator('decide', newOrg.id, 'approve', '--submission', '0'.repeat(16), '--tier', 'standard', '--source', 'registry', '--evidence', 'e2e register extract', '--sha256', 'ab'.repeat(32), '--next-review', '2030-01-01')).includes('submitted again since that list'))
  check('the operator approves', operator('decide', newOrg.id, 'approve', '--submission', submission, '--tier', 'standard', '--source', 'registry', '--evidence', 'e2e register extract', '--sha256', 'ab'.repeat(32), '--next-review', '2030-01-01').includes(`${newOrg.id} is now active`))
  check('nothing is left under review', operator('list').includes('Nothing is under review.'))
  await on.reload()
  await on.getByText('Verified on').waitFor()
  check('the organisation is active and the Onboarding page says so, with the next review', await on.getByText('Next review 2030-01-01').isVisible() && await on.getByText('It is the recovery wallet in force.').isVisible() && (await status('/api/audit', on)) === 200)
  check('once active the declaration stays: the step shows it and offers no upload', await on.getByText('Uploaded on').isVisible() && (await on.getByLabel(/Signed scan/).count()) === 0 && (await on.locator('article.sheet').count()) === 0)
  await on.goto(`${ORIGIN}/#/compliance`)
  await on.reload()
  await on.getByRole('heading', { name: 'KYB record' }).waitFor()
  check('the Compliance page shows the KYB record and the operator\'s row in the audit log',
    await on.getByText('The one document stored is the signed declaration, sealed in your browser.').isVisible() && await on.locator('dl.kv dd', { hasText: 'Alder Custody S.A.' }).isVisible() && await on.locator('dl.kv dd', { hasText: 'Approved' }).isVisible()
    && await on.locator('dl.kv dd', { hasText: 'ab'.repeat(32) }).isVisible() && await on.getByText('Ophis operator: verification approved, organisation active').isVisible() && await both(on, '35-kyb-record', '#root dl.kv >> nth=0'))
  check('the KYB block lists the sealed declaration and the operator\'s download with its reason; the audit log has the row',
    await on.locator('dl.kv dd', { hasText: shownSha }).isVisible() && await on.getByText('still sealed, for the review of the organisation.').isVisible() && (await on.getByText(/still sealed, for/).count()) === 1
      && await on.getByText('Ophis operator: downloaded the sealed declaration, still sealed. Reason: the review of the organisation').isVisible() && await both(on, '44-kyb-sealed', '#root dl.kv >> nth=1'))
  check('the footer line is on the Onboarding and Compliance pages', await on.getByText(FOOTER).isVisible())
  // Company sign-in (C2): the Owner invites a member by work address. The member signs in at the provider, creates the
  // passkey, and the Owner approves with a passkey check. No words are shown or typed.
  await on.goto(`${ORIGIN}/#/organisation`)
  await on.reload()
  await on.getByRole('button', { name: 'Invite member' }).click()
  await on.getByLabel('Name shown to colleagues').fill('Cora Company')
  await on.getByLabel('Role').selectOption('viewer')
  await on.getByLabel(`Work email at ${domain}`).fill(`cora@${domain}`)
  check('the invite dialog asks for the work address and says that no words are read or typed', await on.getByText('The member signs in once with this Microsoft company account.').isVisible() && await both(on, '38-invite-company'))
  await on.getByRole('button', { name: 'Create the link' }).click()
  const companyLink = await on.getByLabel('Enrolment link').inputValue()
  await on.getByRole('button', { name: 'Done' }).click()
  const cora = await person()
  await cora.page.goto(companyLink)
  await cora.page.getByRole('button', { name: 'Continue with Microsoft' }).waitFor()
  check('the member\'s page asks for the company account first: no passkey button yet, and the footer line', (await cora.page.getByRole('button', { name: 'Create passkey' }).count()) === 0
    && await cora.page.getByText(`cora@${domain}, at Microsoft`).isVisible() && await cora.page.getByText(FOOTER).isVisible() && await both(cora.page, '39-company-first'))
  await cora.page.getByRole('button', { name: 'Continue with Microsoft' }).click()
  await cora.page.getByRole('heading', { name: 'Local stand-in for Microsoft sign-in' }).waitFor()
  check('the stand-in shows the invited address', (await cora.page.getByLabel('Work address').inputValue()) === `cora@${domain}`)
  await cora.page.getByLabel('Work address').fill(`mallory@${domain}`) // another account of the same company
  await cora.page.getByRole('button', { name: 'Sign in as this address' }).click()
  await cora.page.getByText('That is not the account this link is for.').waitFor()
  check('another account of the company is refused, and the link is back in the page, not in the address bar', (await cora.page.evaluate(() => location.search + location.hash)) === '#/enrol' && (await cora.page.getByRole('button', { name: 'Create passkey' }).count()) === 0)
  await cora.page.getByRole('button', { name: 'Continue with Microsoft' }).click()
  await cora.page.getByRole('button', { name: 'Sign in as this address' }).click()
  await cora.page.getByRole('button', { name: 'Create passkey' }).waitFor()
  check('with the invited account the provider\'s confirmation shows, and the passkey can be created', await cora.page.getByText(`cora@${domain}, confirmed by Microsoft`).isVisible())
  // Review R1: the passkey belongs to the browser that did the company sign-in. The link alone, in another browser, creates nothing.
  const thief = await person()
  await thief.page.goto(companyLink)
  await thief.page.getByRole('button', { name: 'Continue with Microsoft' }).waitFor()
  check('the link in another browser, after the member signed in, still asks for the company account: no passkey button there', (await thief.page.getByRole('button', { name: 'Create passkey' }).count()) === 0)
  await thief.context.close()
  await cora.page.getByRole('button', { name: 'Create passkey' }).click()
  await cora.page.getByRole('heading', { name: 'Your passkey waits for approval.' }).waitFor()
  check('no words are shown on this path', (await cora.page.locator('.phrase').count()) === 0 && await both(cora.page, '40-company-stored'))
  await on.reload()
  await on.getByRole('heading', { name: /People, wallets|Read this before you continue/ }).waitFor()
  check('the Owner is told at the door that a passkey waits', await on.getByText('A new passkey of Cora Company waits for you').isVisible())
  await on.getByRole('button', { name: 'I have read this' }).click()
  await on.getByRole('button', { name: 'Approve with passkey' }).waitFor()
  check('the approval card shows what the provider confirmed and the key type, and has no words field',
    await on.getByText(`cora@${domain}, confirmed by Microsoft on`).isVisible() && await on.locator('article.appr dl.kv dd', { hasText: 'Hardware security key, bound to the device' }).isVisible()
    && (await on.getByLabel(/Three words/).count()) === 0 && await both(on, '41-company-approval', 'article.appr >> nth=0'))
  await on.getByRole('button', { name: 'Approve with passkey' }).click()
  await on.getByRole('button', { name: 'Approve with passkey' }).waitFor({ state: 'detached' })
  await cora.page.getByRole('link', { name: 'Go to sign-in' }).click()
  await cora.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await cora.page.getByRole('button', { name: 'Sign out' }).first().waitFor()
  check('after the Owner\'s approval the member signs in with the passkey', (await status('/api/me', cora.page)) === 200)
  await cora.context.close()

  // G4: the operator freezes the organisation: its sessions end, and a member who signs in gets the plain page.
  check('the operator freezes the organisation', operator('freeze', newOrg.id).includes(`${newOrg.id} is now frozen`))
  await on.reload()
  await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await on.getByRole('heading', { name: 'This organisation is frozen.' }).waitFor()
  check('a freeze ends the session, and a sign-in shows the plain page, not "Sign-in did not work"', (await status('/api/me', on)) === 401 && await on.getByText(FOOTER).isVisible() && await both(on, '36-org-frozen'))
  check('the operator unfreezes it', operator('unfreeze', newOrg.id).includes(`${newOrg.id} is now active`))
  await on.getByRole('button', { name: 'Back to sign-in' }).click()
  await on.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await on.getByRole('button', { name: 'Sign out' }).first().waitFor()
  check('after the unfreeze the member signs in again', (await status('/api/me', on)) === 200)
  await applicant.context.close()

  // ---- demo mode: overview, desk and partner figures ----
  // An institution from "seed --demo": an Owner, a Trader and an Approver, and the linked "Demo wallet".
  const BANNER = 'Demo data. No order is sent and no funds move. Figures are examples.'
  const seeded = (...more) => run('node', ['scripts/dev.mjs', 'seed', ...more, '--persist', STATE])
  const demoSeed = seeded('--demo')
  check('seed --demo says what it made', demoSeed.includes('an institution with one linked wallet named "Demo wallet"'))
  async function firstOwner(link) {
    const who = await person()
    await who.page.goto(link)
    await who.page.getByRole('button', { name: 'Create passkey' }).click()
    await who.page.getByRole('heading', { name: 'Send these three words to your colleague.' }).waitFor()
    check('the activate command confirmed the new Owner', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
    await who.page.getByRole('link', { name: 'Go to sign-in' }).click()
    await who.page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    return who
  }
  const dana = await firstOwner(demoSeed.match(/http\S+\/#\/enrol\/\S+/)[0])
  await dana.page.getByRole('heading', { name: 'Your position, in one view.' }).waitFor()
  check('an institution lands on its overview: banner, footer, the total computed from the balances, no approval waiting',
    await dana.page.getByText(BANNER).isVisible() && await dana.page.getByText(FOOTER).isVisible() && await dana.page.getByText('11,363,175.00').first().isVisible()
    && (await dana.page.locator('[data-waiting]').textContent()) === '0' && await dana.page.getByText('ORD-2611-0142').isVisible())
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
  await typeWords(await enrolAt(await inviteAt(dana, 'Tess Trader', 'trader'), tess), 'Tess Trader', (await arrive(dana, false), dana.page))
  await dana.page.getByRole('button', { name: 'Re-enrol Tess Trader' }).waitFor()
  await arrive(tess)
  const abe = await person()
  await typeWords(await enrolAt(await inviteAt(dana, 'Abe Approver', 'approver'), abe), 'Abe Approver', (await arrive(dana, false), dana.page))
  await dana.page.getByText('a 72 hour wait stands in for the second person').waitFor()
  check('the activate command stood in for the Approver\'s wait', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
  await arrive(abe)
  await abe.devtools.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: abe.authenticatorId })
  await abe.devtools.send('WebAuthn.addVirtualAuthenticator', { options: KEY })
  await abe.page.getByRole('button', { name: 'Add a passkey' }).click()
  await abe.page.getByText('2: Security key 1, Security key 2').waitFor()

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
  check('the desk shows the banner, the ticket with the linked wallet, the permitted assets as illustrative, and the three steps',
    await tess.page.getByText(BANNER).isVisible() && await ticket.getByLabel('Settle from').locator('option', { hasText: 'Demo wallet' }).count() === 1
    && await tess.page.getByText('Illustrative. Each token is checked against the ESMA register before launch').isVisible()
    && await tess.page.getByText('Signing in the wallet is not part of this demo.').isVisible() && await ticket.getByText('Nothing is signed at this step.').isVisible()
    && (await tess.page.locator('table.t').first().locator('tbody tr').allTextContents()).map((row) => row.match(/^(ETH|USDC|EURCV|EURC|EURe)/)?.[1]).join() === 'ETH,USDC,EURC,EURe,EURCV')
  check('at phone width the ticket gives way to "Use a larger screen", the blotter stays, and nothing scrolls sideways', await both(tess.page, '47-desk-ticket')
    && await (async () => {
      await tess.page.setViewportSize({ width: 390, height: 844 })
      const ok = await tess.page.getByText('Use a larger screen.').isVisible() && !(await ticket.isVisible()) && await tess.page.getByRole('heading', { name: 'Order blotter' }).isVisible()
      await tess.page.setViewportSize({ width: 1440, height: 900 })
      return ok && await ticket.isVisible() && !(await tess.page.getByText('Use a larger screen.').isVisible())
    })())
  await ticket.getByLabel('Amount to sell').fill('1e9')
  await ticket.getByRole('button', { name: 'Review order' }).click()
  await tess.page.getByText('Enter the amount as a plain number above zero').waitFor()
  await ticket.getByLabel('Amount to sell').fill('250000')
  await ticket.getByRole('button', { name: 'Review order' }).click()
  const review = tess.page.locator('[data-step="review"]')
  await review.getByRole('heading', { name: 'Review order' }).waitFor()
  check('the review step shows the server\'s estimate and says that nothing is signed',
    await review.getByText('84.7372 ETH').isVisible() && await review.getByText('250,000.00 EUR', { exact: true }).isVisible() && await review.getByText('Fee, of the volume').isVisible() && await review.locator('tfoot').getByText('25.00').isVisible()
    && await review.getByText('Nothing is signed at this step.').isVisible() && await review.getByText('Example figures. The real cost of an order is shown before it is signed.').isVisible()
    && await both(tess.page, '48-desk-review'))
  const SENTENCE = 'Sell 250,000.00 EURC for ETH, market, Optimism, from Demo wallet'
  await review.getByRole('button', { name: 'Send for approval' }).click()
  await tess.page.getByText('Sent for approval.').waitFor()
  const blotter = (who) => who.page.locator('section', { has: who.page.getByRole('heading', { name: 'Order blotter' }) }).locator('tbody tr')
  check('the order is sent for approval, reads in words, and is the first row of the blotter with its real state',
    await tess.page.getByText(new RegExp(`${SENTENCE} \\(0x[0-9a-fA-F]{4}\\.{3}[0-9a-fA-F]{4}\\)\\.`)).isVisible() && /^ORD-[0-9a-f]{8}.*Pending approval/.test(await blotter(tess).first().textContent()) && (await blotter(tess).count()) === 8)
  await arrive(tess, false)
  check('the Trader sees the own request under Approvals, with no way to approve it', await tess.page.getByText(SENTENCE).first().isVisible()
    && await tess.page.getByRole('button', { name: 'Cancel request' }).isVisible() && (await tess.page.getByRole('button', { name: 'Approve' }).count()) === 0)

  // The Approver approves it with a passkey.
  await arrive(abe, false)
  const card = abe.page.locator('article.appr', { hasText: SENTENCE })
  await card.getByRole('button', { name: 'Review' }).click()
  check('the Approver reads the order in words, its estimate, who asked, and that nothing is sent', await card.getByRole('heading', { name: 'Demo order' }).isVisible()
    && await card.getByText('Requested by Tess Trader (Trader)').first().isVisible() && await card.getByText('Demo: approving records the decision and sends nothing.').isVisible()
    && await card.locator('dl.kv dd', { hasText: 'Approved. Not sent: demo' }).isVisible() && /^0x[0-9a-fA-F]{40}$/.test(await card.locator('dl.kv .mono').textContent()) && await both(abe.page, '50-order-approval', 'article.appr >> nth=0'))
  await card.getByRole('button', { name: 'Approve' }).click()
  await card.waitFor({ state: 'detached' })
  await desk(tess)
  check('after the approval the blotter says "Approved. Not sent: demo"', (await blotter(tess).first().textContent()).includes('Approved. Not sent: demo'))
  await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).click()
  const record = tess.page.locator('#record')
  await record.waitFor()
  check('the record of the order: who prepared it, the ticket, the checks, the estimate, who decided, and no execution',
    await record.getByText(SENTENCE).isVisible() && await record.getByText(/Tess Trader \(Trader\) on 20\d\d-/).isVisible() && await record.getByText(/Approved by Abe Approver on 20\d\d-/).isVisible()
    && await record.getByText('Execution: none, demo').isVisible() && (await record.locator('.checks li').count()) === 7 && await record.getByText('The wallet is linked to this organisation').isVisible()
    && await record.getByText('84.7372 ETH').isVisible() && await record.getByText('Example figures. The real cost of an order is shown before it is signed.').isVisible()
    && await both(tess.page, '49-desk-record', '#record'))
  await tess.page.setViewportSize({ width: 390, height: 844 })
  check('at phone width the blotter and the record stay usable', await record.getByText('Execution: none, demo').isVisible() && await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).isVisible())
  await tess.page.setViewportSize({ width: 1440, height: 900 })

  // The same for an order the Approver refuses.
  await ticket.getByLabel('Amount to sell').fill('1000.123456') // every decimal a member typed is shown, never cut
  await ticket.getByRole('button', { name: 'Review order' }).click()
  await review.getByRole('button', { name: 'Send for approval' }).click()
  await tess.page.getByText('Sent for approval.').waitFor()
  await arrive(abe, false)
  const refusedCard = abe.page.locator('article.appr', { hasText: 'Sell 1,000.123456 EURC for ETH' })
  await refusedCard.getByRole('button', { name: 'Reject' }).click()
  await refusedCard.waitFor({ state: 'detached' })
  await desk(tess)
  await blotter(tess).first().getByRole('button', { name: /Open the record of ORD-/ }).click()
  check('a refused order shows as refused in the blotter and in its record, with who refused it',
    (await blotter(tess).first().textContent()).includes('Refused') && await record.getByText(/Refused by Abe Approver on 20\d\d-/).isVisible() && await record.getByText('Sell 1,000.123456 EURC for ETH, market, Optimism, from Demo wallet').isVisible()
    && (await blotter(tess).nth(1).textContent()).includes('Approved. Not sent: demo') && (await blotter(tess).nth(2).textContent()).includes('Example'))

  // One CSV, downloaded and read back.
  const [orderFile] = await Promise.all([tess.page.waitForEvent('download'), tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Order blotter' }) }).getByRole('button', { name: 'Export CSV' }).click()])
  const orderLines = readFileSync(await orderFile.path(), 'utf8').split('\r\n').filter(Boolean)
  check('the export of the blotter downloads: named ophis-demo-, the own orders first with their real state, every row with source = demo',
    /^ophis-demo-orders-\d{4}-\d\d-\d\d\.csv$/.test(orderFile.suggestedFilename()) && orderLines[0].endsWith(',"Status","source"') && orderLines.length === 10 && orderLines.slice(1).every((row) => row.endsWith(',"demo"'))
    && orderLines[1].includes('"1000.123456"') && orderLines[1].includes('"Refused"') && orderLines[2].includes('"250000"') && orderLines[2].includes('"Approved. Not sent: demo"') && orderLines[3].startsWith('"ORD-2611-0142"'))

  await open(tess, 'overview', 'Your position, in one view.')
  const recent = tess.page.locator('section', { has: tess.page.getByRole('heading', { name: 'Recent orders' }) }).locator('tbody tr')
  check('the institution overview: tiles, balances by wallet, the own orders first with their real state, then examples, the fee statement',
    (await recent.first().textContent()).includes('Refused') && (await recent.nth(1).textContent()).includes('Approved. Not sent: demo') && (await recent.nth(2).textContent()).includes('Example')
    && await tess.page.getByText('Treasury Safe').isVisible() && await tess.page.getByText('Example wallets and balances, not your linked wallets.').isVisible() && await tess.page.getByRole('heading', { name: 'Monthly fee statement' }).isVisible() && await tess.page.getByText('17,920,000.00').first().isVisible()
    && await both(tess.page, '45-overview-institution'))
  for (const who of [dana, tess, abe]) await who.context.close()

  // A partner organisation (the plain seed): its overview, and the desk that is not for it.
  const pat = await firstOwner(seeded().match(/http\S+\/#\/enrol\/\S+/)[0])
  await pat.page.getByRole('heading', { name: 'Your flow, in one view.' }).waitFor()
  const chart = pat.page.locator('.chart svg[role="img"]')
  check('the partner overview: tiles, the daily chart as SVG with a text alternative, what you earn, the split, codes, the ledger and attributed wallets',
    await pat.page.getByText(BANNER).isVisible() && await pat.page.getByText('$43,983,000').isVisible() && await pat.page.getByText('$109,957.50').isVisible() && await pat.page.getByText('9,412').first().isVisible()
    && /Daily volume from 2026-10-11 to 2026-11-09: 43,983,000\.00 USD in total/.test(await chart.getAttribute('aria-label')) && (await chart.locator('rect').count()) === 30
    && await pat.page.getByText('Your fee.').isVisible() && await pat.page.getByRole('heading', { name: 'By chain' }).isVisible() && await pat.page.getByRole('heading', { name: 'Affiliate codes' }).isVisible()
    && await pat.page.getByRole('heading', { name: 'Payout ledger' }).isVisible() && await pat.page.getByText('Showing 8 of 1,284, by volume.').isVisible() && await pat.page.getByText(FOOTER).isVisible())
  const partnerText = await pat.page.locator('main').innerText()
  check('the partner overview holds only what the partner earns, and no word of a licence or of payout terms', !/1\.00 bps|Ophis fee|licen[cs]ed|regulated|authori[sz]ed|MiCA|compliant|paid weekly|guarantee|honest|—/i.test(partnerText))
  check('the partner overview fits a phone', await both(pat.page, '46-overview-partner'))
  await pat.page.getByRole('link', { name: 'Desk' }).first().click()
  await pat.page.getByRole('heading', { name: 'The desk is for institutions.' }).waitFor()
  check('a partner sees "The desk is for institutions.", no ticket, and the server refuses the desk',
    (await pat.page.locator('form.ticket').count()) === 0 && await pat.page.getByText(BANNER).isVisible() && (await status('/api/desk', pat.page)) === 403 && await both(pat.page, '51-desk-partner'))
  await pat.context.close()

  if (violations.length) console.error(violations.join("\n"))
  check(`no policy violation in the browser (${violations.length})`, violations.length === 0)
  check(`no request left the origin (${foreign.length})`, foreign.length === 0)
  console.log('\nEnd-to-end run passed. Screenshots in .shots/: 01-signin to 51-desk-partner')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  stopDnsStubs()
  stopIdp()
  stopIndexer()
  await browser?.close()
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
