import assert from 'node:assert/strict'
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers'
import { NETWORK_CONFIG } from '@railgun-community/shared-models'
import { PRIVATE_NETWORKS } from '../src/networks.ts'
import { isAlchemyUrl, isValidationCloudUrl, zanRpcUrl, RPC_BATCH_SIZE } from '../rpc-policy.ts'

// Read-only: an empty generated account authorizes an adapter getter; nothing is broadcast.
const gateway = process.env.RAILGUN_READINESS_GATEWAY
if (gateway) {
  const url = new URL(gateway)
  assert(url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'HTTPS or loopback gateway required')
}
if (process.env.RAILGUN_READINESS_BUDGET_ONLY === '1') {
  assert(gateway && process.env.RAILGUN_RPC_TOKEN, 'A gateway and existing deployment credential are required')
  const target = new URL(gateway)
  assert(target.origin === 'https://swap.ophis.fi' || ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Deployment credential may only reach Ophis or loopback')
  const reports = []
  for (const provider of ['alchemy', 'validationCloud']) {
    const response = await fetch(new URL(`/rpc/budget/${provider}`, gateway), {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RAILGUN_RPC_TOKEN}`, 'User-Agent': 'Ophis-Private-Wallet/1.0' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    })
    const result = await response.json().then((value) => value && typeof value === 'object' ? value : {}, () => ({}))
    const diagnostic = result.diagnostic && typeof result.diagnostic === 'object'
      ? Object.fromEntries(['stage', 'name', 'message'].map((field) => [field, typeof result.diagnostic[field] === 'string'
        ? result.diagnostic[field].replaceAll(process.env.RAILGUN_RPC_TOKEN, '[redacted]')
          .replace(/https?:\/\/\S+|Bearer\s+\S+|[A-Za-z0-9_+\/=-]{24,}/gi, '[redacted]').slice(0, 500) : undefined])) : undefined
    reports.push({ provider, ok: response.ok && result.allowed === true && Number.isSafeInteger(result.remainingCU) && result.remainingCU >= 1600,
      status: response.status, remainingCU: typeof result.remainingCU === 'number' ? result.remainingCU : undefined, diagnostic })
  }
  await new Promise((resolve) => process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(), fixedBudgetProbe: true, reports }, null, 2) + '\n', resolve))
  process.exit(reports.every((report) => report.ok) ? 0 : 1)
}
const endpoints = {
  1: process.env.RAILGUN_RPC_URL,
  42161: process.env.RAILGUN_ARBITRUM_RPC_URL || zanRpcUrl(42161, process.env.RAILGUN_ZAN_API_KEY),
  137: process.env.RAILGUN_POLYGON_RPC_URL || zanRpcUrl(137, process.env.RAILGUN_ZAN_API_KEY),
  56: process.env.RAILGUN_BNB_RPC_URL || zanRpcUrl(56, process.env.RAILGUN_ZAN_API_KEY),
}
const extendedEndpoints = {
  42161: process.env.RAILGUN_ARBITRUM_VALIDATION_CLOUD_URL,
  137: process.env.RAILGUN_POLYGON_VALIDATION_CLOUD_URL,
  56: process.env.RAILGUN_BNB_VALIDATION_CLOUD_URL,
}
const reports = []
// All three vendor-backed networks share one account's credits/second budget.
for (const network of PRIVATE_NETWORKS) {
  const endpoint = gateway ? new URL(network.chainId === 1 ? '/rpc' : `/rpc/${network.chainId}`, gateway).href : endpoints[network.chainId]
  assert(endpoint, 'Configure this network RPC or the existing server-only provider credential')
  const transport = new FetchRequest(endpoint)
  transport.timeout = 20000
  transport.setThrottleParams({ maxAttempts: 2, slotInterval: 1000 })
  transport.setHeader('User-Agent', 'Ophis-Private-Wallet/1.0')
  if (!gateway && isAlchemyUrl(network.chainId, endpoint)) transport.setHeader('Origin', 'https://swap.ophis.fi')
  const token = !gateway && network.chainId === 1 ? process.env.RAILGUN_RPC_TOKEN : undefined
  if (token) transport.setHeader('Authorization', `Bearer ${token}`)
  const provider = new JsonRpcProvider(transport, undefined, { batchMaxCount: RPC_BATCH_SIZE })
  let tracing = provider
  const report = { network: network.name, chainId: network.chainId, ok: false }
  try {
    assert.equal(Number((await provider.getNetwork()).chainId), network.chainId)
    if (!gateway && isAlchemyUrl(network.chainId, endpoint)) {
      const extended = extendedEndpoints[network.chainId]
      assert(extended && isValidationCloudUrl(network.chainId, extended), 'Pinned free Validation Cloud transport required for traces and log scans')
      const extendedTransport = new FetchRequest(extended)
      extendedTransport.timeout = 20000
      extendedTransport.setThrottleParams({ maxAttempts: 1, slotInterval: 1000 })
      extendedTransport.setHeader('User-Agent', 'Ophis-Private-Wallet/1.0')
      tracing = new JsonRpcProvider(extendedTransport, undefined, { batchMaxCount: RPC_BATCH_SIZE })
      assert.equal(Number((await tracing.getNetwork()).chainId), network.chainId)
    }
    const config = NETWORK_CONFIG[network.network]
    const registry = new Contract(config.railgunRegistryContract, ['function getContractAddress(string) view returns(address)'], provider)
    const empty = Wallet.createRandom()
    const authorization = await empty.authorize({ address: config.relayAdapt7702Contract, chainId: network.chainId, nonce: 0 })
    const abi = new Interface(['function adaptImplementation() view returns(address)'])
    const transaction = {
      to: empty.address, from: '0x0000000000000000000000000000000000000001',
      data: abi.encodeFunctionData('adaptImplementation'), type: 4, gasLimit: 1000000n, authorizationList: [authorization],
    }
    const [codes, registered, actual, block] = await Promise.all([
      Promise.all([config.proxyContract, config.relayAdapt7702Contract, network.router, network.quoter].map((address) => provider.getCode(address))),
      registry.getContractAddress('RelayAdapt7702'),
      provider.call(transaction),
      provider.getBlockNumber(),
    ])
    assert(codes.every((code) => code !== '0x'), 'Required contract is missing')
    assert.equal(getAddress(registered), getAddress(config.relayAdapt7702Contract))
    assert.equal(getAddress(abi.decodeFunctionResult('adaptImplementation', actual)[0]), getAddress(config.relayAdapt7702Contract))
    // Finish the primary reads before ethers can batch them with a Validation Cloud trace.
    const trace = await tracing.send('debug_traceCall', [provider.getRpcTransaction(transaction), 'latest', { tracer: 'callTracer', timeout: '5s' }])
    assert.equal(trace.type, 'CALL')
    assert(!trace.error, 'Canonical delegated trace failed')
    assert.equal(getAddress(abi.decodeFunctionResult('adaptImplementation', trace.output)[0]), getAddress(config.relayAdapt7702Contract))
    report.block = block
    report.delegationAndTrace = true
    const proxy = NETWORK_CONFIG[network.network].proxyContract
    const fromBlock = Math.max(0, block - 499)
    await tracing.getLogs({ address: proxy, fromBlock, toBlock: block })
    report.logs500Blocks = true
    report.ok = true
  } catch (error) {
    report.error = error.error?.message || error.info?.error?.message || error.shortMessage || error.code || error.name
  } finally { if (tracing !== provider) tracing.destroy(); provider.destroy() }
  reports.push(report)
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true, reports }, null, 2))
if (reports.some((report) => !report.ok)) process.exitCode = 1
