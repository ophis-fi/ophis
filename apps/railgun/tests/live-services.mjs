import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { FetchRequest, Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers'
import { ABIRelayAdapt7702 } from '@railgun-community/engine'
import { NETWORK_CONFIG, NetworkName, TXIDVersion } from '@railgun-community/shared-models'

assert(process.env.RAILGUN_READINESS_RPC_URL, 'Select an explicitly trusted Ethereum RPC')
const transport = new FetchRequest(process.env.RAILGUN_READINESS_RPC_URL)
transport.setHeader('User-Agent', 'Ophis-Private-Wallet/1.0')
if (process.env.RAILGUN_READINESS_RPC_TOKEN)
  transport.setHeader('Authorization', `Bearer ${process.env.RAILGUN_READINESS_RPC_TOKEN}`)
const provider = new JsonRpcProvider(transport)
const config = NETWORK_CONFIG[NetworkName.Ethereum]
const report = { checks: {}, scope: 'Read-only service readiness; no live PPOI proof or transaction submission' }
async function check(name, action) {
  try { report.checks[name] = { ok: true, result: await action() } }
  catch (error) { report.checks[name] = { ok: false, error: error.error || error.shortMessage || error.message } }
}
let browser
try {
  assert.equal((await provider.getNetwork()).chainId, 1n)
  for (const method of ['anvil_metadata', 'hardhat_metadata']) {
    const metadata = await provider.send(method, []).catch(() => undefined)
    assert(!metadata, 'Live readiness requires mainnet, not a local fork')
  }
  await check('node', async () => ({ client: await provider.send('web3_clientVersion', []), syncing: await provider.send('eth_syncing', []), block: await provider.getBlockNumber() }))
  // A new empty test account authorizes only a read simulation; no executable swap or wallet seed is involved.
  const ephemeral = Wallet.createRandom()
  const abi = new Interface(ABIRelayAdapt7702)
  const authorization = await ephemeral.authorize({ address: config.relayAdapt7702Contract, chainId: 1, nonce: 0 })
  const transaction = provider.getRpcTransaction({ to: ephemeral.address, from: '0x0000000000000000000000000000000000000001', data: abi.encodeFunctionData('adaptImplementation'), type: 4, gasLimit: 1_000_000n, authorizationList: [authorization] })
  await check('delegatedCall', async () => {
    const result = await provider.send('eth_call', [transaction, 'latest'])
    assert.equal(getAddress(abi.decodeFunctionResult('adaptImplementation', result)[0]), getAddress(config.relayAdapt7702Contract))
    return 'Canonical delegation executed'
  })
  await check('delegatedTrace', async () => {
    const trace = await provider.send('debug_traceCall', [transaction, 'latest', { tracer: 'callTracer', timeout: '5s' }])
    assert.equal(trace.type, 'CALL')
    assert(!trace.error)
    return '7702 callTracer available'
  })
  await check('livePPOI', async () => {
    const response = await fetch('https://ppoi.fdi.network', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ppoi_node_status', params: { txidVersion: TXIDVersion.V2_PoseidonMerkle } }), signal: AbortSignal.timeout(20_000) })
    assert(response.ok)
    const body = await response.json()
    assert(!body.error)
    const status = body.result.forNetwork.Ethereum
    assert(Number.isInteger(status.txidStatus.validatedTxidIndex))
    return status
  })
  await check('signedBroadcasterDiscovery', async () => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:4319')
    await page.evaluate(async () => (await import('/tests/discovery.fixture.ts')).discoverBroadcasters())
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const fees = await page.evaluate(async () => (await import('/tests/discovery.fixture.ts')).discoveredFees())
      if (fees.usdc > 0 && fees.weth > 0 && fees.canonical7702 > 0) return fees
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('No fresh compatible signed broadcaster advertisements before the discovery deadline')
  })
  console.log(JSON.stringify(report, null, 2))
  if (Object.values(report.checks).some((check) => !check.ok)) process.exitCode = 1
} finally {
  await browser?.close()
  provider.destroy()
}
