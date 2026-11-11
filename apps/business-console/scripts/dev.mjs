// Local development commands. They reach the local D1 only: no remote binding is opened
// (remoteBindings: false), and activation also refuses any ENVIRONMENT but "local".
//   node scripts/dev.mjs seed       one organisation, one Owner seat, a one-time enrolment link
//   node scripts/dev.mjs activate   ponytail: stands in for the first Owner's activation (the recovery wallet, milestone 5)
//   node scripts/dev.mjs skip       ponytail: stands in for the passing of time: every wait that runs is over (recovery wallet, recovery request, 24 h after a cancel)
// Option: --persist <dir>, the same value as "wrangler dev --persist-to <dir>".
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { getPlatformProxy } from 'wrangler'
import { devActivatePending, devSkipWaits, randomToken, seedOrganisation, sha256Hex } from '../src/server/data.ts'
import { configFor } from '../src/server/passkeys.ts'

const [command, flag, directory] = process.argv.slice(2)
process.chdir(new URL('..', import.meta.url).pathname)
// The challenge key is made on this machine and never leaves it: .dev.vars is git-ignored.
if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', `CHALLENGE_KEY=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })

const { env, dispose } = await getPlatformProxy({
  configPath: 'wrangler.jsonc',
  remoteBindings: false,
  persist: flag === '--persist' && directory ? { path: `${directory}/v3` } : true,
})
try {
  if (command === 'seed') {
    const ticket = randomToken()
    await seedOrganisation(env.DB, { name: 'Northwind Vaults', kind: 'partner', ownerName: 'Maren Okafor', ticketHash: await sha256Hex(ticket), now: Date.now() })
    console.log(`Enrolment link, one use, valid 10 minutes:\n${configFor(env.ENVIRONMENT).origin}/#/enrol/${ticket}`)
  } else if (command === 'activate') {
    console.log(`Activated ${await devActivatePending(env.DB, env.ENVIRONMENT, Date.now())} pending passkey(s).`)
  } else if (command === 'skip') {
    await devSkipWaits(env.DB, env.ENVIRONMENT, Date.now())
    console.log('Every wait that was running is over.')
  } else {
    console.error('usage: node scripts/dev.mjs seed|activate|skip [--persist <dir>]')
    process.exitCode = 1
  }
} finally {
  await dispose()
}
