import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/storage'

const operator = '0x0000000000000000000000000000000000001234'
const otherOperator = '0x0000000000000000000000000000000000005678'
let directory: string, executable: string, port: number, readChain = 1
let health: Record<string, unknown>
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/health') { response.end(JSON.stringify(health)); return }
  let body = ''
  for await (const chunk of request) body += chunk
  const call = JSON.parse(body)
  const result = call.method === 'eth_chainId' ? `0x${readChain.toString(16)}`
    : call.method === 'anvil_metadata' ? { forkedNetwork: { chainId: readChain } } : undefined
  response.end(JSON.stringify(result === undefined
    ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Unsupported fixture method' } }
    : { jsonrpc: '2.0', id: call.id, result }))
})

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-main-cli-'))
  executable = join(directory, 'main.mjs')
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: [new URL('../src/main.ts', import.meta.url).pathname], outfile: executable,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'fixture-free-disk', setup(builder) {
      builder.onResolve({ filter: /^node:fs$/ }, (args) => args.namespace === 'fixture-free-disk'
        ? { path: 'node:fs', external: true } : { path: 'fs', namespace: 'fixture-free-disk' })
      builder.onLoad({ filter: /.*/, namespace: 'fixture-free-disk' }, () => ({
        contents: "export * from 'node:fs'; export const statfsSync = () => ({ bavail: 8 * 1024 ** 3, bsize: 1 });",
      }))
    } }],
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing disposable loopback port.')
  port = address.port
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  rmSync(directory, { recursive: true, force: true })
})

async function report(chainId: number, boundChain: number | null = chainId, boundOperator = operator) {
  const state = mkdtempSync(join(directory, 'state-'))
  const store = new Store(state)
  try { if (boundChain !== null) store.bindIdentity(boundChain, boundOperator) } finally { store.close() }
  const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
    OPHIS_BROADCASTER_MODE: 'fork', OPHIS_BROADCASTER_ENABLED: '0', OPHIS_BROADCASTER_CHAIN_ID: String(chainId),
    OPHIS_BROADCASTER_RPC: `http://127.0.0.1:${port}`, OPHIS_BROADCASTER_PORT: String(port),
    OPHIS_BROADCASTER_STATE: state, OPHIS_BROADCASTER_SECRETS: join(state, 'unused-test-only.json'),
    OPHIS_BROADCASTER_OPERATOR_ADDRESS: operator }
  return new Promise<{ code: string | number | undefined; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [executable, 'report'], { env, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? error.name : 0, stdout, stderr }))
  })
}

it.each([[1, 'ETH'], [42161, 'ETH'], [56, 'BNB'], [137, 'POL']] as const)(
  'reports chain %i with its bound operator and matching current balance sample', async (chainId, nativeSymbol) => {
    readChain = chainId
    health = { chainId, nativeSymbol, operatorAddress: operator, synchronized: true, feeBalancesAt: Date.now(), feeBalances: {} }
    const result = await report(chainId)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ chainId, nativeSymbol, operatorAddress: operator,
      requests: 0, recordedGasExpenseWei: '0', spendablePrivateFees: {} })
  },
)

it.each(['journal-chain', 'journal-operator', 'unbound-journal', 'health-chain', 'health-operator', 'rpc-chain'])(
  'refuses a mismatched %s without emitting accounting or private balances', async (kind) => {
    readChain = kind === 'rpc-chain' ? 56 : 1
    health = { chainId: kind === 'health-chain' ? 56 : 1, nativeSymbol: 'ETH',
      operatorAddress: kind === 'health-operator' ? otherOperator : operator,
      synchronized: true, feeBalancesAt: Date.now(), feeBalances: { privateBalanceMustNotLeak: '7' } }
    const result = await report(1, kind === 'unbound-journal' ? null : kind === 'journal-chain' ? 56 : 1,
      kind === 'journal-operator' ? otherOperator : operator)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No secret values were logged')
    expect(result.stderr).not.toContain('privateBalanceMustNotLeak')
  },
)
