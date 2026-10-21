import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { boundIndexerResponse, cachedIndexerResponse } from './fork-indexer.mjs'
import { chromium } from '@playwright/test'
import { Contract, JsonRpcProvider, JsonRpcSigner } from 'ethers'
import { forkMarker } from '../src/fork-marker.ts'

const rpc = new JsonRpcProvider('http://127.0.0.1:8549', 1)
const metadata = await rpc.send('anvil_metadata', [])
assert(metadata.forkedNetwork?.chainId === 1, 'Only a local Anvil Ethereum fork is allowed')
const marker = forkMarker(metadata)
await rpc.send('anvil_setCode', [marker.address, marker.code])
await rpc.send('evm_setIntervalMining', [1])
const block = metadata.forkedNetwork.forkBlockNumber
const profile = process.env.RAILGUN_TEST_PROFILE || resolve('test-results/fork-profile')
const publicCache = `${profile}-public-indexer-cache`
mkdirSync(publicCache, { recursive: true })
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(chromium.executablePath())
    ? chromium.executablePath()
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const page = context.pages()[0] || (await context.newPage())
page.setDefaultTimeout(60_000)
page.on('pageerror', (error) => console.log('PAGEERROR', error.message))
page.on('console', (message) => {
  if (message.text().startsWith('[fork')) console.log(message.text())
})

if (process.env.RAILGUN_TEST_RPC_GATEWAY) {
  const gateway = new URL(process.env.RAILGUN_TEST_RPC_GATEWAY)
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname), 'Only a local gateway is allowed')
  await page.route('http://127.0.0.1:4319/rpc', async (route) => {
    const payload = route.request().postDataJSON()
    const calls = Array.isArray(payload) ? payload : [payload]
    // Only the test's unlocked public wallet and gas sponsor bypass the production gateway.
    if (calls.some((call) => ['eth_accounts', 'eth_sendTransaction'].includes(call.method))) return route.continue()
    const headers = { ...route.request().headers() }
    delete headers.origin
    const response = await route.fetch({ url: gateway.href, headers })
    if (!response.ok()) console.error('GATEWAY_REJECTED', calls.map((call) => call.method), await response.text())
    await route.fulfill({ response })
  })
}

// Live indexers continue past the pinned fork. Keep their public history at the fork height.
await page.route('https://rail-squid.squids.live/**/graphql', async (route) => {
  try {
  const body = route.request().postDataJSON()
  const cache = join(
    publicCache,
    `${createHash('sha256')
      .update(`${block}:${JSON.stringify(body)}`)
      .digest('hex')}.json`,
  )
  const payload = await cachedIndexerResponse(cache, () =>
    route.fetch({ postData: JSON.stringify(body), timeout: 90_000 }),
  )
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify(boundIndexerResponse(payload, block)),
  })
  } catch (error) {
    console.error('FORK_INDEXER_UNAVAILABLE', error.message)
    await route.abort('failed').catch(() => {})
  }
})
await context.addInitScript(() => {
  window.ethereum = {
    request: async ({ method, params = [] }) => {
      const response = await fetch('/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: method === 'eth_requestAccounts' ? 'eth_accounts' : method,
          params,
        }),
      })
      const body = await response.json()
      if (body.error) throw new Error(body.error.message)
      return body.result
    },
  }
})

async function idle() {
  await page.waitForFunction(() => !document.documentElement.dataset.busy, { timeout: 90_000 })
}
async function fundUSDC(address, amount) {
  const factory = new Contract(
    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    ['function getPool(address,address,uint24) view returns(address)'],
    rpc,
  )
  const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const holder = await factory.getPool(token, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 500)
  await rpc.send('anvil_impersonateAccount', [holder])
  await rpc.send('anvil_setBalance', [holder, '0x56bc75e2d63100000'])
  const contract = new Contract(
    token,
    ['function transfer(address,uint256) returns(bool)'],
    new JsonRpcSigner(rpc, holder),
  )
  await (await contract.transfer(address, amount)).wait()
  await rpc.send('anvil_stopImpersonatingAccount', [holder])
}

try {
  await page.goto('http://127.0.0.1:4319/')
  await page.evaluate(async () => (await import('/tests/diagnostics.fixture.ts')).enableForkDiagnostics())
  await page.locator('#password').fill('local-test-password-railgun')
  await page.locator('#unlock').click()
  await idle()
  if ((await page.locator('#error').innerText()).includes('Create or restore')) {
    await page.locator('#generate').click()
    await page.locator('#backup').check()
    await page.locator('#open').click()
    await idle()
  }
  assert(await page.locator('#wallet').isVisible(), await page.locator('#error').innerText())
  for (const iteration of Array.from({ length: 120 }, (_, index) => index)) {
    const state = await page.locator('#status').innerText()
    console.log('SYNC', iteration, state)
    if (state.includes('Complete')) break
    if (state.includes('Incomplete')) throw new Error('Fork history did not synchronize')
    await page.waitForTimeout(10_000)
  }
  assert((await page.locator('#status').innerText()).includes('Complete'), 'History sync deadline reached')
  await page.evaluate(async () =>
    (await import('/tests/fork.fixture.ts')).loadForkSession('local-test-password-railgun'),
  )
  const previousPrivate = BigInt(
    await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkBalance()),
  )
  const previousWeth = BigInt(
    await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance()),
  )
  const publicWallet = await rpc.getSigner(0)
  await fundUSDC(await publicWallet.getAddress(), 100_000_000n)
  await page.locator('#amount').fill('50')
  await page.locator('#connect').click()
  await idle()
  if (await page.locator('#approve').isVisible()) {
    await page.locator('#approve').click()
    await idle()
  }
  await page.locator('#shield').click()
  await idle()
  assert.equal(await page.locator('#error').innerText(), '')
  const privateBalance = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkBalance())
  assert(BigInt(privateBalance) - previousPrivate > 49_000_000n, 'New shielded private balance missing')
  console.log('SHIELD_PASS', privateBalance)
  const swapHash = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkSwap('USDC', '5'))
  console.log('PRIVATE_SWAP_PASS', swapHash)
  assert(
    BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkWethBalance())) > previousWeth,
    'Private WETH balance did not increase',
  )
  const beforeReverse = BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkBalance()))
  const reverseHash = await page.evaluate(async () =>
    (await import('/tests/fork.fixture.ts')).forkSwap('WETH', '0.0001'),
  )
  assert(
    BigInt(await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkBalance())) > beforeReverse,
    'Reverse swap did not increase private USDC',
  )
  console.log('REVERSE_SWAP_PASS', reverseHash)
  const destination = await (await rpc.getSigner(1)).getAddress()
  const usdc = new Contract(
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    ['function balanceOf(address) view returns(uint256)'],
    rpc,
  )
  const previousPublic = await usdc.balanceOf(destination)
  const withdrawal = await page.evaluate(
    async (address) => (await import('/tests/fork.fixture.ts')).forkWithdrawal(address),
    destination,
  )
  console.log('WITHDRAWAL_PASS', withdrawal)
  assert((await usdc.balanceOf(destination)) - previousPublic > 990_000n, 'Withdrawal recipient was not paid')
  const account = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkAccount(0))
  await fundUSDC(account, 1_000_000n)
  await (await publicWallet.sendTransaction({ to: account, value: 10n ** 17n })).wait()
  const recoveryHash = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).forkRecovery(0))
  const status = await page.evaluate(async () => (await import('/tests/fork.fixture.ts')).recoveryStatus(0))
  assert(status.includes('USDC: 0'), 'Public USDC remained after recovery')
  console.log('RECOVERY_PASS', recoveryHash)
  await page.screenshot({ path: `${profile}-roundtrip.png`, fullPage: true })
} finally {
  await rpc.send('evm_setIntervalMining', [0])
  await rpc.send('evm_setAutomine', [true])
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
  await context.close()
  rpc.destroy()
}
