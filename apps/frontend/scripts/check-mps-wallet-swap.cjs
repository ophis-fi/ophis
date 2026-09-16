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
const MPS = '0x96c645D3D3706f793Ef52C19bBACe441900eD47D'
const provider = new JsonRpcProvider(rpcUrl, 1)
const signer = Wallet.createRandom().connect(provider)
const rpc = (method, params = []) => provider.send(method, params)
async function main() {
  assert.match(await rpc('web3_clientVersion'), /anvil/i)
  const account = signer.address
  await rpc('anvil_setBalance', [account, '0x56bc75e2d63100000'])
  await rpc('anvil_setCode', [account, '0x'])
  await rpc('evm_mine')
  const snapshot = await rpc('evm_snapshot')
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
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
    await page.route(frontendRpc, async (route) => route.fulfill({ response: await route.fetch({ url: rpcUrl }) }))
    let sent = 0
    await page.exposeFunction('forkRpc', async (method, params) => {
      if (method === 'wallet_getCapabilities') return {}
      if (method !== 'eth_sendTransaction') return rpc(method, params)
      const { gas, from, chainId, ...tx } = params[0]
      assert.equal(from.toLowerCase(), account.toLowerCase())
      assert.equal(Number(chainId), 1)
      assert.equal(tx.to.toLowerCase(), '0x66a9893cc07d91d95644aedd05d03f95e1dba8af')
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
    await page.goto(`${frontend}/#/1/swap/ETH/${MPS}`)
    const input = page.locator('#input-currency-input input')
    await input.waitFor({ timeout: 90000 })
    await page.waitForTimeout(3000)
    await input.fill('0.0033')
    const card = page.getByRole('region', { name: 'Best MPS route' })
    await card.waitFor({ timeout: 90000 })
    await card.getByRole('button', { name: 'Review swap', exact: true }).click()
    await card.getByText('Recipient:', { exact: false }).waitFor()
    await input.fill('0.0034')
    await card.getByRole('button', { name: 'Review swap', exact: true }).waitFor({ timeout: 90000 })
    assert.equal(await card.getByRole('button', { name: 'Confirm swap', exact: true }).count(), 0)
    await input.fill('0.0033')
    await card.getByRole('button', { name: 'Review swap', exact: true }).click({ timeout: 90000 })
    await card.getByRole('button', { name: 'Confirm swap', exact: true }).click()
    await card.getByRole('status').filter({ hasText: 'Received 1 MPS' }).waitFor({ timeout: 90000 })
    assert.equal(sent, 1)
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
