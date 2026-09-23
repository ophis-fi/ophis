// Disposable governance/deployment rehearsal. Fixed loopback URL; no forks or real keys.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { root, dep, validate, compile, build, checkHash } = require('./plan.cjs')
const { verify } = require('./verify.cjs')
const { prepare } = require('./solver.cjs')
const { Wallet } = dep('@ethersproject/wallet')
const { JsonRpcProvider } = dep('@ethersproject/providers')
const { Contract, ContractFactory } = dep('@ethersproject/contracts')
const { hexConcat } = dep('@ethersproject/bytes')
const OUT = path.join(__dirname, 'generated')
const ZERO = '0x0000000000000000000000000000000000000000'
const TYPES = { SafeTx: [ ['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
  ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'], ['refundReceiver', 'address'], ['nonce', 'uint256'],
].map(([name, type]) => ({ name, type })) }

async function main() {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json')))
  assert.equal(example.solver, null, 'Never default to another chain\'s submitter')
  assert.throws(() => validate(example), /dedicated Arc submitter/)
  const check = net.createServer()
  await new Promise((resolve, reject) => { check.once('error', reject); check.listen(31559, '127.0.0.1', resolve) })
  await new Promise(resolve => check.close(resolve))
  const anvil = spawn(process.env.ARC_ANVIL || 'anvil', ['--chain-id', '5042', '--port', '31559', '--host', '127.0.0.1', '--silent'], { stdio: 'ignore' })
  const rpc = new JsonRpcProvider('http://127.0.0.1:31559', { chainId: 5042, name: 'local-arc' })
  rpc.pollingInterval = 50
  let solverDirectory
  try {
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      assert(anvil.exitCode === null, 'Owned Anvil process exited')
      try { await rpc.send('anvil_nodeInfo', []); ready = true } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    assert(ready)
    assert.equal(await rpc.send('eth_chainId', []), '0x13b2')
    assert(!(await rpc.send('anvil_nodeInfo', [])).forkConfig?.forkUrl)
    const accounts = await rpc.listAccounts(), signer = rpc.getSigner(accounts[0])
    const owners = accounts.slice(1, 4)
    const fixture = name => { const a = JSON.parse(fs.readFileSync(path.join(root, 'apps/backend/contracts/artifacts', name + '.json'))); return { ...a, abi: [...a.abi, ...(a._disabled || [])] } }
    const safeArtifact = fixture('GnosisSafe'), factoryArtifact = fixture('GnosisSafeProxyFactory')
    async function deploy(a, args = []) { const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args); await c.deployTransaction.wait(); return c }
    const singleton = await deploy(safeArtifact), factory = await deploy(factoryArtifact)
    const initializer = singleton.interface.encodeFunctionData('setup', [owners, 2, ZERO, '0x', ZERO, ZERO, 0, ZERO])
    const safeAddress = await factory.callStatic.createProxyWithNonce(singleton.address, initializer, 5042)
    await (await factory.createProxyWithNonce(singleton.address, initializer, 5042)).wait()
    const safe = new Contract(safeAddress, safeArtifact.abi, signer)
    solverDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-rehearsal-solver-'))
    fs.chmodSync(solverDirectory, 0o700)
    const solverKey = path.join(solverDirectory, 'submitter.key')
    const config = prepare({ ...example, deployer: accounts[0], safe: safeAddress, safeOwners: owners },
      path.join(solverDirectory, 'config.json'), solverKey, await signer.getTransactionCount(), true)
    // Disposable local key only; the production startup never exports key material.
    const solver = new Wallet(fs.readFileSync(solverKey, 'utf8').trim(), rpc)
    const compiled = compile(), plan = build(config, compiled.artifacts)
    fs.mkdirSync(OUT, { recursive: true, mode: 0o700 })
    // Rehearsal output is separate from a prepared operator plan.
    const artifactsFile = path.join(OUT, 'artifacts.json')
    const previous = fs.existsSync(artifactsFile) ? fs.readFileSync(artifactsFile) : null
    fs.writeFileSync(artifactsFile, JSON.stringify(compiled.artifacts), { mode: 0o600 })
    try {
      checkHash(plan)
      const receipts = []
      for (const tx of plan.transactions) {
        const { name, artifact, predictedAddress, constructorArgs, initcodeHash, ...request } = tx
        const receipt = await (await signer.sendTransaction(request)).wait()
        assert.equal(receipt.contractAddress, predictedAddress)
        assert(receipt.gasUsed.lt(tx.gasLimit), `${name} exceeds configured gas`)
        receipts.push(receipt)
      }
      const auth = new Contract(plan.contracts.authenticator, compiled.artifacts.GPv2AllowListAuthentication.abi, signer)
      assert.equal(await auth.isSolver(config.deployer), false)
      await assert.rejects(auth.callStatic.initializeManager(config.deployer))
      await assert.rejects(auth.callStatic.addSolver(config.solver))
      await assert.rejects(auth.connect(rpc.getSigner(owners[0])).callStatic.addSolver(config.solver))
      const proxy = new Contract(auth.address, compiled.artifacts.EIP173Proxy.abi, signer)
      await assert.rejects(proxy.callStatic.upgradeTo(plan.contracts.authImplementation))
      await assert.rejects(proxy.connect(rpc.getSigner(owners[0])).callStatic.upgradeTo(plan.contracts.authImplementation))
      await (await signer.sendTransaction({ to: config.solver, value: '1000000000000000000' })).wait()
      const settlement = new Contract(plan.contracts.settlement, compiled.artifacts.GPv2Settlement.abi, solver)
      await assert.rejects(settlement.callStatic.settle([], [], [], [[], [], []]))
      async function safeCall(data, count = 2) {
        const tx = { to: auth.address, value: 0, data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce: await safe.nonce() }
        const signatures = []
        for (const owner of owners.slice(0, count).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
          signatures.push(await rpc.getSigner(owner)._signTypedData({ chainId: 5042, verifyingContract: safe.address }, TYPES, tx))
        }
        const args = [tx.to, 0, data, 0, 0, 0, 0, ZERO, ZERO, hexConcat(signatures)]
        if (count < 2) return safe.callStatic.execTransaction(...args)
        assert.equal(await safe.callStatic.execTransaction(...args), true)
        return (await safe.execTransaction(...args)).wait()
      }
      await assert.rejects(safeCall(plan.safeTransaction.data, 1))
      await safeCall(plan.safeTransaction.data)
      await (await settlement.settle([], [], [], [[], [], []])).wait()
      const result = await verify(rpc, plan, receipts, compiled.artifacts, true)
      const relayer = new Contract(plan.contracts.vaultRelayer, compiled.artifacts.GPv2VaultRelayer.abi, signer)
      await assert.rejects(relayer.callStatic.transferFromAccounts([]))
      await assert.rejects(rpc.send('eth_call', [{ to: plan.contracts.vault, data: '0x12345678' }, 'latest']))
      await assert.rejects(rpc.send('eth_call', [{ from: config.deployer, to: plan.contracts.vault, value: '0x1' }, 'latest']))
      await safeCall(auth.interface.encodeFunctionData('removeSolver', [config.solver]))
      await assert.rejects(settlement.callStatic.settle([], [], [], [[], [], []]))
      await assert.rejects(verify(rpc, plan, receipts, compiled.artifacts, false))
      fs.writeFileSync(path.join(OUT, 'rehearsal.json'), JSON.stringify({ ...result, revokedSuccessfully: true, gasUsed: receipts.map(r => r.gasUsed.toString()) }, null, 2) + '\n', { mode: 0o600 })
      console.log('PASS: seven production deployments; 2-of-3 Safe activation; single-owner denial; runtime/domain/wiring verification; solver revocation; no production activation from a local node.')
    } finally { if (previous) fs.writeFileSync(artifactsFile, previous); else fs.unlinkSync(artifactsFile) }
  } finally {
    anvil.kill('SIGTERM'); rpc.removeAllListeners()
    if (solverDirectory) fs.rmSync(solverDirectory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
