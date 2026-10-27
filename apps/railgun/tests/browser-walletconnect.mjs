import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import { Contract, Interface, JsonRpcProvider, Wallet, parseEther } from 'ethers'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { forkMarker } from '../src/fork-marker.ts'

const url = new URL(process.env.RAILGUN_BROWSER_URL || 'http://127.0.0.1:4322')
const rpcUrl = new URL(process.env.RAILGUN_FORK_RPC_URL || 'http://127.0.0.1:8549')
for (const value of [url, rpcUrl]) assert(['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname))
const projectId = process.env.VITE_WALLETCONNECT_PROJECT_ID
assert(projectId, 'Set the public WalletConnect project ID')
const rpc = new JsonRpcProvider(rpcUrl.href, 1)
const metadata = await rpc.send('anvil_metadata', [])
assert.equal(metadata.forkedNetwork?.chainId, 1, 'Only a local Ethereum Anvil fork is allowed')
const marker = forkMarker(metadata)
assert.equal(await rpc.getCode(marker.address), marker.code, 'Prepare the local fork marker first')
const require = createRequire(import.meta.url)
const ethRequire = createRequire(require.resolve('@walletconnect/ethereum-provider'))
const universalRequire = createRequire(ethRequire.resolve('@walletconnect/universal-provider'))
const engineRequire = createRequire(require.resolve('@railgun-community/engine'))
const shieldABI = new Interface(engineRequire('./abi/V2.1/RailgunSmartWallet.json'))
const { SignClient } = await import(pathToFileURL(universalRequire.resolve('@walletconnect/sign-client')).href)
const storage = await mkdtemp(join(tmpdir(), 'ophis-walletconnect-test-'))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()
page.setDefaultTimeout(120_000)
const wallet = Wallet.createRandom().connect(rpc)
const weth = new Contract('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', [
  'function deposit() payable', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
], wallet)
const proxy = NETWORK_CONFIG[NetworkName.Ethereum].proxyContract
const relay = NETWORK_CONFIG[NetworkName.Ethereum].relayAdaptContract
const nativeAmount = parseEther('0.001')
const hashes = []
let client
try {
  // WalletConnect reads use the dApp RPC, not the wallet's RPC. Fork builds deliberately reject it.
  // Exercise the ethereum build only with this guarded fixture and our own fork-only signing wallet.
  await page.route(`${url.origin}/rpc`, async (route) => {
    const payload = route.request().postDataJSON()
    const execute = async (call) => {
      try {
        assert(!['eth_sendRawTransaction', 'eth_sendTransaction'].includes(call.method), 'Only the fork wallet may send')
        if (['anvil_metadata', 'hardhat_metadata'].includes(call.method)) throw new Error('Metadata unavailable in fixture')
        return { jsonrpc: '2.0', id: call.id, result: await rpc.send(call.method, call.params || []) }
      } catch (error) {
        return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: error.message } }
      }
    }
    const result = Array.isArray(payload) ? await Promise.all(payload.map(execute)) : await execute(payload)
    await route.fulfill({ json: result })
  })
  await rpc.send('anvil_setBalance', [wallet.address, '0xde0b6b3a7640000'])
  client = await SignClient.init({
    projectId, telemetryEnabled: false,
    storageOptions: { database: join(storage, 'wallet.db') },
    metadata: { name: 'Ophis fork test wallet', description: 'Test funds only', url: url.origin, icons: [] },
  })
  const requested = []
  client.on('session_request', async ({ id, topic, params }) => {
    try {
      assert.equal(params.chainId, 'eip155:1')
      assert.equal(params.request.method, 'eth_sendTransaction')
      const [tx] = params.request.params
      assert.equal(tx.from.toLowerCase(), wallet.address.toLowerCase())
      assert([weth.target.toLowerCase(), proxy.toLowerCase(), relay.toLowerCase()].includes(tx.to.toLowerCase()))
      const value = BigInt(tx.value || '0x0')
      assert.equal(value, tx.to.toLowerCase() === relay.toLowerCase() ? nativeAmount : 0n)
      requested.push(tx)
      const response = await wallet.sendTransaction({
        to: tx.to, data: tx.data, value, gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
      })
      hashes.push(response.hash)
      await client.respond({ topic, response: { id, jsonrpc: '2.0', result: response.hash } })
    } catch (error) {
      await client.respond({ topic, response: { id, jsonrpc: '2.0', error: { code: 5000, message: error.message } } })
    }
  })
  client.on('session_proposal', async ({ id, params }) => {
    assert.equal(params.proposer.metadata.name, 'Ophis Private Wallet')
    const { acknowledged } = await client.approve({ id, namespaces: {
      eip155: { chains: ['eip155:1'], accounts: [`eip155:1:${wallet.address}`],
        methods: ['eth_sendTransaction', 'wallet_switchEthereumChain'], events: ['accountsChanged', 'chainChanged'] },
    } })
    await acknowledged()
  })
  await page.goto(url.href)
  assert.equal(await page.locator('#environment').innerText(), 'Ethereum mainnet')
  await page.locator('#generate').click()
  await page.locator('#password').fill('disposable-fork-test-password')
  await page.locator('#backup').check()
  await page.locator('#open').click()
  const idle = () => page.waitForFunction(() => !document.documentElement.dataset.busy)
  await idle()
  assert(await page.locator('#wallet').isVisible(), await page.locator('#error').innerText())
  await page.locator('#connect').click()
  await idle()
  assert.match(await page.locator('#error').innerText(), /Use WalletConnect/)
  assert.match(await page.locator('#public-wallet-error').innerText(), /Use WalletConnect/)
  await page.locator('#walletconnect').click()
  await page.waitForFunction(() => document.querySelector('#walletconnect-link').value.startsWith('wc:'))
  const cancelledURI = await page.locator('#walletconnect-link').inputValue()
  assert(!(await page.locator('#walletconnect-cancel').isDisabled()))
  await page.locator('#walletconnect-cancel').click()
  await idle()
  assert.match(await page.locator('#error').innerText(), /cancelled/)
  await page.locator('#walletconnect').click()
  await page.waitForFunction(() => document.querySelector('#walletconnect-link').value.startsWith('wc:'))
  const uri = await page.locator('#walletconnect-link').inputValue()
  assert.notEqual(uri, cancelledURI)
  await client.pair({ uri })
  await idle()
  assert.match(await page.locator('#public-wallet-status').innerText(), new RegExp(wallet.address))
  assert.equal(requested.length, 0, 'Connecting must never sign a transaction')
  assert.equal(await page.locator('#shield-amount').inputValue(), '')
  assert(!(await page.locator('#approve').isVisible()))
  assert(!(await page.locator('#shield').isVisible()))
  assert.equal(await page.locator('#shield-token').inputValue(), 'ETH')
  assert.equal(await weth.balanceOf(wallet.address), 0n)
  assert.equal(await weth.allowance(wallet.address, proxy), 0n)
  const nativeBefore = BigInt(await rpc.send('eth_getBalance', [wallet.address, 'latest']))
  await page.locator('#shield-amount').fill('0.001')
  await page.locator('#review-shield').click()
  await idle()
  assert(!(await page.locator('#approve').isVisible()))
  assert(await page.locator('#shield').isVisible())
  await page.locator('#shield').click()
  await idle()
  assert.match(await page.locator('#public-transaction-status').innerText(), /Deposit confirmed/, await page.locator('#error').innerText())
  assert.equal(hashes.length, 1, 'Native ETH must require exactly one deposit transaction and no approval')
  const nativeReceipt = await rpc.getTransactionReceipt(hashes[0])
  assert.equal(nativeReceipt.status, 1)
  assert.equal(nativeReceipt.to.toLowerCase(), relay.toLowerCase())
  const nativeAfter = BigInt(await rpc.send('eth_getBalance', [wallet.address, 'latest']))
  assert.equal(nativeBefore - nativeAfter, nativeAmount + nativeReceipt.gasUsed * nativeReceipt.gasPrice)
  const event = nativeReceipt.logs.filter((log) => log.address.toLowerCase() === proxy.toLowerCase())
    .map((log) => shieldABI.parseLog(log)).find((log) => log?.name === 'Shield')
  assert(event, 'Canonical Railgun proxy must emit a private Shield commitment')
  assert.equal(event.args.commitments.length, 1)
  assert.equal(event.args.commitments[0].token.tokenAddress.toLowerCase(), weth.target.toLowerCase())
  assert(event.args.commitments[0].value > 0n)
  assert.equal(event.args.commitments[0].value + event.args.fees[0], nativeAmount)
  assert.equal(await weth.balanceOf(wallet.address), 0n, 'No separately wrapped public WETH')
  assert.equal(await weth.allowance(wallet.address, proxy), 0n, 'No ERC20 approval for native ETH')
  console.log('NATIVE_ETH_RECEIPT', JSON.stringify({ hash: nativeReceipt.hash, gasUsed: nativeReceipt.gasUsed.toString(), privateWETH: event.args.commitments[0].value.toString(), railgunFee: event.args.fees[0].toString() }))
  console.log('NATIVE_ETH_PASS: one 0.001 ETH wallet transaction, canonical Relay Adapt, correct ETH debit plus gas, private WETH commitment plus fee equals deposit, no public WETH or allowance.')
  await (await weth.deposit({ value: parseEther('0.0001') })).wait()
  await page.locator('#shield-token').selectOption('WETH')
  await page.locator('#shield-amount').fill('0.001')
  await page.locator('#review-shield').click()
  await idle()
  assert.match(await page.locator('#public-wallet-error').innerText(), /Public wallet balance: 0\.0001 WETH[\s\S]*Choose ETH as the deposit asset/)
  assert(!(await page.locator('#approve').isVisible()))
  assert(!(await page.locator('#shield').isVisible()))
  assert.equal(requested.length, 1, 'Insufficient WETH must not request another transaction')
  await page.locator('#shield-amount').fill('0.0001')
  await page.locator('#review-shield').click()
  await idle()
  assert(await page.locator('#approve').isVisible())
  assert(!(await page.locator('#shield').isVisible()))
  await page.locator('#approve').click()
  await idle()
  assert.match(await page.locator('#status').innerText(), /Approval confirmed/)
  assert(!(await page.locator('#approve').isVisible()))
  await page.locator('#shield').click()
  await idle()
  assert.match(await page.locator('#public-transaction-status').innerText(), /Deposit confirmed/, await page.locator('#error').innerText())
  assert.equal(hashes.length, 3)
  for (const hash of hashes) assert.equal((await rpc.getTransactionReceipt(hash)).status, 1)
  assert.equal(await weth.balanceOf(wallet.address), 0n)
  assert.equal(await weth.allowance(wallet.address, proxy), 0n)
  const [session] = client.session.getAll()
  await client.emit({ topic: session.topic, chainId: 'eip155:1', event: {
    name: 'accountsChanged', data: [Wallet.createRandom().address],
  } })
  await page.waitForFunction(() => document.querySelector('#public-wallet-status').textContent.includes('changed'))
  assert(!(await page.locator('#shield').isVisible()))
  await page.locator('#disconnect-public').click()
  await idle()
  assert.match(await page.locator('#public-wallet-status').innerText(), /disconnected/)
  assert(await page.locator('#walletconnect').isVisible())
  console.log('PASS: real WalletConnect relay on an empty amount, QR cancel/retry, native ETH deposit without approval or manual wrapping, ERC20 balance and allowance checks, exact approval and shield receipts, account invalidation and disconnect; fork funds only.')
} finally {
  await context.close()
  await browser.close()
  for (const session of client?.session.getAll() || []) {
    await client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'Test complete' } }).catch(() => {})
  }
  await client?.core.relayer.transportClose()
  client?.core.heartbeat.stop()
  rpc.destroy()
  await rm(storage, { recursive: true, force: true })
}
