import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, statfsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '../../railgun/node_modules/@playwright/test/index.mjs'
import { JsonRpcProvider } from 'ethers'
import { boundIndexerResponse, cachedIndexerResponse } from '../../railgun/tests/fork-indexer.mjs'
import { forkMarker } from '../../railgun/src/fork-marker.ts'
import { forkOperator } from '../dist/fork-driver.mjs'

const url = process.env.OPHIS_TEST_FORK_RPC ?? 'http://127.0.0.1:8559'
const origin = process.env.OPHIS_TEST_BROWSER_ORIGIN ?? 'http://127.0.0.1:4357'
for (const address of [url, origin]) assert.equal(new URL(address).hostname, '127.0.0.1')
const rpc = new JsonRpcProvider(url, 1, { cacheTimeout: -1 })
const metadata = await rpc.send('anvil_metadata', [])
assert.equal(metadata.forkedNetwork?.chainId, 1)
const forkGuard = forkMarker(metadata)
await rpc.send('anvil_setCode', [forkGuard.address, forkGuard.code])
await rpc.send('evm_setNextBlockTimestamp', [Math.max((await rpc.getBlock('latest')).timestamp + 1, Math.floor(Date.now() / 1000))])
await rpc.send('anvil_mine', [2])
await rpc.send('evm_setIntervalMining', [1])
const root = process.env.OPHIS_TEST_PROFILE ?? mkdtempSync(join(tmpdir(), 'ophis-operator-browser-'))
const marker = join(root, 'fork-instance.json')
if (process.env.OPHIS_TEST_PROFILE) assert.equal(JSON.parse(readFileSync(marker)).instanceId, metadata.instanceId)
else writeFileSync(marker, JSON.stringify({ instanceId: metadata.instanceId }), { mode: 0o600 })
const cache = join(root, 'public-indexer'); mkdirSync(cache, { mode: 0o700, recursive: true })
const freeDisk = () => { const disk = statfsSync(root); return disk.bavail * disk.bsize }
assert(freeDisk() >= 6 * 1024 ** 3, 'The browser test requires the existing 6 GiB free-disk reserve.')
let operator, context, heartbeat, diskGuard
const result = { passed: false, livePPOI: false, liveProtectedInclusion: false, profile: root }
let phase = 'operator-startup'
try {
  operator = await forkOperator(url)
  phase = 'browser-startup'
  assert(!existsSync(join(root, 'profile')) || statSync(join(root, 'profile')).isDirectory(), 'Fork browser profile must be a directory.')
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    headless: true, executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath()
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', viewport: { width: 1100, height: 1000 },
    args: ['--disk-cache-size=16777216', '--js-flags=--max-old-space-size=1536'],
  })
  const page = context.pages()[0] ?? await context.newPage()
  heartbeat = setInterval(() => console.log('FORK_PROGRESS', phase), 30_000)
  diskGuard = setInterval(() => {
    if (freeDisk() < 6.2 * 1024 ** 3) {
      console.error('FORK_DISK_RESERVE', phase)
      clearInterval(diskGuard)
      void context.close().catch(() => {})
    }
  }, 1000)
  page.setDefaultTimeout(180_000)
  await page.exposeBinding('ophisOperatorTest', async (_, message) => operator.handle(message))
  await page.route('https://rail-squid.squids.live/**/graphql', async (route) => {
    try {
      const body = route.request().postDataJSON()
      const file = join(cache, `${createHash('sha256').update(JSON.stringify(body)).digest('hex')}.json`)
      const payload = await cachedIndexerResponse(file, () => route.fetch({ timeout: 90_000 }))
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(boundIndexerResponse(payload, metadata.forkedNetwork.forkBlockNumber)),
        headers: { 'access-control-allow-origin': '*' } })
    } catch { await route.abort('failed').catch(() => {}) }
  })
  phase = 'new-isolated-wallet'
  await page.goto(origin, { waitUntil: 'networkidle', timeout: 180_000 })
  const password = 'isolated-operator-fork-test'
  await page.locator('#password').fill(password); await page.locator('#unlock').click()
  await page.waitForFunction(() => !document.documentElement.dataset.busy)
  if ((await page.locator('#error').innerText()).includes('Create or restore')) {
    await page.evaluate(async (pass) => (await import('/tests/fork.fixture.ts')).createFreshForkWallet(pass), password)
    await page.locator('#password').fill(password); await page.locator('#unlock').click()
    await page.waitForFunction(() => !document.documentElement.dataset.busy)
  }
  assert(await page.locator('#wallet').isVisible(), 'Isolated test wallet did not open.')
  phase = 'initial-history-sync'
  await page.waitForFunction(() => /Complete|Incomplete/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 12 * 60_000 })
  assert((await page.locator('#status').innerText()).includes('Complete'), (await page.locator('#error').innerText()).slice(0, 500))
  await page.evaluate(async (pass) => (await import('/tests/fork.fixture.ts')).loadForkSession(pass), password)
  const beforeWETH = BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance()))
  const beforeUSDC = BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkBalance()))
  phase = 'local-native-shield'
  result.shieldHash = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkShieldETH('0.02'))
  for (let i = 0; i < 60; i++) {
    const balance = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance())
    if (BigInt(balance) === beforeWETH + 19_950_000_000_000_000n) break
    await delay(2000)
  }
  assert.equal(BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance())), beforeWETH + 19_950_000_000_000_000n)
  phase = 'real-proof-and-operator-signature'
  result.swapHash = await page.evaluate(async (quote) => (await import('/tests/fork.fixture.ts')).forkOperatorSwap(quote), operator.quote())
  phase = 'verify-private-usdc'
  for (let i = 0; i < 60; i++) {
    result.privateUSDC = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkBalance())
    if (BigInt(result.privateUSDC) > beforeUSDC) break
    await delay(2000)
  }
  assert(BigInt(result.privateUSDC) > beforeUSDC)
  assert.equal((await rpc.getTransactionReceipt(result.swapHash)).status, 1)
  result.operator = operator.stats()
  assert.equal(result.operator.submissions, 1)
  assert.equal(result.operator.race?.validFeeBearingRequest, true)
  assert.equal(result.operator.race?.guardedRejection, 'UnexpectedDelegate')
  assert.equal(result.operator.protectedWrites, 1)
  assert.equal(result.operator.leakedWrite, false)
  assert.match(result.operator.receivedFeeCommitment, /^0x[0-9a-f]{64}$/)
  result.passed = true
  console.log('OPERATOR_FORK_ROUNDTRIP_PASS', JSON.stringify(result))
} finally {
  clearInterval(heartbeat)
  clearInterval(diskGuard)
  const closed = await Promise.allSettled([
    Promise.resolve().then(() => writeFileSync(join(root, 'result.json'), JSON.stringify({ ...result, phase }, null, 2), { mode: 0o600 })),
    context?.close(), operator?.stop(),
  ])
  rpc.destroy()
  const failures = closed.filter((result) => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Fork browser cleanup failed.')
}
