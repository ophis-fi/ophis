import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error Standalone native JavaScript tooling is outside the runtime bundle.
import { prepareRecovery, recoveryArgs, recoveryImage, recoverySource, recoveryTarget } from '../scripts/anon-recovery.mjs'
// @ts-expect-error Standalone native JavaScript code generator.
import { recoveryClient, ORIGINAL_OWNER_HELPER_SHA256 } from '../scripts/build-anon-recovery-client.mjs'
const image = `sha256:${'ab'.repeat(32)}`, bundle = 'cd'.repeat(32), cid = 'ef'.repeat(32), sourceId = '12'.repeat(32)
const folders: string[] = []
afterEach(() => { for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(chain = '1', command = 'cancel') {
  const argv = [chain, image, bundle, command, ...(command === 'cancel' ? ['2000000000', '1000000000'] : [])]
  const plan = recoveryArgs(argv)
  const env = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    OPHIS_BROADCASTER_CHAIN_ID: chain, OPHIS_BROADCASTER_MODE: 'mainnet', OPHIS_BROADCASTER_ENABLED: '1',
    OPHIS_BROADCASTER_OPERATOR_ADDRESS: '0x001486E70A0c9291f5F55c68914eE0e4E4A604d4',
    OPHIS_BROADCASTER_STATE: '/var/lib/ophis-broadcaster', OPHIS_BROADCASTER_SECRETS: '/var/lib/ophis-broadcaster/secrets/operator.sealed.json',
    OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '3000000000', OPHIS_BROADCASTER_MAX_TX_COST_WEI: '10000000000000000',
    OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '50000000000000000', OPHIS_BROADCASTER_RPC: 'https://synthetic.invalid/PRIVATE-CREDENTIAL',
  }
  const source = { Id: sourceId, Image: `sha256:${'34'.repeat(32)}`, Name: `/${plan.source}`, State: { Running: false, Status: 'exited' },
    Config: { User: '1000:1000', Env: Object.entries(env).map(([key, value]) => `${key}=${value}`) },
    HostConfig: { RestartPolicy: { Name: 'no' }, NetworkMode: 'existing-network' },
    Mounts: [{ Type: 'bind', Source: '/private/owner-state', Destination: '/var/lib/ophis-broadcaster', RW: true }],
    NetworkSettings: { Networks: { 'existing-network': {} } } }
  const candidate = { Id: image, Os: 'linux', Architecture: 'amd64', Config: {
    Labels: { 'org.ophis.broadcaster.bundle-sha256': bundle }, WorkingDir: '/opt/ophis/apps/broadcaster',
    Entrypoint: ['node', '--max-old-space-size=2048'] } }
  const target = { Id: cid, Image: image, Name: `/${plan.target}`, State: { Running: false, Status: 'created' },
    Config: { ...candidate.Config, User: source.Config.User, Env: Object.entries({ ...env, OPHIS_BROADCASTER_ENABLED: '0' }).map(([key, value]) => `${key}=${value}`),
      Cmd: ['dist/main.mjs', command, ...plan.caps], Labels: { ...candidate.Config.Labels, 'org.ophis.recovery.source': sourceId } },
    HostConfig: { RestartPolicy: { Name: 'no' }, AutoRemove: false, ReadonlyRootfs: true, Init: true, Privileged: false,
      NetworkMode: 'existing-network', PidMode: '', IpcMode: 'private', Memory: 3221225472, MemorySwap: 3221225472,
      NanoCpus: 1000000000, PidsLimit: 128, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'],
      VolumesFrom: [`${sourceId}:rw`], PortBindings: {}, Devices: [], Binds: null, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' } },
    Mounts: structuredClone(source.Mounts) }
  const docker = vi.fn((args: string[], _environment?: NodeJS.ProcessEnv) => {
    if (args[0] === 'inspect' && args.length === 2) return JSON.stringify([source])
    if (args[0] === 'inspect') return JSON.stringify([target, source])
    if (args[0] === 'image') return JSON.stringify([candidate])
    if (args[0] === 'create') return cid
    throw Error('Forbidden Docker operation')
  })
  return { argv, plan, source, target, candidate, docker }
}
it.each(['1', '56'])('creates only chain %s recovery with authoritative mount and reviewed candidate pins', (chain) => {
  const f = fixture(chain), before = JSON.stringify(f.source), result = prepareRecovery(f.argv, f.docker)
  expect(result.status).toBe('created-stopped'); expect(JSON.stringify(result)).not.toContain('PRIVATE-CREDENTIAL')
  expect(JSON.stringify(f.source)).toBe(before)
  const [args, environment] = f.docker.mock.calls.find(([args]) => args[0] === 'create')!
  expect(args).toContain(f.plan.target); expect(args).toContain(`${sourceId}:rw`)
  expect(args.slice(-4)).toEqual(['dist/main.mjs', 'cancel', '2000000000', '1000000000'])
  expect(args).toContain(image); expect(args).not.toContain('/private/owner-state'); expect(args.join(' ')).not.toContain('PRIVATE-CREDENTIAL')
  expect(environment!.HOME).toBeUndefined(); expect(environment!.OPHIS_BROADCASTER_ENABLED).toBe('0'); expect(environment!.OPHIS_BROADCASTER_RPC).toContain('PRIVATE-CREDENTIAL')
  expect(f.docker.mock.calls.map(([args]) => args[0])).toEqual(['inspect', 'image', 'create', 'inspect'])
  expect(args[args.indexOf('--restart') + 1]).toBe('no')
  expect(args).not.toContain('compose'); expect(args).not.toContain('--publish'); expect(args).not.toContain('--entrypoint')
})
it.each([
  ['137', image, bundle, 'retry'], ['1', image, bundle, 'run'], ['1', image, bundle, 'cancel'],
  ['1', image, bundle, 'cancel', '0', '1'], ['1', image, bundle, 'cancel', '-1', '1'],
  ['1', image, bundle, 'cancel', '1', '2'], ['1', image, bundle, 'retry', '2'],
  ['1', 'mutable:latest', bundle, 'retry'], ['1', image, 'bad', 'retry'],
])('rejects invalid command/caps/pins before Docker: %j', (...argv) => {
  const docker = vi.fn(); expect(() => prepareRecovery(argv, docker)).toThrow(); expect(docker).not.toHaveBeenCalled()
})
it.each(['running', 'extra-mount', 'wrong-chain', 'root', 'secret-path', 'duplicate-env', 'over-price', 'over-cost', 'host-network'])('rejects unsafe source %s before creation', (kind) => {
  const f = fixture()
  if (kind === 'running') f.source.State.Running = true
  if (kind === 'extra-mount') f.source.Mounts.push({ Type: 'bind', Source: '/node', Destination: '/node', RW: true })
  if (kind === 'wrong-chain') f.source.Config.Env = f.source.Config.Env.map(v => v.startsWith('OPHIS_BROADCASTER_CHAIN_ID=') ? 'OPHIS_BROADCASTER_CHAIN_ID=56' : v)
  if (kind === 'root') f.source.Config.User = '0:0'
  if (kind === 'secret-path') f.source.Config.Env = f.source.Config.Env.map(v => v.startsWith('OPHIS_BROADCASTER_SECRETS=') ? 'OPHIS_BROADCASTER_SECRETS=/other/key' : v)
  if (kind === 'duplicate-env') f.source.Config.Env.push(f.source.Config.Env[0])
  if (kind === 'over-price') f.argv[4] = '4000000000'
  if (kind === 'over-cost') f.source.Config.Env = f.source.Config.Env.map(v => v.startsWith('OPHIS_BROADCASTER_MAX_TX_COST_WEI=') ? 'OPHIS_BROADCASTER_MAX_TX_COST_WEI=1' : v)
  if (kind === 'host-network') f.source.HostConfig.NetworkMode = 'host'
  expect(() => prepareRecovery(f.argv, f.docker)).toThrow()
  expect(f.docker.mock.calls.every(([args]) => args[0] === 'inspect')).toBe(true)
})
it.each(['image', 'bundle', 'architecture', 'entrypoint'])('rejects unreviewed candidate %s', (kind) => {
  const f = fixture()
  if (kind === 'image') f.candidate.Id = `sha256:${'56'.repeat(32)}`
  if (kind === 'bundle') f.candidate.Config.Labels['org.ophis.broadcaster.bundle-sha256'] = '00'.repeat(32)
  if (kind === 'architecture') f.candidate.Architecture = 'arm64'
  if (kind === 'entrypoint') f.candidate.Config.Entrypoint = ['sh']
  expect(() => recoveryImage(f.candidate, f.plan)).toThrow()
})
it.each(['restart', 'command', 'mount', 'volumes-from', 'env', 'extra-env', 'image', 'caps', 'privileged', 'port', 'name', 'source-started'])('refuses tampered effective recovery %s before unlock', (kind) => {
  const f = fixture()
  if (kind === 'restart') f.target.HostConfig.RestartPolicy.Name = 'always'
  if (kind === 'command') f.target.Config.Cmd = ['dist/main.mjs', 'run']
  if (kind === 'mount') f.target.Mounts[0].Source = '/retired/state'
  if (kind === 'volumes-from') f.target.HostConfig.VolumesFrom = ['other:rw']
  if (kind === 'env') f.target.Config.Env = f.target.Config.Env.map(v => v.startsWith('OPHIS_BROADCASTER_CHAIN_ID=') ? 'OPHIS_BROADCASTER_CHAIN_ID=56' : v)
  if (kind === 'extra-env') f.target.Config.Env.push('UNAPPROVED=1')
  if (kind === 'image') f.target.Image = f.source.Image
  if (kind === 'caps') f.target.HostConfig.CapDrop = []
  if (kind === 'privileged') f.target.HostConfig.Privileged = true
  if (kind === 'port') Object.assign(f.target.HostConfig.PortBindings, { '4340/tcp': [{}] })
  if (kind === 'name') f.target.Name = `/${f.plan.source}`
  if (kind === 'source-started') f.source.State.Running = true
  expect(() => recoveryTarget(f.target, f.source, f.plan, false)).toThrow()
})
it('accepts retry without new caps and rejects runtime overrides', () => {
  const f = fixture('56', 'retry'); expect(() => recoverySource(f.source, f.plan)).not.toThrow()
  f.source.Config.Env.push('NODE_OPTIONS=--require=/unapproved'); expect(() => recoverySource(f.source, f.plan)).toThrow()
})
it('refuses an unreviewed original owner helper', () => { expect(() => recoveryClient('synthetic modified helper')).toThrow('Unreviewed') })
const originalPath = process.env.OPHIS_TEST_PUBLIC_OWNER_HELPER ?? '/Users/scep/ophis-railgun-evidence/baal-replacement-20261106/baal-owner.mjs'
it.runIf(existsSync(originalPath))('preserves the pinned public cryptographic prefix and rejects import/noninteractive unlock before owner reads or SSH', () => {
  const source = readFileSync(originalPath, 'utf8')
  expect(createHash('sha256').update(source).digest('hex')).toBe(ORIGINAL_OWNER_HELPER_SHA256)
  const client = recoveryClient(source), prefix = source.slice(0, source.indexOf('async function main() {'))
  expect(client.startsWith(prefix)).toBe(true); expect(client.slice(prefix.length)).not.toContain('prepareRuntime(')
  expect(client.slice(prefix.length)).not.toContain('derivePhraseGasKey(')
  expect(client.indexOf('recoveryTarget(target, source, plan, true)')).toBeLessThan(client.indexOf('ownedDirectory(OUTPUT);', prefix.length))
  expect(client).toContain('${remoteDocker} exec -i ${cid} node dist/main.mjs unlock')
  expect(() => recoveryClient(source + '\n')).toThrow('Unreviewed')
  const directory = mkdtempSync(join(tmpdir(), 'ophis-recovery-client-test-')); folders.push(directory)
  const generated = join(directory, 'owner.mjs'); writeFileSync(generated, client, { mode: 0o600 })
  for (const argv of [['import'], ['import-phrase'], ['unlock', '137'], ['unlock', '1', image, bundle, cid, 'retry']]) {
    const result = spawnSync(process.execPath, [generated, ...argv], { encoding: 'utf8', timeout: 5000, env: { PATH: '/nonexistent' } })
    expect(result.status).toBe(1); expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Recovery unlock failed. No secret values were logged.\n')
  }
})

it.each(['PATH=/var/lib/ophis-broadcaster/bin', 'LD_AUDIT=/private/module.so', 'LD_PRELOAD=/private/module.so',
  'DYLD_INSERT_LIBRARIES=/private/module.dylib', 'OPENSSL_CONF=/private/openssl.conf', 'OPENSSL_MODULES=/private/modules',
  'DOCKER_HOST=tcp://unapproved.invalid', 'NODE_PATH=/private/modules'])('rejects container-to-host/runtime executable override %s before creation', value => {
  const f = fixture(), key = value.split('=')[0]
  f.source.Config.Env = [...f.source.Config.Env.filter(v => !v.startsWith(key + '=')), value]
  expect(() => prepareRecovery(f.argv, f.docker)).toThrow()
  expect(f.docker.mock.calls.map(([args]) => args[0])).toEqual(['inspect'])
})
it('pins the Docker executable independently of inherited or container PATH', () => {
  const script = readFileSync(new URL('../scripts/anon-recovery.mjs', import.meta.url), 'utf8')
  expect(script).toContain("spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock'")
})

it('pins both owner-helper remote operations to the launcher daemon and clears remote Docker overrides', () => {
  const main = readFileSync(new URL('../scripts/anon-recovery-owner-main.txt', import.meta.url), 'utf8')
  expect(main).toContain("const remoteDocker = '/usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/docker --host unix:///var/run/docker.sock'")
  expect(main).toContain('ssh(`${remoteDocker} inspect ${cid} ${plan.source}`)')
  expect(main).toContain('ssh(`${remoteDocker} exec -i ${cid} node dist/main.mjs unlock`, clear)')
  expect(main).not.toContain('ssh(`docker')
})

it.each(['HOME=/state/docker-config', 'NODE_COMPILE_CACHE=/state/cache', 'NODE_TLS_REJECT_UNAUTHORIZED=0',
  'NODE_EXTRA_CA_CERTS=/state/ca.pem', 'HTTPS_PROXY=https://unapproved.invalid', 'https_proxy=https://unapproved.invalid',
  'SSL_CERT_FILE=/state/ca.pem', 'SSL_CERT_DIR=/state/ca', 'UNKNOWN_VARIABLE=1', 'OPHIS_UNREVIEWED=1',
  'OPHIS_BROADCASTER_UNREVIEWED=1'])('rejects non-allowlisted environment %s before creation and unlock', value => {
  const f = fixture(); f.source.Config.Env.push(value)
  expect(() => prepareRecovery(f.argv, f.docker)).toThrow('Unsupported recovery environment key')
  expect(f.docker.mock.calls.map(([args]) => args[0])).toEqual(['inspect'])
  const clean = fixture(); clean.target.Config.Env.push(value)
  expect(() => recoveryTarget(clean.target, clean.source, clean.plan, false)).toThrow('Unsupported recovery environment key')
})
it('preserves supported private RPC configuration and inert image metadata under the exact allowlist', () => {
  const f = fixture()
  f.source.Config.Env.push('NODE_VERSION=22.23.4', 'YARN_VERSION=1.22.22',
    'OPHIS_BROADCASTER_TRACE_RPC=https://synthetic.invalid/PRIVATE-TRACE')
  const result = recoverySource(f.source, f.plan)
  expect(result.env.NODE_VERSION).toBe('22.23.4')
  expect(result.env.YARN_VERSION).toBe('1.22.22')
  expect(result.env.OPHIS_BROADCASTER_RPC).toContain('PRIVATE-CREDENTIAL')
  expect(result.env.OPHIS_BROADCASTER_TRACE_RPC).toContain('PRIVATE-TRACE')
})

it.each(['NEW_IMAGE_DEFAULT=1', 'OPHIS_BROADCASTER_PORT=4341'])('new candidate image ENV fails closed while stopped: %s', value => {
  const f = fixture()
  Object.assign(f.candidate.Config, { Env: [value] })
  f.target.Config.Env.push(value) // Docker retains an image default that the source did not override.
  expect(() => prepareRecovery(f.argv, f.docker)).toThrow()
  expect(f.docker.mock.calls.map(([args]) => args[0])).toEqual(['inspect', 'image', 'create', 'inspect'])
  expect(f.target.State.Running).toBe(false)
})
it('retains inert source version strings without substituting its old image for the approved candidate', () => {
  const f = fixture()
  f.source.Config.Env.push('NODE_VERSION=22.23.1', 'YARN_VERSION=1.22.22')
  f.target.Config.Env.push('NODE_VERSION=22.23.1', 'YARN_VERSION=1.22.22')
  Object.assign(f.candidate.Config, { Env: ['NODE_VERSION=22.23.4', 'YARN_VERSION=1.22.22'] })
  expect(prepareRecovery(f.argv, f.docker)).toMatchObject({ status: 'created-stopped', image, bundleSha256: bundle })
  const [args, environment] = f.docker.mock.calls.find(([args]) => args[0] === 'create')!
  expect(environment!.NODE_VERSION).toBe('22.23.1')
  expect(args).toContain(image); expect(args).not.toContain(f.source.Image)
})


it.each(['private-wrapped', 'public-native'])('preserves explicit %s funding mode in stopped recovery and attests the same mode before unlock', mode => {
  const f = fixture()
  f.source.Config.Env.push(`OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE=${mode}`)
  f.target.Config.Env.push(`OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE=${mode}`)
  expect(prepareRecovery(f.argv, f.docker)).toMatchObject({ status: 'created-stopped' })
  const environment = f.docker.mock.calls.find(([args]) => args[0] === 'create')![1]!
  expect(environment.OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE).toBe(mode)
  f.target.Config.Env = f.target.Config.Env.map(value => value.startsWith('OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE=')
    ? `OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE=${mode === 'public-native' ? 'private-wrapped' : 'public-native'}` : value)
  expect(() => recoveryTarget(f.target, f.source, f.plan, false)).toThrow('environment changed')
})
it.each(['', 'native', 'public', 'public-native '])('rejects invalid recovery payment mode %s before container creation', mode => {
  const f = fixture(); f.source.Config.Env.push(`OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE=${mode}`)
  expect(() => prepareRecovery(f.argv, f.docker)).toThrow('payment mode')
  expect(f.docker.mock.calls.map(([args]) => args[0])).toEqual(['inspect'])
})
