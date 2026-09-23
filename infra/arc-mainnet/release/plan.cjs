// Offline only: compile source and prepare unsigned, nonce-bound deployment transactions.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../../..')
const dep = createRequire(path.join(root, 'apps/frontend/apps/cowswap-frontend/package.json'))
const { getAddress, getContractAddress } = dep('@ethersproject/address')
const { Interface, defaultAbiCoder } = dep('@ethersproject/abi')
const { keccak256 } = dep('@ethersproject/keccak256')
const { toUtf8Bytes } = dep('@ethersproject/strings')
const artifactDir = path.join(root, 'apps/backend/contracts/artifacts')
const proxyFile = path.join(root, 'contracts/deployments/robinhood-mainnet/GPv2AllowListAuthentication_Proxy.json')
const address = value => { const result = getAddress(value); assert(!/^0x0{40}$/i.test(result), 'Zero address'); return result }

function validate(config) {
  assert.equal(config.chainId, 5042)
  for (const key of ['deployer', 'safe', 'solver']) config[key] = address(config[key])
  config.safeOwners = config.safeOwners.map(address)
  assert.equal(config.safeOwners.length, 3)
  assert.equal(new Set(config.safeOwners).size, 3, 'Exactly three distinct Safe owners required')
  assert.equal(new Set([config.safe, config.solver, config.deployer]).size, 3)
  assert(!config.safeOwners.includes(config.solver), 'Separate online solver from governance signers')
  assert(Number.isSafeInteger(config.nonce) && config.nonce >= 0 && config.nonce <= Number.MAX_SAFE_INTEGER - 7)
  assert(Number.isSafeInteger(config.submissionDeadlineBlocks) && config.submissionDeadlineBlocks >= 120)
  assert(/^[1-9]\d*$/.test(config.maxFeePerGas))
  assert(BigInt(config.maxFeePerGas) <= 100_000_000_000n, 'Gas price exceeds the release cap')
  assert(Number.isSafeInteger(config.gasLimit) && config.gasLimit >= 1_000_000 && config.gasLimit <= 15_000_000)
  for (const field of ['orderbookUrl', 'frontendOrigin', 'explorerOrigin']) {
    const url = new URL(config[field])
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash)
    assert(url.hostname.includes('.') && !/^(localhost|\d+\.|\[)/.test(url.hostname))
    assert.equal(url.pathname, '/', 'Publish each service on its own host')
    config[field] = url.origin
  }
  return config
}

function compile() {
  const sources = {}
  function add(file) {
    if (sources[file]) return
    const content = fs.readFileSync(path.join(root, file), 'utf8')
    sources[file] = { content }
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["']\s*;/g)) {
      add(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])))
    }
  }
  for (const file of ['contracts/src/contracts/GPv2Settlement.sol', 'contracts/src/contracts/GPv2AllowListAuthentication.sol',
    'apps/backend/contracts/solidity/Balances.sol', 'apps/backend/contracts/solidity/Signatures.sol',
    'infra/arc-mainnet/ArcDisabledVault.sol']) add(file)
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 1000000 }, evmVersion: 'shanghai',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode', 'metadata'] } } } }
  const binary = process.env.ARC_SOLC || path.join(process.env.HOME, '.solc-select/artifacts/solc-0.8.30/solc-0.8.30')
  const compiler = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
  assert.match(compiler, /Version: 0\.8\.30\+commit\.73712a01/)
  const output = JSON.parse(execFileSync(binary, ['--standard-json'], { input: JSON.stringify(input), maxBuffer: 16 * 1024 * 1024 }))
  assert(!(output.errors || []).some(error => error.severity === 'error'), JSON.stringify(output.errors))
  const artifacts = {}
  for (const contracts of Object.values(output.contracts)) for (const [name, item] of Object.entries(contracts)) {
    artifacts[name] = { abi: item.abi, bytecode: '0x' + item.evm.bytecode.object,
      deployedBytecode: '0x' + item.evm.deployedBytecode.object, immutableReferences: item.evm.deployedBytecode.immutableReferences, metadata: item.metadata }
  }
  // Reuse the already deployed non-transparent governance proxy and trampoline bytecode.
  artifacts.EIP173Proxy = JSON.parse(fs.readFileSync(proxyFile))
  artifacts.HooksTrampoline = JSON.parse(fs.readFileSync(path.join(artifactDir, 'HooksTrampoline.json')))
  artifacts._build = { compiler, sourceHash: keccak256(toUtf8Bytes(JSON.stringify(input))),
    proxyHash: keccak256(toUtf8Bytes(JSON.stringify(artifacts.EIP173Proxy))),
    hooksHash: keccak256(toUtf8Bytes(JSON.stringify(artifacts.HooksTrampoline))) }
  return { input, artifacts }
}

function build(config, artifacts) {
  config = validate({ ...config })
  const transactions = [], contracts = {}
  function deploy(name, artifactName, args = []) {
    const artifact = artifacts[artifactName], nonce = config.nonce + transactions.length
    const predicted = getContractAddress({ from: config.deployer, nonce })
    const iface = new Interface(artifact.abi)
    const data = ('0x' + artifact.bytecode.replace(/^0x/, '') + iface.encodeDeploy(args).slice(2)).toLowerCase()
    transactions.push({ name, artifact: artifactName, from: config.deployer, chainId: 5042, nonce, value: '0',
      gasLimit: config.gasLimit, maxFeePerGas: config.maxFeePerGas, maxPriorityFeePerGas: '1', data,
      predictedAddress: predicted, constructorArgs: iface.encodeDeploy(args), initcodeHash: keccak256(data) })
    contracts[name] = predicted
    return predicted
  }
  const implementation = deploy('authImplementation', 'GPv2AllowListAuthentication')
  const initialize = new Interface(artifacts.GPv2AllowListAuthentication.abi).encodeFunctionData('initializeManager', [config.safe])
  const auth = deploy('authenticator', 'EIP173Proxy', [implementation, config.safe, initialize])
  const vault = deploy('vault', 'ArcDisabledVault')
  const settlement = deploy('settlement', 'GPv2Settlement', [auth, vault])
  contracts.vaultRelayer = getContractAddress({ from: settlement, nonce: 1 })
  deploy('Balances', 'Balances'); deploy('Signatures', 'Signatures'); deploy('HooksTrampoline', 'HooksTrampoline', [settlement])
  const safeTransaction = { to: auth, value: '0', data: new Interface(artifacts.GPv2AllowListAuthentication.abi).encodeFunctionData('addSolver', [config.solver]), operation: 0 }
  const plan = { version: 1, chainId: 5042, status: 'planned', build: artifacts._build, config, contracts, transactions, safeTransaction }
  return { ...plan, hash: keccak256(toUtf8Bytes(JSON.stringify(plan))) }
}

function checkHash(plan) {
  const { hash, ...body } = plan
  assert.equal(keccak256(toUtf8Bytes(JSON.stringify(body))), hash, 'Plan changed since preparation')
  validate({ ...plan.config })
  assert.deepEqual(build(plan.config, JSON.parse(fs.readFileSync(path.join(__dirname, 'generated/artifacts.json')))), plan)
}

if (require.main === module) {
  assert.equal(process.argv.length, 3, 'Usage: node release/plan.cjs CONFIG.json')
  const config = JSON.parse(fs.readFileSync(process.argv[2])), built = compile()
  const out = path.join(__dirname, 'generated'); fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const plan = build(config, built.artifacts)
  for (const [name, value] of Object.entries({ 'solc-input': built.input, artifacts: built.artifacts, plan,
    'safe-activation': { version: '1.0', chainId: '5042', createdAt: Date.now(), meta: { name: 'Authorize Arc solver', createdFromSafeAddress: config.safe }, transactions: [plan.safeTransaction] } })) {
    fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  }
  console.log('Prepared seven unsigned deployments and one Safe activation transaction. Plan hash:', plan.hash)
}
module.exports = { root, dep, validate, compile, build, checkHash, address, defaultAbiCoder }
