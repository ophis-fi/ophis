import assert from 'node:assert/strict'
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers'
import { NETWORK_CONFIG } from '@railgun-community/shared-models'
import { PRIVATE_NETWORKS } from '../src/networks.ts'
import { zanRpcUrl, RPC_BATCH_SIZE } from '../rpc-policy.ts'

// Read-only: an empty generated account authorizes an adapter getter; nothing is broadcast.
const gateway = process.env.RAILGUN_READINESS_GATEWAY
if (gateway) {
  const url = new URL(gateway)
  assert(url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'HTTPS or loopback gateway required')
}
const endpoints = {
  1: process.env.RAILGUN_RPC_URL,
  42161: process.env.RAILGUN_ARBITRUM_RPC_URL || zanRpcUrl(42161, process.env.RAILGUN_ZAN_API_KEY),
  137: process.env.RAILGUN_POLYGON_RPC_URL || zanRpcUrl(137, process.env.RAILGUN_ZAN_API_KEY),
  56: process.env.RAILGUN_BNB_RPC_URL || zanRpcUrl(56, process.env.RAILGUN_ZAN_API_KEY),
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
  const token = !gateway && network.chainId === 1 ? process.env.RAILGUN_RPC_TOKEN : undefined
  if (token) transport.setHeader('Authorization', `Bearer ${token}`)
  const provider = new JsonRpcProvider(transport, undefined, { batchMaxCount: RPC_BATCH_SIZE })
  const report = { network: network.name, chainId: network.chainId, ok: false }
  try {
    assert.equal(Number((await provider.getNetwork()).chainId), network.chainId)
    const config = NETWORK_CONFIG[network.network]
    const registry = new Contract(config.railgunRegistryContract, ['function getContractAddress(string) view returns(address)'], provider)
    const empty = Wallet.createRandom()
    const authorization = await empty.authorize({ address: config.relayAdapt7702Contract, chainId: network.chainId, nonce: 0 })
    const abi = new Interface(['function adaptImplementation() view returns(address)'])
    const transaction = {
      to: empty.address, from: '0x0000000000000000000000000000000000000001',
      data: abi.encodeFunctionData('adaptImplementation'), type: 4, gasLimit: 1000000n, authorizationList: [authorization],
    }
    const [codes, registered, actual, trace, block] = await Promise.all([
      Promise.all([config.proxyContract, config.relayAdapt7702Contract, network.router, network.quoter].map((address) => provider.getCode(address))),
      registry.getContractAddress('RelayAdapt7702'),
      provider.call(transaction),
      provider.send('debug_traceCall', [provider.getRpcTransaction(transaction), 'latest', { tracer: 'callTracer', timeout: '5s' }]),
      provider.getBlockNumber(),
    ])
    assert(codes.every((code) => code !== '0x'), 'Required contract is missing')
    assert.equal(getAddress(registered), getAddress(config.relayAdapt7702Contract))
    assert.equal(getAddress(abi.decodeFunctionResult('adaptImplementation', actual)[0]), getAddress(config.relayAdapt7702Contract))
    assert.equal(trace.type, 'CALL')
    assert(!trace.error, 'Canonical delegated trace failed')
    assert.equal(getAddress(abi.decodeFunctionResult('adaptImplementation', trace.output)[0]), getAddress(config.relayAdapt7702Contract))
    report.block = block
    report.delegationAndTrace = true
    report.ok = true
  } catch (error) {
    report.error = error.error?.message || error.info?.error?.message || error.shortMessage || error.code || error.name
  } finally { provider.destroy() }
  reports.push(report)
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true, reports }, null, 2))
if (reports.some((report) => !report.ok)) process.exitCode = 1
