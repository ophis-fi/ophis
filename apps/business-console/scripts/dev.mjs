// Local development commands. They reach the local D1 only: no remote binding is opened
// (remoteBindings: false), and activation also refuses any ENVIRONMENT but "local".
//   node scripts/dev.mjs seed       one organisation (domain northwind.example), one Owner seat, a one-time enrolment link
//                                   seed --demo: the organisation is an institution and gets one linked wallet named "Demo wallet" (no signature; local only), to try the order ticket,
//                                                and a linked "Demo Safe" (kind safe, a random address) whose orders are presign orders
//                                   seed --live: the organisation is a partner and gets one linked "Demo wallet" at the partner address of the indexer's contract file
//                                                (no signature; local only), so that Overview shows the figures of the local indexer stand-in
//   node scripts/dev.mjs activate   ponytail: stands in for the first Owner's activation (the recovery wallet, milestone 5)
//   node scripts/dev.mjs skip       ponytail: stands in for the passing of time: every wait that runs is over (recovery wallet, recovery request, 24 h after a cancel)
//   node scripts/dev.mjs stale      ponytail: stands in for 5 minutes passing: every passkey check is stale, so the next sensitive step (sending an order) asks for the passkey
// Option: --persist <dir>, the same value as "wrangler dev --persist-to <dir>".
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { generateHybridIdentity, identityToRecipient } from 'age-encryption'
import { getPlatformProxy } from 'wrangler'
import { devActivatePending, devDemoWallet, devSkipWaits, devStaleChecks, randomToken, seedOrganisation, sha256Hex } from '../src/server/data.ts'
import { configFor } from '../src/server/passkeys.ts'
import { CONTRACT, PORT as INDEXER_PORT } from './indexer-stub.mjs'
import { PORT as LIST_PORT } from './list-stub.mjs'
import { PORT as ORDERBOOK_PORT } from './orderbook-stub.mjs'
import { PORT as TURNSTILE_PORT, TEST_SECRET as TURNSTILE_TEST_SECRET } from './turnstile-stub.mjs'

// The first account of the public test mnemonic of anvil and hardhat: its key is public, so it signs the local desk's
// orders in tests/e2e.mjs, against the stand-in orderbook only. Never send funds to it.
const DEMO_KEY_WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const [command, ...options] = process.argv.slice(2)
const option = (name) => (options.includes(name) ? options[options.indexOf(name) + 1] : undefined)
const directory = option('--persist')
const demo = options.includes('--demo')
const live = options.includes('--live')
process.chdir(fileURLToPath(new URL('..', import.meta.url))) // a path, not a URL: a space or a Windows drive survives (CodeRabbit, PR #1646)
// The challenge key is made on this machine and never leaves it: .dev.vars is git-ignored.
if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', `CHALLENGE_KEY=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
// Milestone 5: the token of the operator's local API (scripts/operator.mjs reads it), made the same way and never
// printed. A file from before this milestone gets the line added.
const vars = readFileSync('.dev.vars', 'utf8')
if (!/^OPERATOR_TOKEN=/m.test(vars)) appendFileSync('.dev.vars', `${vars.endsWith('\n') ? '' : '\n'}OPERATOR_TOKEN=${randomBytes(32).toString('base64url')}\n`)
// Partner figures: the local stand-in for the rebate indexer (scripts/indexer-stub.mjs) and the token it asks for,
// made here and never printed. A real environment sets INDEXER_URL as a variable and INDEXER_TOKEN as a secret.
if (!/^INDEXER_URL=/m.test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `INDEXER_URL=http://127.0.0.1:${INDEXER_PORT}\n`)
if (!/^INDEXER_TOKEN=/m.test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `INDEXER_TOKEN=${randomBytes(32).toString('base64url')}\n`)
// M10: the local stand-in for the place where the OFAC list file lives (scripts/list-stub.mjs). A real environment sets SANCTIONS_URL as a variable (https).
if (!/^SANCTIONS_URL=/m.test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `SANCTIONS_URL=http://127.0.0.1:${LIST_PORT}/ofac.json\n`)
// The real desk: the local stand-in for the public orderbooks (scripts/orderbook-stub.mjs). Locally nothing reaches a real
// orderbook. Without this line the local desk asks the real ones (their constants in src/server/orders.ts).
if (!/^ORDERBOOK_URL=/m.test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `ORDERBOOK_URL=http://127.0.0.1:${ORDERBOOK_PORT}\n`)
// Overview's balances: the same stand-in answers the two JSON-RPC endpoints of each chain. Without this line the local
// Overview reads the public endpoints of src/server/passkeys.ts.
if (!/^RPC_URL=/m.test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `RPC_URL=http://127.0.0.1:${ORDERBOOK_PORT}/rpc\n`)
// The bot check of /recover: the local stand-in for Cloudflare Turnstile (scripts/turnstile-stub.mjs) and Cloudflare's
// public test secret. A real environment sets no TURNSTILE_URL, and TURNSTILE_SECRET as a secret.
if (!/^TURNSTILE_URL=/m.test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `TURNSTILE_URL=http://127.0.0.1:${TURNSTILE_PORT}\n`)
if (!/^TURNSTILE_SECRET=/m.test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `TURNSTILE_SECRET=${TURNSTILE_TEST_SECRET}\n`)
// Milestone 5b: the LOCAL test key of the sealing (key-custody.md section 3). The identity, the secret half, is made
// here and stays in .dev.seal-identity next to .dev.vars (git-ignored, never printed): it opens what the local console
// seals. Its recipient, the public half, goes to the Worker (SEAL_RECIPIENT in .dev.vars, for the fingerprint) and to
// the console's build (VITE_SEAL_LOCAL in .env.local, git-ignored: Vite compiles it into the bundle as a constant).
// A real environment's key is made offline (key-custody.md section 4), never here.
const lineOf = (file, name) => (existsSync(file) ? readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] : undefined)
if (!existsSync('.dev.seal-identity') || !lineOf('.dev.vars', 'SEAL_RECIPIENT') || lineOf('.dev.vars', 'SEAL_RECIPIENT') !== lineOf('.env.local', 'VITE_SEAL_LOCAL')) {
  const identity = await generateHybridIdentity()
  const recipient = await identityToRecipient(identity)
  writeFileSync('.dev.seal-identity', `${identity}\n`, { mode: 0o600 })
  const put = (file, name) => writeFileSync(file, `${(existsSync(file) ? readFileSync(file, 'utf8') : '').replace(new RegExp(`^${name}=.*\\n?`, 'm'), '').replace(/([^\n])$/, '$1\n')}${name}=${recipient}\n`, { mode: 0o600 })
  put('.dev.vars', 'SEAL_RECIPIENT')
  put('.env.local', 'VITE_SEAL_LOCAL')
  console.log('A local test key for sealing was made (.dev.seal-identity). Build the console again ("pnpm dev" does) so that it seals to this key.')
}

const { env, dispose } = await getPlatformProxy({
  configPath: 'wrangler.jsonc',
  remoteBindings: false,
  persist: directory ? { path: `${directory}/v3` } : true,
})
try {
  if (command === 'seed') {
    const ticket = randomToken()
    // One organisation per domain: the first seed gets northwind.example, the next ones northwind-2.example and so on.
    const { n } = await env.DB.prepare(`SELECT count(*) AS n FROM organisations WHERE email_domain LIKE 'northwind%'`).first()
    const DOMAIN = n ? `northwind-${n + 1}.example` : 'northwind.example'
    const { orgId } = await seedOrganisation(env.DB, { name: 'Northwind Vaults', kind: demo ? 'institution' : 'partner', ownerName: 'Maren Okafor', ticketHash: await sha256Hex(ticket), now: Date.now(), domain: DOMAIN })
    if (demo) {
      await devDemoWallet(env.DB, env.ENVIRONMENT, orgId, Date.now(), DEMO_KEY_WALLET)
      await devDemoWallet(env.DB, env.ENVIRONMENT, orgId, Date.now(), undefined, 'safe', 'Demo Safe')
      console.log('Demo: an institution with one linked wallet named "Demo wallet" (no signature, local only), at the address of the first public test key of anvil, and a "Demo Safe" at a random address.')
    } else if (live) {
      // The partner wallet of the contract file: the stand-in answers its figures for this address.
      const address = JSON.parse(readFileSync(CONTRACT, 'utf8')).wallets[0].wallet
      await devDemoWallet(env.DB, env.ENVIRONMENT, orgId, Date.now(), address)
      console.log('Live: a partner with one linked wallet named "Demo wallet" (no signature, local only), at the partner address of the indexer contract file.')
    }
    console.log(`Domain ${DOMAIN}.`)
    console.log(`Enrolment link, one use, valid 10 minutes:\n${configFor(env.ENVIRONMENT).origin}/#/enrol/${ticket}`)
  } else if (command === 'activate') {
    console.log(`Activated ${await devActivatePending(env.DB, env.ENVIRONMENT, Date.now())} pending passkey(s).`)
  } else if (command === 'skip') {
    await devSkipWaits(env.DB, env.ENVIRONMENT, Date.now())
    console.log('Every wait that was running is over.')
  } else if (command === 'stale') {
    await devStaleChecks(env.DB, env.ENVIRONMENT)
    console.log('Every passkey check is stale: the next sensitive step asks for the passkey.')
  } else {
    console.error('usage: node scripts/dev.mjs seed [--demo | --live] | activate | skip | stale   [--persist <dir>]')
    process.exitCode = 1
  }
} finally {
  await dispose()
}
