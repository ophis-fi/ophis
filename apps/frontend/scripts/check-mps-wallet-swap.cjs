// Run against a local frontend and Anvil mainnet fork. Never submits on a live network.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const appRequire = createRequire(resolve(__dirname, '../apps/cowswap-frontend/package.json'))
const { Wallet } = appRequire('@ethersproject/wallet')
const { JsonRpcProvider } = appRequire('@ethersproject/providers')
const rpcUrl = process.env.MPS_FORK_RPC || 'http://127.0.0.1:8560'
const frontend = process.env.MPS_FRONTEND || 'http://127.0.0.1:4176'
const frontendRpc = process.env.MPS_FRONTEND_RPC || 'http://127.0.0.1:8557'
const inputToken = process.env.MPS_INPUT || 'ETH'
const inputAmount = inputToken === 'USDC' ? '10' : (process.env.MPS_AMOUNT || '0.0033')
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const MPS = '0x96c645D3D3706f793Ef52C19bBACe441900eD47D'
const provider = new JsonRpcProvider(rpcUrl, 1)
const signer = Wallet.createRandom().connect(provider)
const rpc = (method, params = []) => provider.send(method, params)
async function main() {
  assert.match(await rpc('web3_clientVersion'), /anvil/i)
  const account = signer.address
  await rpc('anvil_setBalance', [account, '0x56bc75e2d63100000'])
  await rpc('anvil_setCode', [account, '0x'])
  await rpc('anvil_setBlockTimestampInterval', [1])
  await rpc('anvil_setNextBlockBaseFeePerGas', ['0x5f5e100'])
  await rpc('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)])
  await rpc('evm_mine')
  const snapshot = await rpc('evm_snapshot')
  if (inputToken === 'USDC') {
    const whale = '0x55FE002aefF02F77364de339a1292923A15844B8'
    await rpc('anvil_impersonateAccount', [whale])
    await rpc('anvil_setBalance', [whale, '0x3635c9adc5dea00000'])
    const { Contract } = appRequire('@ethersproject/contracts')
    const usdc = new Contract(USDC, ['function transfer(address,uint256) returns(bool)'], provider.getSigner(whale))
    await (await usdc.transfer(account, 10000000)).wait()
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    page.on('pageerror', error => console.error('Page error:', error.message))
    // Limit unrelated balance lookups; all quote, simulation and execution calls use real fork state.
    const lists = require('../libs/tokens/src/const/tokensList.json')
    const sources = new Set(
      Object.values(lists)
        .flat()
        .map((list) => list.source),
    )
    await page.route(
      (url) => sources.has(url.href),
      async (route) => {
        const data = await (await route.fetch()).json()
        data.tokens = data.tokens.filter(
          (token) => ['ETH', 'WETH', 'USDC', 'MPS'].includes(token.symbol) && token.chainId === 1,
        )
        await route.fulfill({ json: data })
      },
    )
    const cowRejections = []
    if (process.env.MPS_COW_UNSUPPORTED)
      await page.route('**/quote', async (route) => {
        const body = route.request().postDataJSON()
        if (body?.buyToken?.toLowerCase() !== MPS.toLowerCase()) return route.fallback()
        cowRejections.push(true)
        await route.fulfill({
          status: 400,
          json: { errorType: 'UnsupportedToken', description: 'CoW-only test rejection' },
        })
      })
    let stallRefresh = false
    let markStalled
    const refreshStalled = new Promise((resolve) => {
      markStalled = resolve
    })
    await page.route(frontendRpc + '/**', async (route) => {
      const body = route.request().postDataJSON()
      if (
        stallRefresh &&
        body.method === 'eth_estimateGas' &&
        body.params[0]?.to?.toLowerCase() === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
      ) {
        markStalled()
        return new Promise(() => {})
      }
      const response = await route.fetch({ url: rpcUrl })
      const result = await response.json()
      if (result.error) console.error('Fork RPC error:', body.method, result.error.code, result.error.message)
      return route.fulfill({ response })
    })
    let sent = 0
    await page.exposeFunction('forkRpc', async (method, params) => {
      if (method === 'wallet_getCapabilities') return process.env.MPS_CAPABILITIES_STALL ? new Promise(() => {}) : {}
      if (method !== 'eth_sendTransaction') return rpc(method, params)
      const { gas, from, chainId, ...tx } = params[0]
      assert.equal(from.toLowerCase(), account.toLowerCase())
      assert.equal(Number(chainId), 1)
      assert(['0x66a9893cc07d91d95644aedd05d03f95e1dba8af', USDC.toLowerCase(), '0x000000000022d473030f116ddee9f6b43ac78ba3'].includes(tx.to.toLowerCase()))
      sent++
      return (await signer.sendTransaction({ ...tx, gasLimit: gas, chainId: 1 })).hash
    })
    await page.addInitScript(
      ({ account }) => {
        localStorage.setItem('ophis_consent', 'denied')
        localStorage.setItem('forceProdApi', 'true')
        window.ethereum = {
          autoConnect: true,
          isMetaMask: true,
          isConnected: () => true,
          _metamask: { isUnlocked: async () => true },
          on: () => {},
          removeListener: () => {},
          request: async ({ method, params = [] }) =>
            ['eth_accounts', 'eth_requestAccounts'].includes(method) ? [account] : window.forkRpc(method, params),
        }
      },
      { account },
    )
    await page.goto(`${frontend}/#/1/swap/${inputToken}/${MPS}`)
    const input = page.locator('#input-currency-input input')
    await input.waitFor({ timeout: 90000 })
    await page.waitForTimeout(3000)
    await input.fill(inputAmount)
    const card = page.getByRole('region', { name: 'Best MPS route' })
    await card.waitFor({ timeout: 90000 }).catch(async error => { console.log((await page.locator('body').innerText()).slice(-7000)); throw error })
    if (process.env.MPS_REFRESH_STALL) {
      stallRefresh = true
      await Promise.race([
        refreshStalled,
        new Promise((_, reject) => setTimeout(() => reject(new Error('No background refresh')), 30000)),
      ])
      await page.clock.setFixedTime(Date.now() + 31000)
      await page.getByText('Comparing swap routes…', { exact: true }).waitFor({ timeout: 5000 })
      assert.equal(await page.getByRole('button', { name: 'Swap', exact: true }).count(), 0)
      assert.equal(sent, 0)
      console.log('PASS: expired cached quote keeps CoW actions suppressed during background refresh')
      return
    }
    if (inputToken === 'USDC') {
      await card.getByRole('button', { name: 'Approve USDC', exact: true }).click()
      await card.getByRole('button', { name: 'Review swap', exact: true }).waitFor({ timeout: 90000 })
    }
    assert.equal(await card.locator('[aria-expanded="false"]').count(), 1)
    if (process.env.MPS_SCREENSHOT) await page.screenshot({ path: process.env.MPS_SCREENSHOT.replace('.png', '-quote.png'), fullPage: true })
    await card.getByRole('button', { name: 'Review swap', exact: true }).click()
    await page.locator('#input-currency-preview').waitFor()
    assert.equal(await input.count(), 0, 'review replaces editable inputs')
    await page.getByText('Recipient:', { exact: false }).waitFor()
    if (process.env.MPS_SCREENSHOT) await page.screenshot({ path: process.env.MPS_SCREENSHOT.replace('.png', '-review.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await input.waitFor()
    await input.fill(inputToken === 'USDC' ? '9' : '0.0034')
    await card.getByRole('button', { name: 'Review swap', exact: true }).waitFor({ timeout: 90000 })
    assert.equal(await card.getByRole('button', { name: 'Confirm swap', exact: true }).count(), 0)
    await input.fill(inputAmount)
    await card.getByRole('button', { name: 'Review swap', exact: true }).click({ timeout: 90000 })
    if (process.env.MPS_REVIEW_EXPIRY) {
      await card.getByRole('button', { name: 'Refresh quote', exact: true }).waitFor({ timeout: 35000 })
      assert.equal(sent, inputToken === 'USDC' ? 2 : 0, 'expiry must not sign a swap')
      await card.getByRole('button', { name: 'Refresh quote', exact: true }).click()
      await input.waitFor()
      await card.getByRole('button', { name: 'Review swap', exact: true }).click({ timeout: 90000 })
    }
    await card.getByRole('button', { name: 'Confirm swap', exact: true }).click()
    await card.getByRole('status').filter({ hasText: 'Received 1 MPS' }).waitFor({ timeout: 90000 })
    if (process.env.MPS_COW_UNSUPPORTED) assert(cowRejections.length > 0)
    assert.equal(sent, inputToken === 'USDC' ? 3 : 1)
    assert(await card.getByRole('button', { name: 'Swap submitted', exact: true }).isDisabled())
    const balance = await rpc('eth_call', [
      { to: MPS, data: '0x70a08231' + account.slice(2).toLowerCase().padStart(64, '0') },
      'latest',
    ])
    assert.equal(BigInt(balance), 1n)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    console.log(await card.innerText())
    if (process.env.MPS_SCREENSHOT) await page.screenshot({ path: process.env.MPS_SCREENSHOT, fullPage: true })
  } finally {
    await browser.close()
    await rpc('evm_revert', [snapshot])
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
