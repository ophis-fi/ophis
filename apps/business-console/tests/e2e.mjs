// End-to-end proof in the installed Google Chrome, headless, with Chrome's virtual authenticator
// (DevTools protocol): seed, enrol, activate, sign in, see the Organisation page, revoke the session,
// land on sign-in. Starts and stops its own local server on a throwaway database. Run: pnpm test:e2e
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
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
  // reducedMotion: the kit then skips its entrance animation, so a screenshot never catches a half-faded page.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const devtools = await context.newCDPSession(page)
  await devtools.send('WebAuthn.enable')
  // A security key: USB, resident keys, user verification, not backup eligible (device-bound).
  await devtools.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const violations = []
  const foreign = []
  page.on('console', (message) => /content security policy|trusted ?type/i.test(message.text()) && violations.push(message.text()))
  page.on('request', (request) => request.url().startsWith(`${ORIGIN}/`) || foreign.push(request.url()))
  const status = (path) => page.evaluate((url) => fetch(url).then((response) => response.status), path)

  const first = await page.goto(ORIGIN)
  await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor()
  const headers = first.headers()
  check('the page carries the strict policy', ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"].every((part) => headers['content-security-policy']?.includes(part)))
  check('the page carries the other security headers', headers['x-content-type-options'] === 'nosniff' && headers['referrer-policy'] === 'no-referrer' && headers['cross-origin-resource-policy'] === 'same-origin' && headers['x-frame-options'] === 'DENY')
  check('the footer line is on the sign-in page', await page.getByText('Ophis is a software provider. It is not a crypto-asset service provider.').isVisible())
  check('the sign-in page has no username or password field', (await page.locator('input').count()) === 0)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: '.shots/01-signin.png' })

  await page.goto(link)
  await page.getByRole('button', { name: 'Create passkey' }).waitFor()
  check('the ticket left the address bar', (await page.evaluate(() => location.hash)) === '#/enrol')
  check('the enrolment page names the organisation and the site', await page.getByText('Northwind Vaults').first().isVisible() && await page.getByText('localhost:8787').isVisible())
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await page.getByText('Passkey stored, waiting for confirmation.').waitFor()
  check('a real browser enrolled a passkey', true)

  await page.getByRole('link', { name: 'Go to sign-in' }).click()
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await page.getByText('Sign-in did not work.').waitFor()
  check('the pending passkey cannot sign in', (await status('/api/me')) === 401)

  check('the activate command confirmed one passkey', run('node', ['scripts/dev.mjs', 'activate', '--persist', STATE]).includes('Activated 1 pending'))
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await page.getByRole('heading', { name: 'People, wallets and two-person approval.' }).waitFor()
  await page.getByRole('button', { name: 'Revoke' }).waitFor()
  check('the Organisation page shows the member, the passkey and the session',
    await page.getByRole('cell', { name: 'Maren Okafor' }).first().isVisible() && await page.getByText('1: Security key 1').isVisible() && await page.getByText('This session').isVisible())
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-session')
  check('the session cookie is __Host-, Secure, HttpOnly, SameSite=Strict, Path=/', Boolean(cookie) && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/' && cookie.domain === 'localhost')
  check('scripts cannot read the session cookie', !(await page.evaluate(() => document.cookie)).includes('session'))
  check('the footer line is on the Organisation page', await page.getByText('Ophis is a software provider. It is not a crypto-asset service provider.').isVisible())
  await page.screenshot({ path: '.shots/02-organisation.png', fullPage: true })

  await page.getByRole('link', { name: 'Security and data' }).first().click()
  await page.getByRole('heading', { name: 'What we store, and what we never hold.' }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: 'What we store, and what we never hold.' }).waitFor()
  await page.getByRole('link', { name: 'Organisation' }).first().click()
  await page.getByRole('button', { name: 'Revoke' }).waitFor()
  check('the session survives a reload', (await status('/api/me')) === 200)

  await page.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor()
  check('after the revoke the app is back on sign-in and the session is dead', (await status('/api/me')) === 401)

  check(`no policy violation in the browser (${violations.length})`, violations.length === 0)
  check(`no request left the origin (${foreign.length})`, foreign.length === 0)
  console.log('\nEnd-to-end run passed. Screenshots: .shots/01-signin.png, .shots/02-organisation.png')
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
