import { afterEach, expect, it, vi } from 'vitest'
import { getAddress } from 'ethers'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it.each([[42161, 'arb'], [8453, 'base']])('pins chain %i submission without enabling mainnet signing', async (chainId, prefix) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { settings } = await import('../src/config')
  const env = { OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9',
    OPHIS_BROADCASTER_WRITE_RPC: chainId === 8453 ? 'https://mainnet-sequencer.base.org' : `https://${prefix}-mainnet.g.alchemy.com/v2/test-key` }
  expect(settings(env)).toMatchObject({ writeRpc: env.OPHIS_BROADCASTER_WRITE_RPC, enabled: false })
  expect(() => settings({ ...env, OPHIS_BROADCASTER_ENABLED: '1' })).toThrow(chainId === 42161 ? 'requires native prepayment' : 'native-prepayment pilot')
  for (const endpoint of ['invalid-secret-value', 'https://example.com/v2/key', env.OPHIS_BROADCASTER_WRITE_RPC + '?secret'])
    expect(() => settings({ ...env, OPHIS_BROADCASTER_WRITE_RPC: endpoint })).toThrow(chainId === 8453 ? 'fixed sequencer' : 'pinned Alchemy')
})

it.each([[1, 'ETH', 'WETH', 1], [42161, 'ETH', 'WETH', 1], [56, 'BNB', 'WBNB', 0], [137, 'POL', 'WPOL', 1], [8453, 'ETH', 'WETH', 1]])(
  'pins chain %i, native currency, wire topics and transaction pricing', async (chainId, native, wrapped, commonType) => {
    vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
    const config = await import('../src/config')
    expect(config.CHAIN_ID).toBe(chainId)
    expect(config.CHAIN).toBe(BigInt(chainId))
    expect(config.NETWORK.chain.id).toBe(chainId)
    expect(config.NATIVE_SYMBOL).toBe(native)
    expect(config.TOKENS[0].symbol).toBe(wrapped)
    expect(config.COMMON_TRANSACTION_TYPE).toBe(commonType)
    expect(Object.values(config.TOPICS)).toEqual(['fees', 'transact', 'transact-response']
      .map((kind) => `/railgun/v2/0-${chainId}-${kind}/json`))
    expect(config.TOKENS.every((token) => token.address === getAddress(token.address))).toBe(true)
    expect(config.TOKENS).toHaveLength(chainId === 8453 ? 2 : 3)
    expect(config.FEE_TOKENS).toEqual(chainId === 56 ? config.TOKENS.slice(0, 1) : config.TOKENS)
    expect(config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9' }).chainId).toBe(chainId)
    expect(() => config.settings({ OPHIS_BROADCASTER_CHAIN_ID: chainId === 1 ? '56' : '1' })).toThrow('match the process')
    if (chainId !== 1) {
      expect(() => config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId) })).toThrow('trusted RPC')
    }
    if (chainId !== 1 && chainId !== 56) {
      const gate = chainId === 137 ? 'awaits qualified private delivery' : chainId === 42161 ? 'requires native prepayment' : 'native-prepayment pilot'
      expect(() => config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_ENABLED: '1',
        OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9' })).toThrow(gate)
      const disabled = config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9' })
      const { recover } = await import('../src/recovery')
      const { deployGuard } = await import('../src/guard-deployment')
      for (const command of ['retry', 'cancel'] as const)
        await expect(recover(command, [], disabled, null as never, null as never, null as never, null as never))
          .rejects.toThrow(gate)
      await expect(deployGuard(disabled, null as never, null as never, null as never))
        .rejects.toThrow(gate)
      await expect(deployGuard(disabled, { chainId, gasFundingApproved: true } as never, null as never, null as never))
        .rejects.toThrow(gate)
    }
  },
)

const pilotEnv = {
  OPHIS_BROADCASTER_CHAIN_ID: '56', OPHIS_BROADCASTER_MODE: 'mainnet', OPHIS_BROADCASTER_ADMISSION: 'pilot',
  OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9',
  OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '500000000', OPHIS_BROADCASTER_MAX_TX_COST_WEI: '500000000000000',
  OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '500000000000000', OPHIS_BROADCASTER_RESERVE_WEI: '19500000000000000',
  OPHIS_BROADCASTER_MARGIN_BPS: '1500',
  OPHIS_BROADCASTER_OPERATOR_ADDRESS: '0x0000000000000000000000000000000000001234',
  OPHIS_BROADCASTER_EXECUTION_GUARD: '0x0000000000000000000000000000000000005678',
  OPHIS_BROADCASTER_PILOT_ACCOUNT: '0x0000000000000000000000000000000000007890',
  OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT: '0x0000000000000000000000000000000000004321',
}

it.each([1, 56, 42161, 137, 8453])('keeps chain %i mainnet signing scoped to its accepted admission policy', async (chainId) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { assertSigningNetwork } = await import('../src/config')
  for (const admission of ['pilot', 'public'] as const) {
    const selected = { chainId, mode: 'mainnet' as const, admission }
    if (chainId === 1 || (chainId === 56 && admission === 'pilot'))
      expect(() => assertSigningNetwork(selected)).not.toThrow()
    else expect(() => assertSigningNetwork(selected)).toThrow(/acceptance/)
    expect(() => assertSigningNetwork({ ...selected, mode: 'fork' })).not.toThrow()
    expect(() => assertSigningNetwork({ ...selected, chainId: chainId === 1 ? 56 : 1 })).toThrow('process broadcaster chain')
  }
})

it('permits the BNB mainnet pilot without changing its explicit identities or money limits', async () => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '56')
  const { settings } = await import('../src/config')
  expect(settings(pilotEnv)).toMatchObject({ chainId: 56, mode: 'mainnet', admission: 'pilot', enabled: true,
    operatorAddress: pilotEnv.OPHIS_BROADCASTER_OPERATOR_ADDRESS, executionGuard: pilotEnv.OPHIS_BROADCASTER_EXECUTION_GUARD,
    pilotAccount: pilotEnv.OPHIS_BROADCASTER_PILOT_ACCOUNT, pilotWithdrawalRecipient: pilotEnv.OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT,
    maxGasPrice: 500_000_000n, maxTransactionCost: 500_000_000_000_000n, dailyBudget: 500_000_000_000_000n,
    reserve: 19_500_000_000_000_000n, marginBps: 1500n })
  expect(settings({ ...pilotEnv, OPHIS_BROADCASTER_ENABLED: undefined }).enabled).toBe(false)
})

it.each(['OPHIS_BROADCASTER_OPERATOR_ADDRESS', 'OPHIS_BROADCASTER_EXECUTION_GUARD', 'OPHIS_BROADCASTER_PILOT_ACCOUNT',
  'OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI', 'OPHIS_BROADCASTER_MAX_TX_COST_WEI', 'OPHIS_BROADCASTER_DAILY_BUDGET_WEI',
  'OPHIS_BROADCASTER_RESERVE_WEI', 'OPHIS_BROADCASTER_MARGIN_BPS'])(
  'keeps BNB pilot startup closed without %s', async (field) => {
    vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '56')
    const { settings } = await import('../src/config')
    expect(() => settings({ ...pilotEnv, [field]: undefined })).toThrow()
  },
)

it('blocks BNB public startup and recovery without native prepayment before any read, signature or disclosure', async () => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '56')
  const { settings } = await import('../src/config')
  const env = { ...pilotEnv, OPHIS_BROADCASTER_ADMISSION: 'public',
    OPHIS_BROADCASTER_PILOT_ACCOUNT: undefined, OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT: undefined }
  expect(() => settings(env)).toThrow('restricted to pilot admission')
  const disabled = settings({ ...env, OPHIS_BROADCASTER_ENABLED: '0' })
  const { recover } = await import('../src/recovery')
  for (const command of ['retry', 'cancel'] as const)
    await expect(recover(command, [], disabled, null as never, null as never, null as never, null as never))
      .rejects.toThrow('restricted to pilot admission')
})

it.each([56, 42161])('allows chain %i public native prepayment while retaining the signing and money prerequisites', async (chainId) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { settings, assertSigningNetwork } = await import('../src/config')
  const env = { ...pilotEnv, OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_ADMISSION: 'public', OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'public-native',
    OPHIS_BROADCASTER_CREDIT_LEDGER_ID: `0x${'AB'.repeat(32)}`,
    OPHIS_BROADCASTER_PILOT_ACCOUNT: undefined, OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT: undefined }
  const config = settings(env)
  expect(config).toMatchObject({ chainId, enabled: true, admission: 'public', creditPaymentMode: 'public-native', creditLedgerId: `0x${'ab'.repeat(32)}`,
    executionGuard: pilotEnv.OPHIS_BROADCASTER_EXECUTION_GUARD, operatorAddress: pilotEnv.OPHIS_BROADCASTER_OPERATOR_ADDRESS,
    maxGasPrice: 500_000_000n, maxTransactionCost: 500_000_000_000_000n, reserve: 19_500_000_000_000_000n, marginBps: 1500n })
  expect(() => assertSigningNetwork(config)).not.toThrow()
  for (const field of ['OPHIS_BROADCASTER_OPERATOR_ADDRESS', 'OPHIS_BROADCASTER_EXECUTION_GUARD',
    'OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI', 'OPHIS_BROADCASTER_MAX_TX_COST_WEI', 'OPHIS_BROADCASTER_DAILY_BUDGET_WEI',
    'OPHIS_BROADCASTER_RESERVE_WEI', 'OPHIS_BROADCASTER_MARGIN_BPS', 'OPHIS_BROADCASTER_CREDIT_LEDGER_ID']) {
    expect(() => settings({ ...env, [field]: undefined })).toThrow()
  }
  expect(() => settings({ ...env, OPHIS_BROADCASTER_PILOT_ACCOUNT: pilotEnv.OPHIS_BROADCASTER_PILOT_ACCOUNT })).toThrow('pilot restrictions')
  expect(() => settings({ ...env, OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'private-wrapped' })).toThrow(/native prepayment/)
  for (const id of ['', '0x12', `0x${'00'.repeat(32)}`, `0x${'gg'.repeat(32)}`])
    expect(() => settings({ ...env, OPHIS_BROADCASTER_CREDIT_LEDGER_ID: id })).toThrow('credit ledger ID')
})

it.each([42161, 8453])('requires all native prepaid pilot bindings on L2 %i', async (chainId) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { settings, assertSigningNetwork } = await import('../src/config')
  const env = { ...pilotEnv, OPHIS_BROADCASTER_CHAIN_ID: String(chainId),
    OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'public-native',
    OPHIS_BROADCASTER_PREPAID_PILOT_OWNER: '0x0000000000000000000000000000000000001234',
    OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID: `0x${'AB'.repeat(32)}`,
    OPHIS_BROADCASTER_WRITE_RPC: chainId === 8453 ? 'https://mainnet-sequencer.base.org'
      : 'https://arb-mainnet.g.alchemy.com/v2/test-key' }
  expect(settings(env)).toMatchObject({ chainId, enabled: true, admission: 'pilot', creditPaymentMode: 'public-native',
    prepaidPilotOwner: env.OPHIS_BROADCASTER_PREPAID_PILOT_OWNER,
    prepaidPilotLedgerId: env.OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID.toLowerCase() })
  expect(() => assertSigningNetwork(settings(env))).not.toThrow()
  expect(() => settings({ ...env, OPHIS_BROADCASTER_ADMISSION: 'public' })).toThrow(chainId === 42161 ? 'prepaid pilot opt-in' : 'native-prepayment pilot')
  expect(() => settings({ ...env, OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'private-wrapped' })).toThrow(chainId === 42161 ? 'requires native prepayment' : 'native-prepayment pilot')
  for (const field of ['OPHIS_BROADCASTER_OPERATOR_ADDRESS', 'OPHIS_BROADCASTER_EXECUTION_GUARD', 'OPHIS_BROADCASTER_PILOT_ACCOUNT',
    'OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI', 'OPHIS_BROADCASTER_MAX_TX_COST_WEI', 'OPHIS_BROADCASTER_DAILY_BUDGET_WEI',
    'OPHIS_BROADCASTER_RESERVE_WEI', 'OPHIS_BROADCASTER_MARGIN_BPS'])
    expect(() => settings({ ...env, [field]: undefined })).toThrow()
})

it('keeps Base public signing closed even with native prepayment and no pilot bindings', async () => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '8453')
  const { settings } = await import('../src/config')
  expect(() => settings({ ...pilotEnv, OPHIS_BROADCASTER_CHAIN_ID: '8453', OPHIS_BROADCASTER_ADMISSION: 'public',
    OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'public-native', OPHIS_BROADCASTER_PILOT_ACCOUNT: undefined,
    OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT: undefined })).toThrow('native-prepayment pilot')
})

it.each(['0', '-1', '01', '1.0', '1e0', '84532', '10', '999999999999999999999999999999'])(
  'rejects unsupported or ambiguous chain ID %s before startup', async (value) => {
    vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', value)
    await expect(import('../src/config')).rejects.toThrow(/chain/i)
  },
)


it.each([1, 56, 42161, 8453])('requires an exact nonzero prepaid pilot ledger opt-in on chain%i', async (chainId) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { settings } = await import('../src/config')
  const env = { OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9',
    ...([42161, 8453].includes(chainId) ? { OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'public-native' } : {}) }
  const approvedOwner = '0x0000000000000000000000000000000000001234'
  const ledger = `0x${'AB'.repeat(32)}`
  expect(settings(env).prepaidPilotLedgerId).toBeUndefined()
  expect(settings({ ...env, OPHIS_BROADCASTER_PREPAID_PILOT_OWNER: approvedOwner, OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID: ledger }).prepaidPilotLedgerId).toBe(ledger.toLowerCase())
  expect(() => settings({ ...env, OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID: ledger })).toThrow('both')
  expect(() => settings({ ...env, OPHIS_BROADCASTER_PREPAID_PILOT_OWNER: approvedOwner })).toThrow('both')
  expect(() => settings({ ...env, OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID: ledger,
    OPHIS_BROADCASTER_PREPAID_PILOT_OWNER: '0x0000000000000000000000000000000000000000' })).toThrow('nonzero')
  for (const invalid of ['', '0x12', `0x${'00'.repeat(32)}`, `0x${'gg'.repeat(32)}`])
    expect(() => settings({ ...env, OPHIS_BROADCASTER_PREPAID_PILOT_OWNER: approvedOwner, OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID: invalid })).toThrow('prepaid pilot')
  expect(() => settings({ ...env, OPHIS_BROADCASTER_ADMISSION: 'public',
    OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID: ledger, OPHIS_BROADCASTER_PREPAID_PILOT_OWNER: approvedOwner })).toThrow('prepaid pilot')
  if ([42161, 8453].includes(chainId))
    expect(() => settings({ ...env, OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'private-wrapped',
      OPHIS_BROADCASTER_PREPAID_PILOT_LEDGER_ID: ledger, OPHIS_BROADCASTER_PREPAID_PILOT_OWNER: approvedOwner })).toThrow('prepaid pilot')
})


it.each([1, 56, 42161, 137, 8453])('requires explicit native payment mode and preserves independent admission on chain %i', async (chainId) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { settings } = await import('../src/config')
  const env = { OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9' }
  expect(settings(env).creditPaymentMode).toBe('private-wrapped')
  expect(settings({ ...env, OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'public-native' })).toMatchObject({
    creditPaymentMode: 'public-native', enabled: false, admission: 'pilot', creditCollectionGas: 0n,
  })
  expect(() => settings({ ...env, OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'native' })).toThrow('payment mode')
})
