// Read-only post-deployment verification. Never signs or sends a transaction.
const fs = require('node:fs')
const assert = require('node:assert/strict')
const path = require('node:path')
const { root, dep, checkHash, address } = require('./plan.cjs')
const { JsonRpcProvider } = dep('@ethersproject/providers')
const { Contract } = dep('@ethersproject/contracts')
const { _TypedDataEncoder } = dep('@ethersproject/hash')
const { keccak256 } = dep('@ethersproject/keccak256')
const OUT = path.join(__dirname, 'generated')
const read = name => JSON.parse(fs.readFileSync(path.join(OUT, name + '.json')))
const SAFE_ABI = ['function getOwners() view returns(address[])', 'function getThreshold() view returns(uint256)',
  'function getModulesPaginated(address,uint256) view returns(address[],address)', 'function VERSION() view returns(string)']

async function checkSafe(rpc, config) {
  const blockTag = await rpc.getBlockNumber()
  const proxyCode = await rpc.getCode(config.safe, blockTag)
  assert.notEqual(proxyCode, '0x', 'Configured governance Safe is not deployed on Arc')
  // SafeProxy's executable code ends with RETURN/INVALID; only compiler metadata follows.
  // The vendored 1.3.0 artifact and 1.4.1/1.5.0 SafeProxy use this same dispatcher.
  const proxyArtifact = JSON.parse(fs.readFileSync(path.join(root, 'apps/backend/contracts/artifacts/GnosisSafeProxy.json')))
  const executable = '0x' + proxyArtifact.bytecode.split('f3fe')[1] + 'f3fe'
  assert(proxyCode.toLowerCase().startsWith(executable), 'Unknown Safe proxy bytecode')
  const singleton = address('0x' + (await rpc.getStorageAt(config.safe, 0, blockTag)).slice(-40))
  const singletonHash = keccak256(await rpc.getCode(singleton, blockTag))
  // @safe-global/safe-deployments 1.37.50, assets/v{1.3.0,1.4.1,1.5.0}/{gnosis_safe,safe}{,_l2}.json.
  const trusted = {
    '1.3.0': ['0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e', '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f'],
    '1.4.1': ['0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4', '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff'],
    '1.5.0': ['0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2', '0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc'],
  }
  const safe = new Contract(config.safe, SAFE_ABI, rpc)
  const version = await safe.VERSION({ blockTag })
  assert(trusted[version]?.includes(singletonHash), 'Unknown Safe singleton runtime')
  assert.deepEqual((await safe.getOwners({ blockTag })).map(address).sort(), config.safeOwners.map(address).sort(), 'Safe owners differ')
  assert.equal(String(await safe.getThreshold({ blockTag })), '2', 'Safe threshold must be 2 of 3')
  const [modules, next] = await safe.getModulesPaginated('0x0000000000000000000000000000000000000001', 10, { blockTag })
  assert.equal(modules.length, 0, 'Unexpected Safe modules can bypass owner signatures')
  assert.equal(next, '0x0000000000000000000000000000000000000001')
}

async function verify(rpc, plan, receipts, artifacts, localOnly = false) {
  checkHash(plan)
  assert.equal(await rpc.send('eth_chainId', []), '0x13b2')
  const client = await rpc.send('web3_clientVersion', [])
  if (localOnly) {
    assert.match(client, /anvil/i)
    assert(!(await rpc.send('anvil_nodeInfo', [])).forkConfig?.forkUrl)
  } else assert(!/anvil|hardhat|ganache/i.test(client), 'Local rehearsals cannot activate production')
  await checkSafe(rpc, plan.config)
  assert.equal(receipts.length, plan.transactions.length)
  const blocks = {}
  for (const [index, tx] of plan.transactions.entries()) {
    const receipt = await rpc.getTransactionReceipt(receipts[index].transactionHash)
    assert(receipt && receipt.status === 1 && receipt.confirmations >= 1)
    assert.equal(address(receipt.contractAddress), tx.predictedAddress)
    const actual = await rpc.getTransaction(receipt.transactionHash)
    assert.equal(address(actual.from), plan.config.deployer)
    assert.equal(actual.to, null)
    assert.equal(actual.data, tx.data)
    assert.equal(actual.nonce, tx.nonce)
    assert.equal(actual.value.toString(), '0')
    const code = await rpc.getCode(tx.predictedAddress)
    assert.notEqual(code, '0x')
    const artifact = artifacts[tx.artifact]
    if (artifact.deployedBytecode) {
      const mask = value => {
        const bytes = Buffer.from(value.slice(2), 'hex')
        for (const refs of Object.values(artifact.immutableReferences || {})) for (const ref of refs) bytes.fill(0, ref.start, ref.start + ref.length)
        return bytes.toString('hex')
      }
      assert.equal(mask(code), mask(artifact.deployedBytecode), `Runtime mismatch: ${tx.name}`)
    }
    blocks[tx.name] = receipt.blockNumber
  }
  const c = plan.contracts
  const auth = new Contract(c.authenticator, [...artifacts.GPv2AllowListAuthentication.abi, 'function owner() view returns(address)'], rpc)
  assert.equal(address(await auth.manager()), plan.config.safe)
  assert.equal(address(await auth.owner()), plan.config.safe)
  assert.equal(await auth.pendingManager(), '0x0000000000000000000000000000000000000000')
  const implementation = await rpc.getStorageAt(c.authenticator, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc')
  assert.equal(address('0x' + implementation.slice(-40)), c.authImplementation)
  assert.equal(await auth.isSolver(plan.config.solver), true, 'Execute the Safe activation batch first')
  assert.equal(await auth.isSolver(plan.config.deployer), false)
  const settlement = new Contract(c.settlement, artifacts.GPv2Settlement.abi, rpc)
  assert.equal(address(await settlement.authenticator()), c.authenticator)
  assert.equal(address(await settlement.vault()), c.vault)
  assert.equal(address(await settlement.vaultRelayer()), c.vaultRelayer)
  assert.equal(await settlement.domainSeparator(), _TypedDataEncoder.hashDomain({ name: 'Gnosis Protocol', version: 'v2', chainId: 5042, verifyingContract: c.settlement }))
  const hooks = new Contract(c.HooksTrampoline, artifacts.HooksTrampoline.abi, rpc)
  assert.equal(address(await hooks.settlement()), c.settlement)
  assert.notEqual(await rpc.getCode(c.vaultRelayer), '0x')
  return { planHash: plan.hash, chainId: 5042, localOnly, verifiedAt: new Date().toISOString(), contracts: c,
    settlementDeploymentBlock: blocks.settlement, solver: plan.config.solver, safe: plan.config.safe }
}

if (require.main === module) (async () => {
  assert.equal(process.argv.length, 2, 'Usage: ARC_READ_RPC_URL=... node release/verify.cjs')
  const endpoint = new URL(process.env.ARC_READ_RPC_URL)
  assert.equal(endpoint.protocol, 'https:')
  assert(['rpc.mainnet.arc.io', 'rpc.blockdaemon.mainnet.arc.io'].includes(endpoint.hostname), 'Use a free official endpoint')
  const rpc = new JsonRpcProvider(endpoint.href, { name: 'arc', chainId: 5042 })
  const result = await verify(rpc, read('plan'), read('receipts'), read('artifacts'))
  fs.writeFileSync(path.join(OUT, 'verified.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log('Verified deployment, Safe authority, solver authorization and contract wiring.')
})().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { verify, checkSafe }
