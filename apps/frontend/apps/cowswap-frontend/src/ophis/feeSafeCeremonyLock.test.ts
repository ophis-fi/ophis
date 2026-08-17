import fs from 'node:fs'
import path from 'node:path'

const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`
const SENDER = `0x${'1'.repeat(40)}`
const V0 = 'ophisFeeSafePendingTransaction:v0'
const V1 = 'ophisFeeSafePendingTransaction:v1'
const V2 = 'ophisFeeSafeReconciledTransaction:v2'

type Hooks = {
  forgetPendingTransaction(hash: string): boolean
  readPendingTransaction(): { hash: string } | null
  rememberPendingTransaction(hash: string, sender: string, nonce: string, provisional: boolean): void
  rereadPendingTransaction(): { hash: string } | null
  waitForPendingResolution(
    provider: { request(args: { method: string }): Promise<unknown> },
    transaction: { hash: string; sender: string; nonce: string | null; nonceProvisional: boolean },
  ): Promise<unknown>
}

type CeremonyHarness = {
  hooks: Hooks
  values: Map<string, string>
  windowMock: {
    __OPHIS_FEE_SAFE_TEST_HOOKS__: Hooks
    confirm: jest.Mock
    localStorage: {
      getItem(key: string): string | null
      removeItem(key: string): void
      setItem(key: string, value: string): void
    }
  }
  denyStorage(): void
}

function loadCeremony(): CeremonyHarness {
  const values = new Map<string, string>()
  let storageDenied = false
  const localStorage = {
    getItem(key: string) {
      if (storageDenied) throw new Error('denied')
      return values.get(key) ?? null
    },
    removeItem(key: string) {
      if (storageDenied) throw new Error('denied')
      values.delete(key)
    },
    setItem(key: string, value: string) {
      if (storageDenied) throw new Error('denied')
      values.set(key, value)
    },
  }
  const hooks = {} as Hooks
  const button = { addEventListener: jest.fn(), disabled: false, textContent: '' }
  const status = { textContent: '' }
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/ophis-fee-safe-robinhood-ceremony.js'), 'utf8')
  const execute = new Function('window', 'document', 'navigator', source)
  const windowMock = { __OPHIS_FEE_SAFE_TEST_HOOKS__: hooks, confirm: jest.fn(), localStorage }
  execute(
    windowMock,
    { querySelector: (selector: string) => (selector === '#deploy' ? button : status) },
    { locks: {} },
  )
  return {
    hooks,
    values,
    windowMock,
    denyStorage: () => {
      storageDenied = true
    },
  }
}

describe('Robinhood fee Safe ceremony lock', () => {
  test('marks a matching lock reconciled without deleting its durable tombstone', () => {
    const { hooks, values } = loadCeremony()
    hooks.rememberPendingTransaction(HASH_A, SENDER, '0x1', false)
    expect(hooks.forgetPendingTransaction(HASH_A)).toBe(true)
    expect(values.get(V0)).toBe(HASH_A)
    expect(JSON.parse(values.get(V1) || '{}').hash).toBe(HASH_A)
    expect(values.get(V2)).toBe(HASH_A)
    expect(hooks.readPendingTransaction()).toBeNull()
  })

  test('recognizes a persisted reconciliation tombstone after reload', () => {
    const firstPage = loadCeremony()
    firstPage.hooks.rememberPendingTransaction(HASH_A, SENDER, '0x1', false)
    expect(firstPage.hooks.forgetPendingTransaction(HASH_A)).toBe(true)

    const secondPage = loadCeremony()
    for (const [key, value] of firstPage.values) secondPage.values.set(key, value)
    expect(secondPage.hooks.readPendingTransaction()).toBeNull()
  })

  test('retains a replacement hash during conditional cleanup', () => {
    const { hooks, values } = loadCeremony()
    hooks.rememberPendingTransaction(HASH_A, SENDER, '0x1', false)
    values.set(V0, HASH_B)
    expect(hooks.forgetPendingTransaction(HASH_A)).toBe(false)
    expect(values.get(V0)).toBe(HASH_B)
  })

  test('preserves the in-memory lock when storage becomes unavailable', () => {
    const { hooks, denyStorage } = loadCeremony()
    hooks.rememberPendingTransaction(HASH_A, SENDER, '0x1', false)
    denyStorage()
    expect(hooks.rereadPendingTransaction()?.hash).toBe(HASH_A)
  })

  test('normalizes legacy JSON into raw v0 and structured v1 locks', () => {
    const { hooks, values } = loadCeremony()
    values.set(V0, JSON.stringify({ hash: HASH_A, sender: SENDER, nonce: '0x1' }))
    expect(hooks.readPendingTransaction()?.hash).toBe(HASH_A)
    expect(values.get(V0)).toBe(HASH_A)
    expect(JSON.parse(values.get(V1) || '{}').hash).toBe(HASH_A)
  })

  test('refuses retirement when the lock changes during confirmation', async () => {
    jest.useFakeTimers()
    const { hooks, values, windowMock } = loadCeremony()
    values.set(V0, HASH_A)
    windowMock.confirm.mockImplementation(() => {
      values.set(V0, HASH_B)
      return true
    })
    const provider = {
      request: jest.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x1237'
        if (method === 'eth_getTransactionCount') return '0x0'
        return null
      }),
    }
    const resolution = hooks.waitForPendingResolution(provider, {
      hash: HASH_A,
      sender: SENDER,
      nonce: null,
      nonceProvisional: true,
    })
    const rejection = expect(resolution).rejects.toThrow('newer ceremony transaction lock')
    await jest.runAllTimersAsync()
    await rejection
    jest.useRealTimers()
  })
})
