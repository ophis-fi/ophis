import {
  getWalletCallsId,
  getWalletCapabilitiesForChain,
  hasAtomicBatchCapability,
  parseWalletCapabilities,
} from './walletCapabilities'

describe('wallet capabilities', () => {
  it('selects only the requested chain from hex or decimal response keys', () => {
    expect(getWalletCapabilitiesForChain({ '0xa': { atomic: { status: 'supported' } } }, 10)).toEqual({
      atomic: { status: 'supported' },
    })
    expect(getWalletCapabilitiesForChain({ '10': { atomic: { status: 'ready' } } }, 10)).toEqual({
      atomic: { status: 'ready' },
    })
  })

  it('does not fall back to another chain or an ambiguous duplicate entry', () => {
    expect(getWalletCapabilitiesForChain({ '0x1': { atomic: { status: 'supported' } } }, 10)).toBeUndefined()
    expect(
      getWalletCapabilitiesForChain(
        {
          '0xa': { atomic: { status: 'supported' } },
          '10': { atomic: { status: 'unsupported' } },
        },
        10,
      ),
    ).toBeUndefined()
  })

  it('fails closed for malformed capability responses', () => {
    expect(getWalletCapabilitiesForChain(undefined, 10)).toBeUndefined()
    expect(getWalletCapabilitiesForChain(null, 10)).toBeUndefined()
    expect(getWalletCapabilitiesForChain('invalid', 10)).toBeUndefined()
    expect(getWalletCapabilitiesForChain({ '0xa': null }, 10)).toBeUndefined()
    expect(getWalletCapabilitiesForChain({ '0xa': { atomic: { status: 'unexpected' } } }, 10)).toEqual({})
  })

  it('normalizes direct chain-scoped data and recognizes only usable statuses', () => {
    expect(hasAtomicBatchCapability(parseWalletCapabilities({ atomic: { status: 'supported' } }))).toBe(true)
    expect(hasAtomicBatchCapability(parseWalletCapabilities({ atomic: { status: 'ready' } }))).toBe(true)
    expect(hasAtomicBatchCapability(parseWalletCapabilities({ atomic: { status: 'unsupported' } }))).toBe(false)
    expect(hasAtomicBatchCapability(parseWalletCapabilities({ atomic: { status: true } }))).toBe(false)
    expect(hasAtomicBatchCapability(parseWalletCapabilities({ atomicBatch: { supported: true } }))).toBe(true)
  })

  it('accepts only a non-empty string batch identifier', () => {
    expect(getWalletCallsId('0xbatch')).toBe('0xbatch')
    expect(getWalletCallsId({ id: '0xbatch' })).toBe('0xbatch')
    expect(() => getWalletCallsId({})).toThrow('invalid batch identifier')
    expect(() => getWalletCallsId({ id: '' })).toThrow('invalid batch identifier')
    expect(() => getWalletCallsId(null)).toThrow('invalid batch identifier')
  })
})
