import { expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { snapshotCriticalState } from '../src/backup'
import { privateDirectory, privateFile, Store } from '../src/storage'

const custodyLayouts = {
  legacy: ['operator.sealed.json', 'operator-retired.sealed.json', 'operator-public.json', 'backup-cert.pem'],
  owner: ['owner-manifest.json', 'operator.sealed.json', 'fee-wallet-public.json', 'fee-wallet.sealed.json'],
}

it.each(['legacy', 'owner'] as const)('snapshots %s custody and live WAL journals without stopping the operator or losing unknown transactions', async (layout) => {
  const root = mkdtempSync(join(tmpdir(), 'critical-backup-'))
  privateDirectory(join(root, 'secrets'))
  for (const name of custodyLayouts[layout])
    writeFileSync(join(root, 'secrets', name), 'encrypted/dummy-public-data', { mode: 0o600 })
  const store = new Store(root)
  privateFile(join(root, 'protected-transactions.sqlite'), true)
  const transport = new DatabaseSync(join(root, 'protected-transactions.sqlite'))
  try {
    transport.exec('PRAGMA journal_mode=WAL; CREATE TABLE pending (raw TEXT); INSERT INTO pending VALUES (\'unknown signed bytes\')')
    store.signed('loss', 'encrypted request', 'old signed bytes', 'old-hash', 100n, 1000n, 0)
    store.confirmed('loss', 80n, Date.now())
    store.acknowledgeLoss('loss', 'old-hash', 80n, 100, 'canonical-block', 'Dummy finalized gas loss')
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('withdrawalPilot', 'historical-pilot')
    store.signed('pending', 'encrypted request', 'unknown signed bytes', 'hash', 100n, 1000n, 1)
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('walletId', 'live-view-id')
    const destination = join(root, '.backup-snapshot.test')
    await snapshotCriticalState(root, destination)
    const saved = new Store(join(destination, 'state'))
    const savedTransport = new DatabaseSync(join(destination, 'state', 'protected-transactions.sqlite'))
    try {
      expect(saved.get('pending')?.raw).toBe('unknown signed bytes')
      expect(saved.exposure()).toBe(180n)
      expect(saved.pending().map((row) => row.key)).toEqual(['pending'])
      expect(saved.db.prepare('SELECT reason FROM settlement_resolutions WHERE key=?').get('loss')?.reason).toBe('Dummy finalized gas loss')
      expect(saved.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historical-pilot')
      expect(savedTransport.prepare('SELECT raw FROM pending').get()?.raw).toBe('unknown signed bytes')
      expect(saved.db.prepare('SELECT value FROM settings WHERE key=?').get('walletId')).toBeUndefined()
      expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('walletId')?.value).toBe('live-view-id')
      expect(readFileSync(join(destination, 'state', 'secrets', 'operator.sealed.json'), 'utf8')).toBe('encrypted/dummy-public-data')
      expect(readdirSync(join(destination, 'state', 'secrets')).sort()).toEqual([...custodyLayouts[layout]].sort())
      for (const name of custodyLayouts[layout]) {
        expect(readFileSync(join(destination, 'state', 'secrets', name), 'utf8')).toBe('encrypted/dummy-public-data')
        expect(statSync(join(destination, 'state', 'secrets', name)).mode & 0o777).toBe(0o600)
      }
      store.confirmed('pending', 80n, Date.now())
      expect(store.exposure()).toBe(160n)
      expect(saved.exposure()).toBe(180n)
    } finally { saved.close(); savedTransport.close() }
    await expect(snapshotCriticalState(root, join(root, 'outside'))).rejects.toThrow('private snapshot')
  } finally { store.close(); transport.close(); rmSync(root, { recursive: true, force: true }) }
})

it.each(Object.entries(custodyLayouts).flatMap(([layout, files]) => files.map((missing) => ({ layout, files, missing }))))(
  'refuses an incomplete $layout custody snapshot missing $missing', async ({ files, missing }) => {
    const root = mkdtempSync(join(tmpdir(), 'critical-backup-missing-'))
    privateDirectory(join(root, 'secrets'))
    for (const name of files.filter((name) => name !== missing))
      writeFileSync(join(root, 'secrets', name), 'synthetic-sealed-record', { mode: 0o600 })
    const store = new Store(root)
    try {
      await expect(snapshotCriticalState(root, join(root, '.backup-snapshot.test'))).rejects.toThrow(/ENOENT/)
      expect(existsSync(join(root, '.backup-snapshot.test', 'state', 'backup-kind.json'))).toBe(false)
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  },
)

it.each(['symlink', 'permissions'] as const)('retains private-file safety for an owner manifest with unsafe %s', async (unsafe) => {
  const root = mkdtempSync(join(tmpdir(), 'critical-backup-unsafe-'))
  privateDirectory(join(root, 'secrets'))
  // Complete legacy records must not turn an unsafe owner marker into a legacy fallback.
  for (const name of new Set([...custodyLayouts.legacy, ...custodyLayouts.owner]))
    writeFileSync(join(root, 'secrets', name), 'synthetic-sealed-record', { mode: 0o600 })
  const manifest = join(root, 'secrets', 'owner-manifest.json')
  if (unsafe === 'symlink') { rmSync(manifest); symlinkSync(join(root, 'missing-manifest'), manifest) }
  else chmodSync(manifest, 0o644)
  const store = new Store(root)
  try {
    await expect(snapshotCriticalState(root, join(root, '.backup-snapshot.test'))).rejects.toThrow()
    expect(existsSync(join(root, '.backup-snapshot.test', 'state', 'backup-kind.json'))).toBe(false)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

function shellFixture(layout: 'state' | 'owner-state', running = true) {
  const root = mkdtempSync(join(tmpdir(), 'backup-layout-')), base = join(root, 'operator install')
  const state = join(base, layout), hooks = join(root, 'hooks.sh'), calls = join(root, 'calls')
  mkdirSync(join(base, 'current'), { recursive: true })
  mkdirSync(join(base, 'backups'))
  for (const path of new Set([join(base, 'state'), state])) {
    mkdirSync(join(path, 'secrets'), { recursive: true })
    writeFileSync(join(path, 'journal.marker'), path === state ? 'current-state' : 'retired-state')
    writeFileSync(join(path, 'requests.sqlite'), path === state ? 'current-journal' : 'retired-journal')
    writeFileSync(join(path, 'secrets', 'operator.sealed.json'), path === state ? 'sealed-current' : 'sealed-retired')
  }
  const executed = join(root, 'must-not-execute')
  writeFileSync(join(base, 'operator.env'), 'DUMMY_OPERATOR=public-fixture\n')
  writeFileSync(join(base, 'compose.env'), `OPHIS_STATE_DIR=${state}\nNEVER_SOURCE=$(touch '${executed}')\n`)
  writeFileSync(join(base, 'current', 'compose.yml'), 'public synthetic compose fixture')
  writeFileSync(join(base, 'backup-cert.pem'), 'dummy public certificate')
  writeFileSync(join(base, 'backups', 'retired.cms'), 'preserved-old-backup')
  writeFileSync(calls, '')
  const config = join(root, 'compose.json')
  const configure = (volumes: unknown) => writeFileSync(config, JSON.stringify({ services: { broadcaster: { volumes } } }))
  configure([{ type: 'bind', source: state, target: '/var/lib/ophis-broadcaster' }])
  const inspect = join(root, 'mounts.json'), container = join(root, 'container-id')
  const actualMounts = (mounts: unknown) => writeFileSync(inspect, JSON.stringify(mounts))
  actualMounts([{ Type: 'bind', Source: state, Destination: '/var/lib/ophis-broadcaster' }])
  const existingContainer = (value: string) => writeFileSync(container, value)
  existingContainer('synthetic-container\n')
  const attack = join(root, 'snapshot-attack'), sentinel = join(root, 'host-sentinel')
  writeFileSync(sentinel, 'must-not-overwrite')
  // Compose is a synthetic container, while the actual backup shell and tar run unchanged.
  // OpenSSL passes the tar stream through so the test can inspect the selected files without real keys.
  writeFileSync(hooks, `
flock() { return 0; }
cp() { printf 'Host cp must not write into a container snapshot.\\n' >&2; return 94; }
docker() {
  if [[ "$1" = inspect ]]; then
    printf '%s\\n' "$*" >> "$OPHIS_TEST_CALLS"
    [[ "$2" = --format && "$3" = '{{json .Mounts}}' && "$4" = synthetic-container ]] || return 93
    cat "$OPHIS_TEST_MOUNTS"
    return
  fi
  [[ "$1" = compose ]] || return 90
  shift
  while [[ "$1" = --env-file || "$1" = -f ]]; do shift 2; done
  printf '%s\\n' "$*" >> "$OPHIS_TEST_CALLS"
  case "$1" in
    config) [[ "$2" = --format && "$3" = json ]] && cat "$OPHIS_TEST_COMPOSE" ;;
    ps) if [[ "$2" = -aq ]]; then cat "$OPHIS_TEST_CONTAINER";
        elif [[ "$OPHIS_TEST_RUNNING" = 1 ]]; then printf 'synthetic-container\\n'; fi ;;
    exec)
      [[ "$2" = -T && "$3" = broadcaster && "$4" = node && "$5" = dist/main.mjs && "$6" = snapshot ]] || return 91
      local target="$OPHIS_TEST_STATE/\${7##*/}"
      mkdir -p "$target/state/secrets"
      command cp "$OPHIS_TEST_STATE/journal.marker" "$OPHIS_TEST_STATE/requests.sqlite" "$target/state/"
      command cp "$OPHIS_TEST_STATE/secrets/operator.sealed.json" "$target/state/secrets/"
      if [[ -f "$OPHIS_TEST_ATTACK" ]]; then ln -s "$OPHIS_TEST_SENTINEL" "$target/operator.env"; fi
      ;;
    stop|start) ;;
    *) return 92 ;;
  esac
}
openssl() {
  local output=
  while [[ $# -gt 0 ]]; do
    if [[ "$1" = -out ]]; then output=$2; shift 2; else shift; fi
  done
  [[ -n "$output" ]] || return 93
  cat > "$output"
  [[ "$OPHIS_TEST_ENCRYPT_FAIL" = 0 ]]
}
`, { mode: 0o600 })
  const run = (mode: 'critical' | 'full', fail = false) => spawnSync('/bin/bash',
    [new URL('../scripts/backup.sh', import.meta.url).pathname, base, mode], {
      timeout: 5000, encoding: 'utf8', env: { ...process.env, BASH_ENV: hooks,
        OPHIS_TEST_COMPOSE: config, OPHIS_TEST_STATE: state, OPHIS_TEST_CALLS: calls,
        OPHIS_TEST_MOUNTS: inspect, OPHIS_TEST_CONTAINER: container, OPHIS_TEST_ATTACK: attack, OPHIS_TEST_SENTINEL: sentinel,
        OPHIS_TEST_RUNNING: running ? '1' : '0', OPHIS_TEST_ENCRYPT_FAIL: fail ? '1' : '0' },
    })
  const checkPreserved = () => {
    expect(readFileSync(join(base, 'backups', 'retired.cms'), 'utf8')).toBe('preserved-old-backup')
    expect(readFileSync(join(state, 'journal.marker'), 'utf8')).toBe('current-state')
    if (layout !== 'state') expect(readFileSync(join(base, 'state', 'journal.marker'), 'utf8')).toBe('retired-state')
    expect(existsSync(executed)).toBe(false)
    expect(readdirSync(state).some((name) => name.startsWith('.backup-snapshot.'))).toBe(false)
    expect(readdirSync(join(base, 'backups')).some((name) => name.startsWith('.incomplete.'))).toBe(false)
  }
  return { root, base, state, calls, configure, actualMounts, existingContainer, run, checkPreserved,
    attackSnapshot: () => writeFileSync(attack, ''), sentinel }
}

it.each((['state', 'owner-state'] as const).flatMap((layout) => [
  { layout, mode: 'critical' as const, running: true },
  { layout, mode: 'full' as const, running: true },
  { layout, mode: 'full' as const, running: false },
]))('backs up the configured $layout with $mode mode (running=$running)', ({ layout, mode, running }) => {
  const f = shellFixture(layout, running)
  try {
    const result = f.run(mode)
    expect(result.status, result.stderr).toBe(0)
    const archive = result.stdout.trim(), prefix = mode === 'critical' ? 'state' : `./${layout}`
    const files = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' })
    expect(files.status, files.stderr).toBe(0)
    expect(files.stdout.split('\n')).toContain(`${prefix}/journal.marker`)
    const content = (name: string) => spawnSync('tar', ['-xOf', archive, name], { encoding: 'utf8' }).stdout
    expect(content(`${prefix}/journal.marker`)).toBe('current-state')
    expect(content(`${prefix}/requests.sqlite`)).toBe('current-journal')
    expect(content(`${prefix}/secrets/operator.sealed.json`)).toBe('sealed-current')
    expect(content('operator.env')).toBe(readFileSync(join(f.base, 'operator.env'), 'utf8'))
    expect(content('compose.env')).toBe(readFileSync(join(f.base, 'compose.env'), 'utf8'))
    const calls = readFileSync(f.calls, 'utf8').split('\n')
    expect(calls[0]).toBe('config --format json')
    expect(calls[1]).toBe('ps -aq broadcaster')
    expect(calls[2]).toBe('inspect --format {{json .Mounts}} synthetic-container')
    expect(calls.includes('stop broadcaster')).toBe(mode === 'full')
    expect(calls.includes('start broadcaster')).toBe(mode === 'full' && running)
    expect(calls.some((call) => call.startsWith('exec -T broadcaster node dist/main.mjs snapshot /var/lib/ophis-broadcaster/.backup-snapshot.')))
      .toBe(mode === 'critical')
    f.checkPreserved()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it.each(['critical', 'full'] as const)('cleans an incomplete %s backup and preserves state after encryption failure', (mode) => {
  const f = shellFixture('owner-state')
  try {
    expect(f.run(mode, true).status).not.toBe(0)
    expect(readdirSync(join(f.base, 'backups'))).toEqual(['retired.cms'])
    expect(readFileSync(f.calls, 'utf8').includes('start broadcaster')).toBe(mode === 'full')
    f.checkPreserved()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it.each(['missing', 'named volume', 'ambiguous', 'relative'])(
  'refuses an unsafe %s state configuration before container operations or archiving', (kind) => {
    const f = shellFixture('owner-state')
    try {
      const mount = { type: 'bind', source: f.state, target: '/var/lib/ophis-broadcaster' }
      f.configure(kind === 'missing' ? [] : kind === 'ambiguous' ? [mount, mount]
        : [{ ...mount, ...(kind === 'named volume' ? { type: 'volume' } : { source: 'owner-state' }) }])
      const result = f.run('full')
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Cannot resolve the configured broadcaster state bind mount.')
      expect(readFileSync(f.calls, 'utf8')).toBe('config --format json\n')
      expect(readdirSync(join(f.base, 'backups'))).toEqual(['retired.cms'])
      f.checkPreserved()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  },
)
it.each(['critical', 'full'] as const)('refuses a symlink state mount for %s backup before stopping or archiving', (mode) => {
  const f = shellFixture('owner-state')
  try {
    const link = join(f.root, 'linked-state')
    symlinkSync(f.state, link, 'dir')
    f.configure([{ type: 'bind', source: link, target: '/var/lib/ophis-broadcaster' }])
    const result = f.run(mode)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Configured broadcaster state must be a real directory, not a symlink.')
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/stop|exec/)
    expect(readdirSync(join(f.base, 'backups'))).toEqual(['retired.cms'])
    f.checkPreserved()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it.each((['critical', 'full'] as const).flatMap((mode) =>
  ['mismatched mount', 'empty configured state', 'missing journal', 'missing sealed record', 'no container'].map((condition) => ({ mode, condition })),
))('refuses $condition for $mode before stopping or archiving', ({ mode, condition }) => {
  const f = shellFixture('owner-state')
  try {
    if (condition === 'mismatched mount')
      f.actualMounts([{ Type: 'bind', Source: join(f.base, 'state'), Destination: '/var/lib/ophis-broadcaster' }])
    if (condition === 'empty configured state') {
      const empty = join(f.root, 'empty-state')
      mkdirSync(empty)
      f.configure([{ type: 'bind', source: empty, target: '/var/lib/ophis-broadcaster' }])
      f.actualMounts([{ Type: 'bind', Source: empty, Destination: '/var/lib/ophis-broadcaster' }])
    }
    if (condition === 'missing journal') rmSync(join(f.state, 'requests.sqlite'))
    if (condition === 'missing sealed record') rmSync(join(f.state, 'secrets', 'operator.sealed.json'))
    if (condition === 'no container') f.existingContainer('')
    const result = f.run(mode)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(condition === 'mismatched mount' ? 'differs from the configured state'
      : condition === 'no container' ? 'exactly one existing broadcaster container' : 'missing its request journal or sealed operator record')
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/stop|exec|ps --status/)
    expect(readdirSync(join(f.base, 'backups'))).toEqual(['retired.cms'])
    f.checkPreserved()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it.each(['missing', 'named volume', 'ambiguous', 'relative'])(
  'refuses an unsafe %s existing-container mount before stopping or archiving', (condition) => {
    const f = shellFixture('owner-state')
    try {
      const mount = { Type: 'bind', Source: f.state, Destination: '/var/lib/ophis-broadcaster' }
      f.actualMounts(condition === 'missing' ? [] : condition === 'ambiguous' ? [mount, mount]
        : [{ ...mount, ...(condition === 'named volume' ? { Type: 'volume' } : { Source: 'owner-state' }) }])
      const result = f.run('full')
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Cannot resolve the existing broadcaster state bind mount.')
      expect(readFileSync(f.calls, 'utf8')).not.toMatch(/stop|exec|ps --status/)
      expect(readdirSync(join(f.base, 'backups'))).toEqual(['retired.cms'])
      f.checkPreserved()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  },
)

it('refuses multiple existing broadcaster containers before inspecting or archiving', () => {
  const f = shellFixture('owner-state')
  try {
    f.existingContainer('synthetic-container\nsecond-container\n')
    const result = f.run('full')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('exactly one existing broadcaster container')
    expect(readFileSync(f.calls, 'utf8')).not.toMatch(/inspect|stop|exec/)
    expect(readdirSync(join(f.base, 'backups'))).toEqual(['retired.cms'])
    f.checkPreserved()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it.each(['critical', 'full'] as const)('accepts the same state directory with a different spelling for %s', (mode) => {
  const f = shellFixture('owner-state')
  try {
    f.actualMounts([{ Type: 'bind', Source: `${f.state}/.`, Destination: '/var/lib/ophis-broadcaster' }])
    const result = f.run(mode)
    expect(result.status, result.stderr).toBe(0)
    f.checkPreserved()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('archives configuration directly from the installation without writing through a container-planted symlink', () => {
  const f = shellFixture('owner-state')
  try {
    f.attackSnapshot()
    const result = f.run('critical')
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(f.sentinel, 'utf8')).toBe('must-not-overwrite')
    for (const name of ['operator.env', 'compose.env']) {
      const content = spawnSync('tar', ['-xOf', result.stdout.trim(), name], { encoding: 'utf8' })
      expect(content.status, content.stderr).toBe(0)
      expect(content.stdout).toBe(readFileSync(join(f.base, name), 'utf8'))
    }
    f.checkPreserved()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
