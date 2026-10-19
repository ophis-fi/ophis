import { expect, test } from 'bun:test'

const run = (mode: string, args: string[]) => {
  const child = Bun.spawnSync(['bun', '--preload', './test/command.ts', 'src/main.ts', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, OPHIS_TEST_SCENARIO: mode },
  })
  return { code: child.exitCode, out: child.stdout.toString(), error: child.stderr.toString() }
}

test('connect names chains left out because the wallet chose another account', () => {
  const result = run('connect', ['connect'])
  expect(result.code).toBe(0)
  expect(result.out).toContain('Left out Arbitrum One: your wallet picked another account there.')
  expect(result.out).toContain('Run ophis connect again and pick the same account on every network.')
})

for (const [command, args, continuation] of [
  ['swap', ['swap', '1', 'ETH', 'USDC', '--yes'], 'ophis swap 1 WETH USDC on base'],
  ['bridge', ['bridge', '1', 'ETH', 'to', 'arbitrum', '--to-token', 'WETH', '--yes'], 'ophis bridge 1 WETH from base to arbitrum'],
] as const) {
  for (const mode of ['interrupt', 'error', 'timeout']) {
    test(`${command} prints the wrap hash before waiting and explains how to continue after ${mode}`, () => {
      const result = run(mode, [...args])
      expect(result.code).toBe(mode === 'interrupt' ? 130 : 1)
      const hash = `0x${'ab'.repeat(32)}`
      expect(result.out).toContain(`Transaction sent: ${hash}`)
      expect(result.out.indexOf(hash)).toBeLessThan(result.out.indexOf('Receipt wait started'))
      const message = result.out + result.error
      expect(message).toContain('The wrap may still confirm')
      expect(message).toContain('Check the transaction before trying again')
      expect(message).toContain('If it confirms, you will hold 1 WETH instead of ETH')
      expect(message).toContain(continuation)
    })
  }
  test(`${command} reports confirmed wraps, but does not suggest using WETH for a reverted or declined wrap`, () => {
    const confirmed = run('confirmed', [...args])
    expect(confirmed.code).toBe(1)
    expect(confirmed.error).toContain('You now hold 1 WETH instead of ETH')
    expect(confirmed.error).toContain(continuation)
    for (const mode of ['reverted', 'declined']) {
      const result = run(mode, [...args])
      expect(result.code).toBe(1)
      expect(result.error).toContain(mode === 'reverted' ? 'failed on-chain' : 'Wallet declined')
      expect(result.error).not.toContain('wrap may still confirm')
      expect(result.error).not.toContain(continuation)
    }
  })
}

test('missing token hints list only this chain\'s dollar tokens, regardless of case, with terminal controls removed', () => {
  const result = run('dollars', ['quote', '1', 'MISSING', 'WETH', 'on', 'robinhood'])
  expect(result.code).toBe(1)
  expect(result.error).toContain('No token called "MISSING" on Robinhood Chain.')
  expect(result.error).toContain('Its dollar tokens: USDG, usdx.')
  expect(result.error).not.toContain('USDC')
  expect(result.error).not.toContain('\u001b')
  const none = run('dollars-none', ['quote', '1', 'MISSING', 'WETH', 'on', 'robinhood'])
  expect(none.error).toContain('No token called "MISSING" on Robinhood Chain.')
  expect(none.error).not.toContain('Its dollar tokens:')
})
