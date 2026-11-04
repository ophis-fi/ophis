import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, statfsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '../../railgun/node_modules/@playwright/test/index.mjs'
import { Contract, JsonRpcProvider, Wallet } from 'ethers'
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
// Keep fork fees stable while proving; the browser below models Baal's zero-tip suggestion.
await rpc.send('anvil_setNextBlockBaseFeePerGas', ['0x7'])
await rpc.send('anvil_mine', [2])
await rpc.send('evm_setIntervalMining', [1])
const root = process.env.OPHIS_TEST_PROFILE ?? mkdtempSync(join(tmpdir(), 'ophis-operator-browser-'))
const marker = join(root, 'fork-instance.json')
if (process.env.OPHIS_TEST_PROFILE) assert.equal(JSON.parse(readFileSync(marker)).instanceId, metadata.instanceId)
else writeFileSync(marker, JSON.stringify({ instanceId: metadata.instanceId }), { mode: 0o600 })
const cache = join(root, 'public-indexer'); mkdirSync(cache, { mode: 0o700, recursive: true })
const profiles = mkdtempSync(join(root, 'wallets-'))
const freeDisk = () => { const disk = statfsSync(root); return disk.bavail * disk.bsize }
assert(freeDisk() >= 6 * 1024 ** 3, 'The browser test requires the existing 6 GiB free-disk reserve.')
let operator, context, heartbeat, diskGuard
const result = { passed: false, livePPOI: false, liveProtectedInclusion: false, modeledPriorityFeeWei: '0',
  profile: root, wallets: [], synchronizationSeconds: [], operations: [] }
result.warmSynchronizationSeconds = []
let phase = 'operator-startup'
try {
  operator = await forkOperator(url)
  heartbeat = setInterval(() => console.log('FORK_PROGRESS', phase), 30_000)
  diskGuard = setInterval(() => {
    if (freeDisk() < 6.2 * 1024 ** 3) {
      console.error('FORK_DISK_RESERVE', phase)
      clearInterval(diskGuard)
      void context?.close().catch(() => {})
    }
  }, 1000)
  const checkReplay = async (page, hash) => {
    const before = await operator.stats()
    assert.equal(before.journaled, 0, 'Replay must reach EVM/authority validation after settlement.')
    const duplicate = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkOperatorReplay())
    assert.equal(duplicate.txHash, hash)
    const replay = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkOperatorReplay(true))
    assert(!replay.txHash && /verify the current Ethereum privacy contracts|during gas estimation/.test(replay.error ?? ''),
      'A consumed private spend must fail EVM/authority validation, rather than a busy or expired-quote gate.')
    assert.equal((await operator.stats()).signatures, before.signatures)
  }
  for (const [index, buy] of ['USDC', 'USDT'].entries()) {
    phase = `wallet-${index}-browser-startup`
    const profile = join(profiles, `profile-user-${index}`)
    assert(!existsSync(profile) || statSync(profile).isDirectory(), 'Fork browser profile must be a directory.')
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath()
        : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', viewport: { width: 1100, height: 1000 },
      args: ['--disk-cache-size=16777216', '--js-flags=--max-old-space-size=1536'],
    })
    const page = context.pages()[0] ?? await context.newPage()
    page.setDefaultTimeout(180_000)
    await page.exposeBinding('ophisOperatorTest', async (_, message) => operator.handle(message))
    await page.route(`${origin}/rpc`, async (route) => {
      const body = route.request().postDataJSON()
      const ids = new Set((Array.isArray(body) ? body : [body]).filter((call) => call.method === 'eth_maxPriorityFeePerGas').map((call) => call.id))
      if (!ids.size) return route.continue()
      const response = await route.fetch()
      const payload = await response.json()
      const update = (item) => ids.has(item.id) && !item.error ? { ...item, result: '0x0' } : item
      await route.fulfill({ response, body: JSON.stringify(Array.isArray(payload) ? payload.map(update) : update(payload)) })
    })
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
    phase = `wallet-${index}-new-isolated-wallet`
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
    phase = `wallet-${index}-initial-history-sync`
    const syncStart = Date.now()
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        await page.waitForFunction(() => document.querySelector('#ready-actions')?.disabled === false ||
          /Incomplete/.test(document.querySelector('#status')?.textContent ?? ''), null, { timeout: 30_000 })
        break
      } catch (error) {
        if (error.name !== 'TimeoutError' || attempt === 23) throw error
        console.log('FORK_SYNC', JSON.stringify({ wallet: index, seconds: Math.round((Date.now() - syncStart) / 1000),
          status: await page.locator('#status').innerText(), error: await page.locator('#error').innerText() }))
      }
    }
    assert((await page.locator('#status').innerText()).includes('Complete'), (await page.locator('#error').innerText()).slice(0, 500))
    assert(!(await page.locator('#ready-actions').isDisabled()), 'Deposits and spending must wait for verified wallet history.')
    result.synchronizationSeconds.push(Math.round((Date.now() - syncStart) / 1000))
    result.wallets.push(await page.evaluate(async (pass) => (await import('/tests/fork.fixture.ts')).loadForkSession(pass), password))
    const beforeWETH = BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance()))
    const beforeToken = BigInt(await page.evaluate(async (token) => (await import('/tests/fork.fixture.ts')).forkBalance(token), buy))
    phase = `wallet-${index}-local-native-shield`
    const shieldHash = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkShieldETH('0.02'))
    result.operations.push({ wallet: index, type: 'shield', hash: shieldHash })
    for (let i = 0; i < 60; i++) {
      const balance = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance())
      if (BigInt(balance) === beforeWETH + 19_950_000_000_000_000n) break
      await delay(2000)
    }
    assert.equal(BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance())), beforeWETH + 19_950_000_000_000_000n)
    phase = `wallet-${index}-real-proof-and-operator-signature`
    const swapHash = await page.evaluate(async (quote) => (await import('/tests/fork.fixture.ts')).forkOperatorSwap(quote), { ...operator.quote(), buy })
    result.operations.push({ wallet: index, type: 'swap', buy, hash: swapHash })
    phase = `wallet-${index}-verify-private-output`
    let privateOutput = 0n
    for (let i = 0; i < 60; i++) {
      privateOutput = BigInt(await page.evaluate(async (token) => (await import('/tests/fork.fixture.ts')).forkBalance(token), buy))
      if (privateOutput > beforeToken) break
      await delay(2000)
    }
    assert(privateOutput > beforeToken)
    assert.equal((await rpc.getTransactionReceipt(swapHash)).status, 1)
    await checkReplay(page, swapHash)
    for (const token of [buy, 'WETH']) {
      phase = `wallet-${index}-withdraw-${token}`
      const recipient = Wallet.createRandom().address
      const contract = new Contract(operator.tokens.find((t) => t.symbol === token).address,
        ['function balanceOf(address) view returns (uint256)'], rpc)
      const before = await contract.balanceOf(recipient)
      const withdrawal = await page.evaluate(async (options) => (await import('/tests/fork.fixture.ts')).forkOperatorWithdrawal(options),
        { ...operator.quote(token), token, recipient })
      assert.equal((await rpc.getTransactionReceipt(withdrawal.hash)).status, 1)
      const received = (await contract.balanceOf(recipient)) - before
      assert(received >= BigInt(withdrawal.minimum) && received <= BigInt(withdrawal.amount))
      result.operations.push({ wallet: index, type: 'withdrawal', token, recipient, received: received.toString(), ...withdrawal })
      await checkReplay(page, withdrawal.hash)
    }
    phase = `wallet-${index}-warm-reload`
    const warmStart = Date.now()
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('#password').fill(password); await page.locator('#unlock').click()
    await page.waitForFunction(() => !document.documentElement.dataset.busy)
    await page.waitForFunction(() => document.querySelector('#ready-actions')?.disabled === false)
    assert.equal(await page.evaluate(async (pass) => (await import('/tests/fork.fixture.ts')).loadForkSession(pass), password), result.wallets[index])
    result.warmSynchronizationSeconds.push(Math.round((Date.now() - warmStart) / 1000))
    if (index === 1) {
      phase = 'independent-view-only-fee-history'
      const input = { ...await operator.feeHistoryIdentity(), ledger: (await operator.stats()).ledger }
      result.feeHistory = await page.evaluate(async (data) => (await import('/tests/fork.fixture.ts')).verifyForkFeeHistory(data), input)
      assert.equal(result.feeHistory.verifiedNotes, 6)
      await assert.rejects(() => page.evaluate(async (data) => (await import('/tests/fork.fixture.ts')).verifyForkFeeHistory(data),
        { ...input, ledger: [{ ...input.ledger[0], hash: `0x${'12'.repeat(32)}` }] }), /did not authenticate/)
      result.feeHistoryRejectsWrongHash = true
    }
    await context.close(); context = undefined
    if (index === 0) { phase = 'request-journal-restart'; operator.restart() }
  }
  assert.equal(new Set(result.wallets).size, 2)
  result.operator = await operator.stats()
  assert.equal(result.operator.submissions, 6)
  assert.equal(result.operator.signatures, 6)
  assert.equal(result.operator.journaled, 0)
  assert.equal(result.operator.historicalPilot, 'historical-fork-pilot')
  assert.equal(result.operator.underpaymentRejected, true)
  assert.equal(result.operator.exposureWei, result.operator.nativeGasSpentWei)
  assert(BigInt(result.operator.exposureWei) <= 1_500_000_000_000_000n)
  assert.equal(result.operator.race?.validFeeBearingRequest, true)
  assert.equal(result.operator.race?.guardedRejection, 'UnexpectedDelegate')
  assert.equal(result.operator.protectedWrites, 6)
  assert.equal(result.operator.leakedWrite, false)
  assert.match(result.operator.receivedFeeCommitment, /^0x[0-9a-f]{64}$/)
  result.passed = true
  console.log('OPERATOR_FORK_ROUNDTRIP_PASS', JSON.stringify(result))
} finally {
  clearInterval(heartbeat)
  clearInterval(diskGuard)
  if (context) result.browserStatus = await context.pages()[0]?.evaluate(() => ({
    status: document.querySelector('#status')?.textContent, error: document.querySelector('#error')?.textContent,
  })).catch(() => undefined)
  const closed = await Promise.allSettled([
    Promise.resolve().then(() => writeFileSync(join(root, 'result.json'), JSON.stringify({ ...result, phase }, null, 2), { mode: 0o600 })),
    context?.close(), operator?.stop(),
  ])
  rpc.destroy()
  const failures = closed.filter((result) => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Fork browser cleanup failed.')
}
