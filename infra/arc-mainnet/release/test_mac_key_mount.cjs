// Opt-in integration test. Allocates and cleans up only its own scratch RAM disk.
// Uses a public, disposable fake key; never reads the canonical key, sudo or Keychain.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { dep } = require('./plan.cjs')
const { Wallet } = dep('@ethersproject/wallet')
const { MARKER, LABEL, NO_INDEX, PROBE_IMAGE, verifyRamMount, verifyRamKey, installRuntimeKey, probeDockerMount } = require('./mac-key.cjs')
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
assert.deepEqual(process.argv.slice(2), ['--scratch'], 'Explicit --scratch required')
assert.equal(process.platform, 'darwin')
const mount = fs.mkdtempSync(path.join(os.homedir(), '.local/state/ophis/arc-ram-test-'))
let device, detached = false
try {
  device = run('/usr/bin/hdiutil', ['attach', '-nomount', 'ram://2048']).trim()
  assert.match(device, /^\/dev\/disk\d+$/)
  run('/sbin/newfs_hfs', ['-v', 'ophis-arc-test', device])
  run('/sbin/mount', ['-t', 'hfs', device, mount])
  fs.chmodSync(mount, 0o700)
  fs.writeFileSync(path.join(mount, MARKER), LABEL + '\n', { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(path.join(mount, NO_INDEX), '', { flag: 'wx', mode: 0o600 })
  try { run('/usr/bin/mdutil', ['-i', 'off', mount]) } catch {}
  assert.equal(verifyRamMount(mount), device)
  probeDockerMount(mount)
  const fake = '0x' + '11'.repeat(32), address = new Wallet(fake).address
  const result = installRuntimeKey(fake, address, mount)
  verifyRamKey(result.keyFile, mount)
  assert.equal(result.address, address)
  const digest = createHash('sha256').update(fake + '\n').digest('hex')
  run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,src=${result.keyFile},dst=/run/secrets/arc.key,readonly`,
    PROBE_IMAGE, 'python', '-c',
    `import hashlib; assert hashlib.sha256(open('/run/secrets/arc.key','rb').read()).hexdigest() == '${digest}'`])
  console.log('PASS disposable macOS RAM image, planned fake key and Colima read-only bind at operator UID/GID; no network or canonical-key access')
} finally {
  if (device && /^\/dev\/disk\d+$/.test(device)) {
    try { run('/usr/bin/hdiutil', ['detach', device]) } catch {
      // virtiofs can keep a reference after --rm. Only force-unmount our verified scratch volume.
      assert.equal(verifyRamMount(mount), device)
      run('/sbin/umount', ['-f', mount])
      run('/usr/bin/hdiutil', ['detach', device])
    }
    detached = true
  }
  if (!device || detached) fs.rmdirSync(mount)
}
