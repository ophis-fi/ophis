// Disposable fake keys and mount metadata only. Never sudo, RPC or canonical custody.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { dep } = require('./plan.cjs')
const { Wallet } = dep('@ethersproject/wallet')
const { readSolver } = require('./solver.cjs')
const { MARKER, LABEL, NO_INDEX, proveRamImage, verifyRamMount, verifyRamKey, installRuntimeKey } = require('./mac-key.cjs')
const mount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-ram-check-')))
const file = path.join(mount, 'submitter.key')
const fake = '0x' + '11'.repeat(32), address = new Wallet(fake).address
const state = { mounts: `/dev/disk999 on ${mount} (hfs, local, nodev, nosuid)\n`,
  info: { images: [{ 'image-path': 'ram://2048', 'system-entities': [{ 'dev-entry': '/dev/disk999', 'mount-point': mount }] }] } }
const clone = () => JSON.parse(JSON.stringify(state))
try {
  fs.chmodSync(mount, 0o700)
  fs.writeFileSync(path.join(mount, MARKER), LABEL + '\n', { mode: 0o600 })
  assert.throws(() => verifyRamMount(mount, state))
  fs.writeFileSync(path.join(mount, NO_INDEX), '', { mode: 0o600 })
  assert.equal(verifyRamMount(mount, state), '/dev/disk999')
  for (const mutate of [
    s => { s.mounts = '' },
    s => { s.mounts += s.mounts },
    s => { s.info.images[0]['image-path'] = '/tmp/persistent.dmg' },
    s => { s.info.images[0]['system-entities'][0]['dev-entry'] = '/dev/disk998' },
    s => { s.info.images[0]['system-entities'][0]['mount-point'] += '-other' },
    s => { s.info.images[0]['system-entities'] = [{ 'dev-entry': '/dev/disk999' }, { 'mount-point': mount }] },
  ]) {
    const bad = clone(); mutate(bad)
    assert.throws(() => installRuntimeKey(fake, address, mount, bad))
    assert(!fs.existsSync(file), 'Invalid mount proof wrote a key')
  }
  assert.throws(() => installRuntimeKey(fake, new Wallet('0x' + '22'.repeat(32)).address, mount, state), /planned solver/)
  assert(!fs.existsSync(file))
  fs.chmodSync(mount, 0o755)
  assert.throws(() => installRuntimeKey(fake, address, mount, state), /0700/)
  fs.chmodSync(mount, 0o700)
  fs.writeFileSync(path.join(mount, MARKER), 'wrong\n')
  assert.throws(() => verifyRamMount(mount, state), /marker/)
  fs.writeFileSync(path.join(mount, MARKER), LABEL + '\n')
  assert.equal(installRuntimeKey(fake, address, mount, state).address, address)
  assert.equal(verifyRamKey(file, mount, state), file)
  assert.equal(readSolver(file).address, address)
  assert.throws(() => verifyRamKey(file, mount, { ...state, mounts: '' }), /not mounted/)
  const linked = path.join(mount, 'linked-mount')
  fs.symlinkSync(mount, linked)
  assert.throws(() => verifyRamMount(linked, state), /Symlinks/)
  fs.unlinkSync(linked)
  fs.chmodSync(path.join(mount, NO_INDEX), 0o644)
  assert.throws(() => verifyRamMount(mount, state), /Spotlight/)
  fs.chmodSync(path.join(mount, NO_INDEX), 0o600)
  assert.throws(() => installRuntimeKey(fake, address, mount, state), /EEXIST/)
  assert.equal(readSolver(file).address, address)
  assert.throws(() => verifyRamKey(file + '.other', mount, state), /prepared Arc RAM key/)
  fs.renameSync(file, file + '.original')
  fs.symlinkSync(file + '.original', file)
  assert.throws(() => verifyRamKey(file, mount, state), /regular file/)
  fs.unlinkSync(file)
  const marker = path.join(mount, MARKER)
  fs.renameSync(marker, marker + '.original')
  fs.symlinkSync(marker + '.original', marker)
  assert.throws(() => verifyRamMount(mount, state), /marker/)
  assert.throws(() => proveRamImage(state.mounts, {}, mount), /exact mounted/)
  console.log('PASS RAM device/mount binding, persistent-volume refusal, marker/mode/symlink checks, planned key binding and no overwrite; zero RPC or custody reads')
} finally { fs.rmSync(mount, { recursive: true, force: true }) }

// Execute the real entrypoints with external effects replaced. A stale Docker mount
// must stop preparation before sudo/key access and startup before RPC/activation.
async function entrypointGuards() {
  const events = [], plan = { config: { solver: address } }
  const mockFs = new Proxy({}, { get: (_, name) => {
    if (name === 'readFileSync') return file => {
      assert.equal(path.basename(file), 'plan.json', 'Entrypoint tried to read a key')
      events.push('plan'); return JSON.stringify(plan)
    }
    return () => { throw new Error('Unexpected filesystem access: ' + String(name)) }
  } })
  const planMock = { root: '/repo', checkHash: () => events.push('hash'), build: () => plan,
    compile: () => ({ artifacts: {} }), dep: () => ({ JsonRpcProvider: class {
      constructor() { events.push('RPC'); throw new Error('Unexpected RPC') }
    } }) }
  const solverMock = { readSolver: () => { events.push('key-read'); throw new Error('Unexpected key read') },
    importSolver: () => { events.push('key-write'); throw new Error('Unexpected key write') } }
  const childMock = { execFileSync: (command, args) => {
    events.push(command)
    assert.equal(command, 'docker', 'Unexpected sudo or process execution')
    for (const flag of ['--rm', '--read-only', '--cap-drop', '--security-opt']) assert(args.includes(flag))
    for (const [flag, value] of [['--pull', 'never'], ['--network', 'none'], ['--user', '501:20'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges:true']]) {
      assert.equal(args[args.indexOf(flag) + 1], value)
    }
    assert(args.some(arg => /^python@sha256:[0-9a-f]{64}$/.test(arg)))
    assert(args[args.indexOf('--mount') + 1].endsWith(',readonly'))
    const script = args[args.indexOf('-c') + 1]
    assert(script.includes(MARKER) && script.includes(NO_INDEX))
    assert(!script.includes('submitter.key') && !script.includes(fake))
    throw new Error('Disposable stale Docker mount')
  } }
  let mac
  const load = (name, args, tail) => {
    const context = { module: { exports: {} }, __dirname, console, events,
      process: { argv: ['node', name, ...args], platform: 'darwin', getuid: () => 501, getgid: () => 20,
        env: { ARC_SOLVER_KEY_FILE: '/public/submitter.key' } },
      require: id => {
        // VM arrays/objects have different prototypes; preserve structural assertions.
        if (id === 'node:assert/strict') return Object.assign((...args) => assert(...args), assert, {
          deepEqual: (a, b, message) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message),
        })
        if (id === 'node:fs') return mockFs
        if (id === 'node:child_process') return childMock
        if (id === './plan.cjs') return planMock
        if (id === './solver.cjs') return solverMock
        if (id === './mac-key.cjs') return { verifyRamKey: () => events.push('ram-key-proof'), probeDockerMount: mac.probeDockerMount }
        if (id === './verify.cjs') return { verify: () => { events.push('verify-RPC'); throw new Error('Unexpected verification') } }
        return require(id)
      } }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, name), 'utf8') + tail, context, { filename: name })
    return context
  }
  const preparation = load('mac-key.cjs', ['--prepare'],
    ';ensureRamMount=()=>events.push("mount");verifyRamMount=()=>events.push("ram-proof");globalThis.entry=main;')
  mac = preparation.module.exports
  assert.throws(() => preparation.entry(), /Disposable stale Docker mount/)
  assert.deepEqual(events, ['plan', 'hash', 'mount', 'ram-proof', 'docker'])
  events.length = 0
  const startup = load('start.cjs', ['--start'], ';globalThis.entry=main;')
  await assert.rejects(startup.entry(), /Disposable stale Docker mount/)
  assert.deepEqual(events, ['plan', 'hash', 'ram-key-proof', 'ram-proof', 'docker'])
  console.log('PASS real prepare/start entrypoint ordering: failed Docker proof prevents sudo, key reads/writes, RPC, rendering and activation')
}
entrypointGuards().catch(error => { console.error(error); process.exitCode = 1 })
