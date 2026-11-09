import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, statfsSync, createWriteStream, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { JsonRpcProvider } from 'ethers'

// Starts its own node; there is deliberately no attach-to-an-existing-fork option.
const app = fileURLToPath(new URL('..', import.meta.url))
const chainId = Number(process.env.OPHIS_PREPAID_TEST_CHAIN_ID ?? 1)
assert([1, 56].includes(chainId), 'Only Ethereum and BNB have isolated prepaid fixtures.')
assert(!process.env.OPHIS_BROADCASTER_CHAIN_ID || process.env.OPHIS_BROADCASTER_CHAIN_ID === String(chainId), 'Conflicting immutable broadcaster chain.')
process.env.OPHIS_BROADCASTER_CHAIN_ID = String(chainId)
assert(chainId === 1 || process.env.OPHIS_PREPAID_TEST_UPSTREAM, 'Select an explicit public-state BNB read RPC.')
const upstream = process.env.OPHIS_PREPAID_TEST_UPSTREAM ?? 'http://100.69.134.7:8547'
assert(['http:', 'https:'].includes(new URL(upstream).protocol))
assert(!new URL(upstream).username && !new URL(upstream).password, 'Use a public-state read endpoint without embedded credentials.')
const readOnly = new JsonRpcProvider(upstream, chainId, { batchMaxCount: 1, cacheTimeout: -1 })
let forkBlock
try {
  assert.equal((await readOnly.getNetwork()).chainId, BigInt(chainId))
  forkBlock = process.env.OPHIS_PREPAID_TEST_FORK_BLOCK === undefined
    ? (await readOnly.getBlock('finalized'))?.number : Number(process.env.OPHIS_PREPAID_TEST_FORK_BLOCK)
} finally { readOnly.destroy() }
assert(Number.isSafeInteger(forkBlock) && forkBlock > 0, 'A finalized public-state snapshot is required.')
const evidence = resolve(process.env.OPHIS_PREPAID_TEST_EVIDENCE ?? '/Users/scep/ophis-railgun-evidence/prepaid-20261108/real-proof-fork')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(evidence, chainId === 56 ? 'bnb-' : 'ethereum-'))
const anvilTemporary = join(root, 'anvil-tmp')
mkdirSync(anvilTemporary, { mode: 0o700 })
const freeBytes = () => { const state = statfsSync(root); return state.bavail * state.bsize }
assert(freeBytes() >= 6 * 1024 ** 3, 'The existing 6GiB disk reserve is required.')
const chooser = createServer()
await new Promise((accept) => chooser.listen(0, '127.0.0.1', accept))
const port = chooser.address().port
await new Promise((accept) => chooser.close(accept))
const rpcURL = `http://127.0.0.1:${port}`
const anvil = process.env.OPHIS_PREPAID_TEST_ANVIL ?? join(homedir(), '.foundry/bin/anvil')
assert(anvil.startsWith('/'), 'An absolute Anvil binary path is required.')
const args = ['--fork-url', upstream, '--fork-block-number', String(forkBlock), '--host', '127.0.0.1',
  '--port', String(port), '--chain-id', String(chainId), '--hardfork', 'prague', '--no-storage-caching', '--quiet',
  '--max-persisted-states', '64', '--cache-path', anvilTemporary,
  '--gas-price', chainId === 56 ? '50000000' : '100000', '--base-fee', chainId === 56 ? '1' : '7',
  ...(chainId === 56 ? ['--disable-min-priority-fee'] : [])]
const output = createWriteStream(join(root, 'anvil.log'), { mode: 0o600 })
// RPC caching and historical-state persistence are separate Anvil storage paths.
const child = spawn(anvil, args, { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(output); child.stderr.pipe(output)
let childError
child.once('error', (error) => { childError = error })
const control = new JsonRpcProvider(rpcURL, chainId, { cacheTimeout: -1, batchMaxCount: 1 })
let instance, processIdentity, heartbeat, guard, complete = false, phase = 'owned-node-startup'
const processLine = () => execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' }).trim()
const progress = (next, details) => {
  if (next !== 'cleanup') phase = next
  console.log('PREPAID_FORK_PROGRESS', JSON.stringify({ phase: next, ...(details === undefined ? {} : { details }), freeBytes: freeBytes(), root }))
}
const assertOwned = async () => {
  assert(!childError && child.exitCode === null && child.pid, 'The fixture-owned Anvil is no longer running.')
  assert.equal(processLine(), processIdentity, 'The spawned process identity changed.')
  const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split(/\s+/)
  assert.deepEqual([...new Set(listeners)], [String(child.pid)], 'Loopback RPC must belong only to this spawned process.')
  const metadata = await control.send('anvil_metadata', [])
  assert.equal(metadata.instanceId, instance.instanceId)
  assert.equal(metadata.forkedNetwork.chainId, chainId)
  assert.equal(metadata.forkedNetwork.forkBlockNumber, forkBlock)
  assert.equal((await control.getNetwork()).chainId, BigInt(chainId))
  assert(freeBytes() >= 6 * 1024 ** 3, 'The existing 6GiB disk reserve was reached; stop the disposable test.')
}
try {
  for (let i = 0; i < 60; i++) {
    if (childError) throw childError
    if (child.exitCode !== null) throw new Error(`Owned Anvil exited ${child.exitCode}; see ${root}/anvil.log`)
    try { instance = await control.send('anvil_metadata', []); break } catch { await delay(500) }
  }
  assert(instance?.instanceId && instance.forkedNetwork, 'The owned fork did not become ready.')
  processIdentity = processLine()
  assert.equal(Number(processIdentity.match(/^\s*(\d+)/)?.[1]), process.getuid())
  await assertOwned()
  writeFileSync(join(root, 'ownership.json'), JSON.stringify({ pid: child.pid, parentPid: process.pid, uid: process.getuid(),
    processIdentity, rpcURL, upstream, chainId, forkBlock, instanceId: instance.instanceId, binary: anvil,
    binarySha256: createHash('sha256').update(readFileSync(anvil)).digest('hex'), launchedByThisRunner: true }, null, 2), { mode: 0o600 })
  progress('owned-node-verified')
  await control.send('evm_setNextBlockTimestamp', [Math.max((await control.getBlock('latest')).timestamp + 1, Math.floor(Date.now() / 1000))])
  await control.send('anvil_setNextBlockBaseFeePerGas', [chainId === 56 ? '0x1' : '0x7'])
  await control.send('anvil_mine', [2])
  await control.send('evm_setIntervalMining', [1])
  heartbeat = setInterval(() => progress(phase), 30_000)
  guard = setInterval(() => {
    if (freeBytes() < 6.05 * 1024 ** 3) {
      console.error('PREPAID_FORK_DISK_RESERVE', phase)
      child.kill('SIGTERM')
      clearInterval(guard)
    }
  }, 1000)
  const compiled = join(root, 'prepaid-fork.mjs')
  await build({ entryPoints: [join(app, 'tests/prepaid-fork.fixture.ts')], bundle: true, platform: 'node', format: 'esm',
    packages: 'external', outfile: compiled, absWorkingDir: app,
    define: { 'import.meta.env': JSON.stringify({ VITE_RAILGUN_CHAIN_ID: String(chainId), VITE_RAILGUN_ENVIRONMENT: 'fork' }) } })
  // External packages resolve from the application, while the generated fixture remains in disposable evidence.
  const { symlinkSync } = await import('node:fs')
  symlinkSync(join(app, 'node_modules'), join(root, 'node_modules'), 'dir')
  const { prepaidFork } = await import(compiled)
  const result = await prepaidFork({ rpc: rpcURL, root, forkBlock, assertOwned, progress })
  complete = result.passed === true
  console.log('PREPAID_FORK_RESULT', JSON.stringify(result))
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ phase, message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined, passed: false, freeBytes: freeBytes() }, null, 2), { mode: 0o600 })
  throw error
} finally {
  clearInterval(heartbeat); clearInterval(guard)
  control.destroy()
  if (child.exitCode === null) child.kill('SIGTERM')
  for (let i = 0; i < 50 && child.exitCode === null; i++) await delay(100)
  if (child.exitCode === null) child.kill('SIGKILL')
  output.end()
  writeFileSync(join(root, 'stopped.json'), JSON.stringify({ complete, phase, ownedPid: child.pid, exitCode: child.exitCode,
    signalCode: child.signalCode, stoppedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  // Only synthetic state created by this invocation; never touch another fork/profile.
  rmSync(join(root, 'synthetic-state'), { recursive: true, force: true })
  rmSync(anvilTemporary, { recursive: true, force: true })
  rmSync(join(root, 'node_modules'), { force: true })
}
