import { afterEach, expect, it, vi } from 'vitest'
import { getAddress } from 'ethers'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it.each([[1, 'ETH', 'WETH', 1], [42161, 'ETH', 'WETH', 1], [56, 'BNB', 'WBNB', 0], [137, 'POL', 'WPOL', 1]])(
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
    expect(config.TOKENS).toHaveLength(3)
    expect(config.FEE_TOKENS).toEqual(chainId === 56 ? config.TOKENS.slice(0, 1) : config.TOKENS)
    expect(config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9' }).chainId).toBe(chainId)
    expect(() => config.settings({ OPHIS_BROADCASTER_CHAIN_ID: chainId === 1 ? '56' : '1' })).toThrow('match the process')
    if (chainId !== 1) {
      expect(() => config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId) })).toThrow('trusted RPC')
      expect(() => config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_ENABLED: '1',
        OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9' })).toThrow('awaits qualified private delivery')
      const disabled = config.settings({ OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9' })
      const { recover } = await import('../src/recovery')
      const { deployGuard } = await import('../src/guard-deployment')
      for (const command of ['retry', 'cancel'] as const)
        await expect(recover(command, [], disabled, null as never, null as never, null as never, null as never))
          .rejects.toThrow('awaits qualified private delivery')
      await expect(deployGuard(disabled, null as never, null as never, null as never))
        .rejects.toThrow('awaits qualified private delivery')
      if (chainId !== 56)
        await expect(deployGuard(disabled, { chainId, gasFundingApproved: true } as never, null as never, null as never))
          .rejects.toThrow('awaits qualified private delivery')
    }
  },
)

it.each(['0', '-1', '01', '1.0', '1e0', '8453', '10', '999999999999999999999999999999'])(
  'rejects unsupported or ambiguous chain ID %s before startup', async (value) => {
    vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', value)
    await expect(import('../src/config')).rejects.toThrow(/chain/i)
  },
)
