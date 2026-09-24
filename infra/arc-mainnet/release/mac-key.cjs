// Explicit operator preparation only. Reuses OP's hdiutil RAM-image verification.
// RAM copy survives neither reboot nor detach; same-UID/Docker administrators can read it.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { root, checkHash } = require('./plan.cjs')
const { readSolver, importSolver } = require('./solver.cjs')
const MOUNT = path.join(os.homedir(), '.local/state/ophis/arc-ram-pk')
const CANONICAL_KEY = '/Users/ophis-driver/.config/ophis-arc/submitter.key'
const MARKER = '.ophis-arc-ram-marker'
const LABEL = 'ophis-arc-ram'
const NO_INDEX = '.metadata_never_index'
const PROBE_IMAGE = 'python@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f'
const run = (command, args, input) => execFileSync(command, args, {
  input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
})

function noSymlinks(file) {
  let current = path.parse(file).root
  for (const component of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    assert(!fs.lstatSync(current).isSymbolicLink(), 'Symlinks are forbidden in the RAM key path')
  }
}

function mountDevice(mounts, mount) {
  const suffix = ' on ' + mount + ' ('
  const matches = mounts.split('\n').filter(line => line.includes(suffix))
  assert(matches.length <= 1, 'Ambiguous RAM mount')
  if (!matches.length) return null
  const device = matches[0].slice(0, matches[0].indexOf(suffix))
  assert.match(device, /^\/dev\/disk\d+(?:s\d+)*$/, 'Unexpected RAM mount device')
  return device
}

function proveRamImage(mounts, info, mount) {
  const device = mountDevice(mounts, mount)
  assert(device, 'RAM key volume is not mounted')
  assert((info.images || []).some(image => /^ram:\/\/\d+$/.test(image['image-path']) &&
    (image['system-entities'] || []).some(entity => entity['dev-entry'] === device && entity['mount-point'] === mount)),
  'Key volume must be the exact mounted hdiutil RAM image')
  return device
}

function inspect() {
  return { mounts: run('/sbin/mount', []), info: JSON.parse(run('/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '-'], run('/usr/bin/hdiutil', ['info', '-plist']))) }
}

function verifyRamMount(mount = MOUNT, state = inspect()) {
  assert(path.isAbsolute(mount) && path.resolve(mount) === mount, 'Canonical RAM mount path required')
  noSymlinks(mount)
  assert(path.relative(fs.realpathSync(root), mount).startsWith('..' + path.sep), 'RAM key must stay outside the checkout')
  const device = proveRamImage(state.mounts, state.info, mount)
  const stat = fs.lstatSync(mount)
  assert(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
    'RAM mount must be operator-owned with mode 0700')
  const marker = fs.openSync(path.join(mount, MARKER), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const markerStat = fs.fstatSync(marker)
    assert(markerStat.isFile() && markerStat.uid === process.getuid() && (markerStat.mode & 0o777) === 0o600 && markerStat.size < 64,
      'Invalid RAM volume marker')
    assert.equal(fs.readFileSync(marker, 'utf8'), LABEL + '\n', 'Invalid RAM volume marker')
  } finally { fs.closeSync(marker) }
  const exclusion = fs.lstatSync(path.join(mount, NO_INDEX))
  assert(exclusion.isFile() && exclusion.uid === process.getuid() && (exclusion.mode & 0o777) === 0o600 && exclusion.size === 0,
    'RAM volume must exclude Spotlight indexing')
  return device
}

function verifyRamKey(file, mount = MOUNT, state) {
  assert.equal(file, path.join(mount, 'submitter.key'), 'Use the prepared Arc RAM key path on macOS')
  verifyRamMount(mount, state)
  // Reject key symlinks before the caller invokes readSolver.
  assert(fs.lstatSync(file).isFile(), 'RAM key must be a regular file')
  return file
}

function ensureRamMount() {
  // An unmounted directory must be empty: never reuse a persistent key or marker.
  fs.mkdirSync(MOUNT, { recursive: true, mode: 0o700 })
  noSymlinks(MOUNT)
  const before = inspect()
  if (mountDevice(before.mounts, MOUNT)) return verifyRamMount(MOUNT, before)
  assert.equal(fs.readdirSync(MOUNT).length, 0, 'Unmounted RAM directory must be empty')
  assert.equal(fs.statSync(MOUNT).uid, process.getuid(), 'RAM directory must be operator-owned')
  const device = run('/usr/bin/hdiutil', ['attach', '-nomount', 'ram://2048']).trim()
  assert.match(device, /^\/dev\/disk\d+$/, 'Unexpected newly allocated RAM device')
  try {
    run('/sbin/newfs_hfs', ['-v', LABEL, device])
    run('/sbin/mount', ['-t', 'hfs', device, MOUNT])
    const state = inspect()
    assert.equal(proveRamImage(state.mounts, state.info, MOUNT), device)
    fs.chmodSync(MOUNT, 0o700)
    fs.writeFileSync(path.join(MOUNT, MARKER), LABEL + '\n', { flag: 'wx', mode: 0o600 })
    // Preserve OP's indexing exclusion before any key reaches this volume.
    fs.writeFileSync(path.join(MOUNT, NO_INDEX), '', { flag: 'wx', mode: 0o600 })
    try { run('/usr/bin/mdutil', ['-i', 'off', MOUNT]) } catch {}
    return verifyRamMount(MOUNT, state)
  } catch (error) {
    // Only detach the device this invocation allocated; never detach existing mounts.
    try { run('/usr/bin/hdiutil', ['detach', device]) } catch {}
    throw error
  }
}

function installRuntimeKey(key, expected, mount = MOUNT, state) {
  verifyRamMount(mount, state)
  const file = path.join(mount, 'submitter.key')
  // importSolver validates the private key against the plan before exclusive creation.
  // A repeat invocation deliberately refuses to replace even a matching key.
  return importSolver(file, key, expected)
}

function probeDockerMount(mount = MOUNT) {
  verifyRamMount(mount)
  // Colima can retain stale virtiofs inodes after a RAM device is detached/reused.
  // Prove visibility with public files before authentication or canonical key access.
  run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,src=${mount},dst=/ram,readonly`, PROBE_IMAGE, 'python', '-c',
    // virtiofs exposes the HFS volume root as UID 0, while files retain operator UID.
    // Host ownership is checked above; require actual reads and private modes here.
    `import os,stat\ns=os.stat('/ram'); assert stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o700\n` +
    `for name in ${JSON.stringify([MARKER, NO_INDEX])}:\n s=os.lstat('/ram/'+name); assert stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o600\n` +
    `assert open('/ram/${MARKER}').read()==${JSON.stringify(LABEL + '\n')}\nassert os.stat('/ram/${NO_INDEX}').st_size==0`])
}

function main() {
  assert.deepEqual(process.argv.slice(2), ['--prepare'], 'Explicit --prepare required')
  assert.equal(process.platform, 'darwin')
  assert(process.getuid() > 0 && process.getuid() !== 502, 'Run as the Colima operator')
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated/plan.json')))
  checkHash(plan)
  ensureRamMount()
  probeDockerMount()
  const file = path.join(MOUNT, 'submitter.key')
  // Idempotent public validation, without rereading the isolated key or rotating it.
  if (fs.existsSync(file)) {
    verifyRamKey(file)
    assert.equal(readSolver(file).address, plan.config.solver)
  } else {
    execFileSync('/usr/bin/sudo', ['-v'], { stdio: 'inherit' })
    const child = `try {const fs=require('node:fs'),assert=require('node:assert/strict');
const {readSolver}=require(${JSON.stringify(path.join(__dirname, 'solver.cjs'))});
assert.equal(process.getuid(),502);const file=${JSON.stringify(CANONICAL_KEY)};
const expected=JSON.parse(fs.readFileSync(0,'utf8')).expected;
assert.equal(readSolver(file).address,expected);
const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
try {const s=fs.fstatSync(fd);assert(s.isFile()&&s.uid===502&&(s.mode&511)===384&&s.size<=128);
process.stdout.write(fs.readFileSync(fd,'utf8'));} finally{fs.closeSync(fd)}
}catch{process.exitCode=1}`
    const key = run('/usr/bin/sudo', ['-n', '-u', 'ophis-driver', process.execPath, '-e', child],
      JSON.stringify({ expected: plan.config.solver })).trim()
    installRuntimeKey(key, plan.config.solver)
  }
  console.log('Verified temporary Arc runtime key:', file)
  console.log('Solver:', plan.config.solver)
  console.log('Canonical isolated key retained. Re-run after reboot; no services started.')
}
if (require.main === module) {
  try { main() } catch {
    console.error('RAM key preparation refused. Check the reviewed plan, local authentication, RAM mount and file permissions. No key was printed or replaced.')
    process.exitCode = 1
  }
}
module.exports = { MOUNT, MARKER, LABEL, NO_INDEX, PROBE_IMAGE, mountDevice, proveRamImage, verifyRamMount, verifyRamKey, installRuntimeKey, probeDockerMount }
