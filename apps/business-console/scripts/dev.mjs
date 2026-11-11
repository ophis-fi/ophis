// Local development commands. They reach the local D1 only: no remote binding is opened
// (remoteBindings: false), and activation also refuses any ENVIRONMENT but "local".
//   node scripts/dev.mjs seed       one organisation (domain northwind.example, company sign-in "none"), one Owner seat, a one-time enrolment link
//                                   seed --company microsoft|google: the company sign-in is set, pinned to the local stand-in's tenant of that domain
//   node scripts/dev.mjs activate   ponytail: stands in for the first Owner's activation (the recovery wallet, milestone 5)
//   node scripts/dev.mjs skip       ponytail: stands in for the passing of time: every wait that runs is over (recovery wallet, recovery request, 24 h after a cancel)
// Option: --persist <dir>, the same value as "wrangler dev --persist-to <dir>".
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getPlatformProxy } from 'wrangler'
import { devActivatePending, devSkipWaits, randomToken, seedOrganisation, sha256Hex } from '../src/server/data.ts'
import { configFor } from '../src/server/passkeys.ts'
import { tenantOf } from './idp-stub.mjs'

const [command, ...options] = process.argv.slice(2)
const option = (name) => (options.includes(name) ? options[options.indexOf(name) + 1] : undefined)
const directory = option('--persist')
const company = option('--company')
const DOMAIN = 'northwind.example'
process.chdir(new URL('..', import.meta.url).pathname)
// The challenge key is made on this machine and never leaves it: .dev.vars is git-ignored.
if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', `CHALLENGE_KEY=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
// Milestone 5: the token of the operator's local API (scripts/operator.mjs reads it), made the same way and never
// printed. A file from before this milestone gets the line added.
const vars = readFileSync('.dev.vars', 'utf8')
if (!/^OPERATOR_TOKEN=/m.test(vars)) appendFileSync('.dev.vars', `${vars.endsWith('\n') ? '' : '\n'}OPERATOR_TOKEN=${randomBytes(32).toString('base64url')}\n`)
// Company sign-in: the client secrets of the two providers. Locally the stand-in takes any; real ones are set by hand.
for (const name of ['MICROSOFT_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET']) {
  if (!new RegExp(`^${name}=`, 'm').test(readFileSync('.dev.vars', 'utf8'))) appendFileSync('.dev.vars', `${name}=${randomBytes(24).toString('base64url')}\n`)
}

const { env, dispose } = await getPlatformProxy({
  configPath: 'wrangler.jsonc',
  remoteBindings: false,
  persist: directory ? { path: `${directory}/v3` } : true,
})
try {
  if (command === 'seed') {
    const ticket = randomToken()
    if (company !== undefined && company !== 'microsoft' && company !== 'google') throw new Error('--company takes microsoft or google')
    const pinned = company && { idp: company, tenant: company === 'google' ? DOMAIN : tenantOf(DOMAIN) }
    await seedOrganisation(env.DB, { name: 'Northwind Vaults', kind: 'partner', ownerName: 'Maren Okafor', ticketHash: await sha256Hex(ticket), now: Date.now(), domain: DOMAIN, company: pinned })
    if (pinned) console.log(`Company sign-in: ${company}. Invite members with an address at ${DOMAIN}.`)
    console.log(`Enrolment link, one use, valid 10 minutes:\n${configFor(env.ENVIRONMENT).origin}/#/enrol/${ticket}`)
  } else if (command === 'activate') {
    console.log(`Activated ${await devActivatePending(env.DB, env.ENVIRONMENT, Date.now())} pending passkey(s).`)
  } else if (command === 'skip') {
    await devSkipWaits(env.DB, env.ENVIRONMENT, Date.now())
    console.log('Every wait that was running is over.')
  } else {
    console.error('usage: node scripts/dev.mjs seed [--company microsoft|google] | activate | skip   [--persist <dir>]')
    process.exitCode = 1
  }
} finally {
  await dispose()
}
