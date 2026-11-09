import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// BEGIN SHARED RECOVERY PROFILE — embedded unchanged in the recovery-only owner client.
export function recoveryArgs(argv) {
  const [chain, image, bundle, command, ...caps] = argv
  if (!['1', '56'].includes(chain) || !/^sha256:[a-f0-9]{64}$/.test(image ?? '') ||
    !/^[a-f0-9]{64}$/.test(bundle ?? '') || !['retry', 'cancel'].includes(command) ||
    caps.length !== (command === 'cancel' ? 2 : 0) || caps.some(value => !/^[1-9][0-9]{0,29}$/.test(value)) ||
    (command === 'cancel' && BigInt(caps[1]) > BigInt(caps[0]))) throw Error('Invalid recovery arguments.')
  return { chain, image, bundle, command, caps,
    source: chain === '1' ? 'ophis-broadcaster-broadcaster-1' : 'ophis-broadcaster-56-broadcaster-1',
    target: `ophis-broadcaster-owner-recovery-${chain}` }
}
export function recoveryEnvironment(container) {
  const values = container?.Config?.Env
  if (!Array.isArray(values) || values.length > 256) throw Error('Invalid recovery environment.')
  // Exact keys consumed by config.ts/main.ts, plus inert metadata from the pinned Node image.
  // An OPHIS_ prefix is not a blanket permission for future or unknown process controls.
  const allowed = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION',
    'OPHIS_BROADCASTER_ADMISSION', 'OPHIS_BROADCASTER_CHAIN_ID',
    'OPHIS_BROADCASTER_CREDIT_COLLECTION_GAS', 'OPHIS_BROADCASTER_CREDIT_COLLECTION_INPUTS',
    'OPHIS_BROADCASTER_CREDIT_COLLECTION_OUTPUTS', 'OPHIS_BROADCASTER_CREDIT_COLLECTION_PROOFS',
    'OPHIS_BROADCASTER_DAILY_BUDGET_WEI', 'OPHIS_BROADCASTER_ENABLED', 'OPHIS_BROADCASTER_EXECUTION_GUARD',
    'OPHIS_BROADCASTER_MARGIN_BPS', 'OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI', 'OPHIS_BROADCASTER_MAX_TX_COST_WEI',
    'OPHIS_BROADCASTER_MODE', 'OPHIS_BROADCASTER_OPERATOR_ADDRESS', 'OPHIS_BROADCASTER_PILOT_ACCOUNT',
    'OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT', 'OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID',
    'OPHIS_BROADCASTER_PREPAID_PILOT_OWNER', 'OPHIS_BROADCASTER_RESERVE_WEI', 'OPHIS_BROADCASTER_RPC',
    'OPHIS_BROADCASTER_SECRETS', 'OPHIS_BROADCASTER_STATE', 'OPHIS_BROADCASTER_TRACE_RPC',
    'OPHIS_BROADCASTER_WAKU', 'OPHIS_BROADCASTER_PORT'])
  const env = Object.create(null)
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 16_384 || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw Error('Invalid recovery environment.')
    const offset = value.indexOf('='), key = value.slice(0, offset)
    if (!allowed.has(key)) throw Error('Unsupported recovery environment key.')
    if (Object.hasOwn(env, key)) throw Error('Duplicate recovery environment.')
    env[key] = value.slice(offset + 1)
  }
  if (env.PATH !== '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' ||
    ['NODE_VERSION', 'YARN_VERSION'].some(key => env[key] !== undefined && !/^\d+\.\d+\.\d+$/.test(env[key])))
    throw Error('Unsupported image environment.')
  return env
}
export function recoverySource(source, plan) {
  const env = recoveryEnvironment(source), host = source?.HostConfig
  const mounts = source?.Mounts
  if (!/^[a-f0-9]{64}$/.test(source?.Id ?? '') || source.Name !== `/${plan.source}` ||
    source?.State?.Running !== false || !['exited', 'created'].includes(source.State.Status) ||
    !['no', 'unless-stopped'].includes(host?.RestartPolicy?.Name) ||
    !/^[1-9][0-9]*:[1-9][0-9]*$/.test(source?.Config?.User ?? '') ||
    env.OPHIS_BROADCASTER_CHAIN_ID !== plan.chain || env.OPHIS_BROADCASTER_MODE !== 'mainnet' ||
    env.OPHIS_BROADCASTER_OPERATOR_ADDRESS?.toLowerCase() !== '0x001486e70a0c9291f5f55c68914ee0e4e4a604d4' ||
    env.OPHIS_BROADCASTER_STATE !== '/var/lib/ophis-broadcaster' ||
    env.OPHIS_BROADCASTER_SECRETS !== '/var/lib/ophis-broadcaster/secrets/operator.sealed.json' ||
    !Array.isArray(mounts) || mounts.filter(mount => mount.Type !== 'tmpfs').length !== 1 ||
    mounts.some(mount => mount.Type === 'tmpfs' && mount.Destination !== '/tmp')) throw Error('Unsafe recovery source.')
  const state = mounts.find(mount => mount.Type !== 'tmpfs')
  if (state.Type !== 'bind' || state.Destination !== '/var/lib/ophis-broadcaster' || state.RW !== true ||
    typeof state.Source !== 'string' || !state.Source.startsWith('/') || state.Source === '/') throw Error('Invalid authoritative state mount.')
  const network = host.NetworkMode
  if (typeof network !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network) ||
    ['host', 'none', 'default', 'bridge'].includes(network) ||
    Object.keys(source?.NetworkSettings?.Networks ?? {}).join(',') !== network) throw Error('Unsupported recovery network.')
  for (const key of ['OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI', 'OPHIS_BROADCASTER_MAX_TX_COST_WEI', 'OPHIS_BROADCASTER_DAILY_BUDGET_WEI'])
    if (!/^[1-9][0-9]{0,29}$/.test(env[key] ?? '')) throw Error('Explicit recovery budgets are required.')
  if (plan.command === 'cancel' && (BigInt(plan.caps[0]) > BigInt(env.OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI) ||
    21_000n * BigInt(plan.caps[0]) > BigInt(env.OPHIS_BROADCASTER_MAX_TX_COST_WEI))) throw Error('Cancellation exceeds configured caps.')
  return { env: { ...env, OPHIS_BROADCASTER_ENABLED: '0' }, state, network }
}
export function recoveryImage(image, plan) {
  if (image?.Id !== plan.image || image.Os !== 'linux' || image.Architecture !== 'amd64' ||
    image?.Config?.Labels?.['org.ophis.broadcaster.bundle-sha256'] !== plan.bundle ||
    image?.Config?.WorkingDir !== '/opt/ophis/apps/broadcaster' ||
    JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(['node', '--max-old-space-size=2048'])) throw Error('Unreviewed recovery image.')
}
export function recoveryTarget(target, source, plan, running) {
  const { env, state, network } = recoverySource(source, plan), host = target?.HostConfig
  const actualEnv = recoveryEnvironment(target), mounts = target?.Mounts
  const labels = target?.Config?.Labels
  if (!/^[a-f0-9]{64}$/.test(target?.Id ?? '') || target.Name !== `/${plan.target}` || target.Image !== plan.image ||
    target?.State?.Running !== running || target?.Config?.User !== source.Config.User ||
    target.Config.WorkingDir !== '/opt/ophis/apps/broadcaster' ||
    JSON.stringify(target.Config.Entrypoint) !== JSON.stringify(['node', '--max-old-space-size=2048']) ||
    JSON.stringify(target.Config.Cmd) !== JSON.stringify(['dist/main.mjs', plan.command, ...plan.caps]) ||
    labels?.['org.ophis.recovery.source'] !== source.Id || labels?.['org.ophis.broadcaster.bundle-sha256'] !== plan.bundle ||
    host?.RestartPolicy?.Name !== 'no' || host.AutoRemove !== false || host.ReadonlyRootfs !== true || host.Init !== true || host.Privileged !== false ||
    host.NetworkMode !== network || host.PidMode || host.IpcMode !== 'private' ||
    host.Memory !== 3_221_225_472 || host.MemorySwap !== 3_221_225_472 || host.NanoCpus !== 1_000_000_000 || host.PidsLimit !== 128 ||
    JSON.stringify(host.CapDrop) !== '["ALL"]' || (host.CapAdd?.length ?? 0) !== 0 ||
    !Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1 || !['no-new-privileges', 'no-new-privileges:true'].includes(host.SecurityOpt[0]) ||
    JSON.stringify(host.VolumesFrom) !== JSON.stringify([`${source.Id}:rw`]) ||
    Object.keys(host.PortBindings ?? {}).length || (host.Devices?.length ?? 0) || (host.Binds?.length ?? 0) ||
    JSON.stringify(host.Tmpfs) !== JSON.stringify({ '/tmp': 'rw,noexec,nosuid,nodev,size=64m' }) ||
    !Array.isArray(mounts) || mounts.filter(mount => mount.Type !== 'tmpfs').length !== 1 ||
    mounts.some(mount => mount.Type === 'tmpfs' && mount.Destination !== '/tmp')) throw Error('Recovery container attestation failed.')
  const actual = mounts.find(mount => mount.Type !== 'tmpfs')
  if (actual.Type !== 'bind' || actual.Source !== state.Source || actual.Destination !== state.Destination || actual.RW !== true ||
    JSON.stringify(Object.entries(actualEnv).sort()) !== JSON.stringify(Object.entries(env).sort())) throw Error('Recovery state or environment changed.')
}
// END SHARED RECOVERY PROFILE

export function prepareRecovery(argv, docker = (args, env) => {
  // Docker needs only its fixed PATH and validated --env values; never inherit host process controls.
  const environment = env ?? { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
  const result = spawnSync('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], { env: environment, timeout: 30_000, encoding: 'utf8', maxBuffer: 1_048_576 })
  if (result.error || result.status !== 0) throw Error('Recovery Docker command failed; inspect the named container without unlocking.')
  return result.stdout.trim()
}) {
  const plan = recoveryArgs(argv)
  const source = JSON.parse(docker(['inspect', plan.source]))[0]
  const { env, network } = recoverySource(source, plan)
  recoveryImage(JSON.parse(docker(['image', 'inspect', plan.image]))[0], plan)
  const cid = docker(['create', '--name', plan.target, '--restart', 'no', '--init', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', source.Config.User, '--network', network, '--ipc', 'private',
    '--memory', '3g', '--memory-swap', '3g', '--cpus', '1', '--pids-limit', '128',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--volumes-from', `${source.Id}:rw`,
    '--label', `org.ophis.recovery.source=${source.Id}`,
    '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    ...Object.keys(env).flatMap(key => ['--env', key]), plan.image,
    'dist/main.mjs', plan.command, ...plan.caps], env)
  if (!/^[a-f0-9]{64}$/.test(cid)) throw Error('Invalid recovery container identifier.')
  // Attest the effective immutable configuration, not only the requested CLI arguments.
  const [target, currentSource] = JSON.parse(docker(['inspect', cid, source.Id]))
  recoveryTarget(target, currentSource, plan, false)
  return { status: 'created-stopped', chainId: Number(plan.chain), containerId: cid, container: plan.target,
    image: plan.image, bundleSha256: plan.bundle, command: [plan.command, ...plan.caps], ownerUnlockRequired: true }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(prepareRecovery(process.argv.slice(2)))) }
  catch { console.error('Recovery preparation failed. No credentials were logged. Preserve the original and any created recovery container.'); process.exitCode = 1 }
}
