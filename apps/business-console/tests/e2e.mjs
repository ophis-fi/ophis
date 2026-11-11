// End-to-end proof in the installed Google Chrome, headless, with Chrome's virtual authenticators
// (DevTools protocol). Milestone 1: seed, enrol, activate, sign in, see the Organisation page, end the
// session. Milestone 2: the Owner adds a second key and invites a Viewer; the Viewer enrols in a second
// browser context with its own authenticator and reads three words; the Owner types them; the Viewer signs
// in. Then the Viewer is re-enrolled from a third context, and the Viewer's old passkey stops that.
// Milestone 3: a second Owner and an Admin join (the Admin with the second Owner as second person), two people
// unfreeze the Viewer, the Admin asks for a role change, an Owner approves it, the audit page shows the rows and
// "Chain verified", and the export downloads.
// Starts and stops its own local server on a throwaway database. Run: pnpm test:e2e
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { chromium } from 'playwright-core'

process.chdir(new URL('..', import.meta.url).pathname)
const ORIGIN = 'http://localhost:8787'
const STATE = '.wrangler/e2e'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
const run = (command, args) => execFileSync(command, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const reachable = () => fetch(ORIGIN, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
const check = (what, ok) => {
  if (!ok) throw new Error(`FAILED: ${what}`)
  console.log(`ok  ${what}`)
}

if (await reachable()) throw new Error('port 8787 is in use: stop the other server first')
rmSync(STATE, { recursive: true, force: true })
mkdirSync('.shots', { recursive: true })
run('node_modules/.bin/wrangler', ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE])
const link = run('node', ['scripts/dev.mjs', 'seed', '--persist', STATE]).match(/http\S+\/#\/enrol\/\S+/)?.[0]
check('seed printed an enrolment link', Boolean(link))

// detached: the server gets its own process group, so the whole group can be stopped at the end.
const server = spawn('node_modules/.bin/wrangler', ['dev', '--persist-to', STATE], { env, detached: true, stdio: 'ignore' })
let browser
try {
  for (let i = 0; i < 60 && !(await reachable()); i++) await new Promise((resolve) => setTimeout(resolve, 500))
  check('the local server answers', await reachable())

  browser = await chromium.launch({ executablePath: CHROME, headless: true })
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
    page.on('request', (request) => request.url().startsWith(`${ORIGIN}/`) || foreign.push(request.url()))
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
  await page.getByRole('heading', { name: 'Read these three words aloud.' }).waitFor()
  check('a real browser enrolled a passkey and shows three words', (await page.locator('.phrase span').count()) === 3)

  await page.getByRole('link', { name: 'Go to sign-in' }).click()
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await page.getByText('Sign-in did not work.').waitFor()
  check('the pending passkey cannot sign in', (await status('/api/me')) === 401)

  check('the activate command confirmed one passkey', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await page.getByRole('heading', { name: 'People, wallets and two-person approval.' }).waitFor()
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
  async function both(on, name) {
    await on.screenshot({ path: `.shots/${name}.png` })
    await on.setViewportSize({ width: 390, height: 844 })
    await on.waitForTimeout(200) // let the narrow layout paint: a shot taken at once shows the old frame in part
    await on.screenshot({ path: `.shots/${name}-phone.png` })
    const fits = await on.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    await on.setViewportSize({ width: 1440, height: 900 })
    return fits
  }
  const readAlerts = async (text, on = page, shot = '') => {
    await on.getByRole('heading', { name: 'Read this before you continue.' }).waitFor()
    const shown = await on.getByText(text).isVisible() && (!shot || await both(on, shot))
    await on.getByRole('button', { name: 'I have read this' }).click()
    await on.getByRole('heading', { name: 'People, wallets and two-person approval.' }).waitFor()
    return shown
  }
  // The member's side of the ceremony, on their own device: open the link, create the passkey, read the words.
  async function enrolAt(link, who, label) {
    await who.page.goto(link)
    if (label) await who.page.getByLabel('Name for this key (no personal data)').fill(label)
    await who.page.getByRole('button', { name: 'Create passkey' }).click()
    await who.page.getByRole('heading', { name: 'Read these three words aloud.' }).waitFor()
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
    await on.getByLabel(`Three words heard from ${name}`).fill(words.join(' '))
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
  check('the Viewer enrolled on their own device and sees three words, large, with the warning',
    words.length === 3 && words.every((word) => /^[a-z-]{3,10}$/.test(word)) && await viewer.page.getByText('Never type them or send them by message, email or chat.').isVisible()
    && (await viewer.page.locator('.phrase').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))) >= 34)
  check('the footer line is on the three-word page', await viewer.page.getByText(FOOTER).isVisible())
  check('the three-word page fits a phone', await both(viewer.page, '03-three-words'))

  await organisation()
  check('the Owner is told at the door that a passkey waits for the words', await readAlerts('A new passkey of Ada Viewer waits for the three words from you'))
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
  await viewer.page.getByRole('heading', { name: 'People, wallets and two-person approval.' }).waitFor()
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
  await readAlerts('A new passkey of Ada Viewer waits for the three words from you')
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
    await who.page.getByRole('heading', { name: /People, wallets|Read this before you continue/ }).waitFor()
    if (await who.page.getByRole('button', { name: 'I have read this' }).count()) await who.page.getByRole('button', { name: 'I have read this' }).click()
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
  await bo.context.close()
  await cy.context.close()
  await arrive(owner, false)

  // The server cannot end the session: the app must not pretend that it did.
  await page.route('**/api/signout', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }))
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByText('Sign-out did not work.').waitFor({ timeout: 5000 })
  check('a failed sign-out keeps the app signed in and says so', await page.getByRole('button', { name: 'End session' }).first().isVisible() && (await status('/api/me')) === 200)
  await page.unroute('**/api/signout')

  // The revoke also clears the cookie, so the browser alone cannot show that the server forgot the token: replay it.
  cookie = await sessionCookie()
  const replay = () => fetch(`${ORIGIN}/api/me`, { headers: { cookie: `__Host-session=${cookie.value}`, 'sec-fetch-site': 'same-origin' } }).then((response) => response.status)
  const before = await replay()
  await page.getByRole('row', { name: /This session/ }).getByRole('button', { name: 'End session' }).click()
  await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor()
  check('after the revoke the app is back on sign-in and the session is dead', (await status('/api/me')) === 401)
  check('the revoked token is dead on the server: it worked before the revoke, not after', before === 200 && (await replay()) === 401)

  check(`no policy violation in the browser (${violations.length})`, violations.length === 0)
  check(`no request left the origin (${foreign.length})`, foreign.length === 0)
  console.log('\nEnd-to-end run passed. Screenshots in .shots/: 01-signin to 14-audit-phone')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
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
