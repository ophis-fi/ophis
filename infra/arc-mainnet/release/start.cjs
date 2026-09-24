// Explicit operator action only. Never called by tests, render, plan, or CI.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { dep, checkHash, build, compile } = require('./plan.cjs')
const { readSolver } = require('./solver.cjs')
const { JsonRpcProvider } = dep('@ethersproject/providers')
const { verify } = require('./verify.cjs')
const OUT = path.join(__dirname, 'generated')

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--start'], 'Explicit --start required')
  const read = name => JSON.parse(fs.readFileSync(path.join(OUT, name + '.json')))
  const plan = read('plan')
  checkHash(plan)
  assert.deepEqual(build(plan.config, compile().artifacts), plan)
  if (process.platform === 'darwin') {
    const { verifyRamKey, probeDockerMount } = require('./mac-key.cjs')
    verifyRamKey(process.env.ARC_SOLVER_KEY_FILE)
    probeDockerMount()
  }
  const { keyFile, address: signer } = readSolver(process.env.ARC_SOLVER_KEY_FILE)
  assert(fs.statSync(OUT).uid === process.getuid(), 'Release directory must have the same owner as the key')
  process.env.ARC_SOLVER_KEY_FILE = keyFile
  process.env.ARC_RUNTIME_UID = String(process.getuid())
  process.env.ARC_RUNTIME_GID = String(process.getgid())
  assert.equal(signer, plan.config.solver, 'Signer differs from authorized solver')
  const rpc = new JsonRpcProvider('https://rpc.mainnet.arc.io', { name: 'arc', chainId: 5042 })
  const verified = await verify(rpc, plan, read('receipts'), read('artifacts'))
  assert((await rpc.getBalance(plan.config.solver)).gte(BigInt(plan.config.gasLimit) * BigInt(plan.config.maxFeePerGas)), 'Fund native USDC gas for the solver')
  const tip = await rpc.getBlock('latest'), older = await rpc.getBlock(tip.number - 100)
  assert(tip.timestamp > older.timestamp, 'Cannot measure block cadence')
  assert(plan.config.submissionDeadlineBlocks * (tip.timestamp - older.timestamp) / 100 >= 60, 'Submission deadline must allow at least 60 seconds at current cadence')
  const space = fs.statfsSync(__dirname)
  assert(space.bavail * space.bsize >= 3 * 1024 ** 3, 'Keep at least 3 GiB free before starting services')
  fs.writeFileSync(path.join(OUT, 'verified.json'), JSON.stringify(verified, null, 2) + '\n', { mode: 0o600 })
  execFileSync('python3', [path.join(__dirname, 'render.py'), '--activate'], { stdio: 'inherit' })
  // Build images explicitly on a sufficiently sized host; starting never triggers a build.
  execFileSync('docker', ['compose', '-f', path.join(__dirname, 'docker-compose.yml'), 'config', '--quiet'], { stdio: 'inherit' })
  execFileSync('docker', ['compose', '-f', path.join(__dirname, 'docker-compose.yml'), 'up', '-d', '--no-build', '--pull', 'never'], { stdio: 'inherit' })
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
