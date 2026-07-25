import { detectAtomicBatchCapability, buildSetPreSignatureCalls } from './capabilities'

describe('detectAtomicBatchCapability', () => {
  it('detects the current spec shape (atomic.status supported/ready) by hex key', () => {
    expect(detectAtomicBatchCapability({ '0xa': { atomic: { status: 'supported' } } }, 10)).toBe(true)
    expect(detectAtomicBatchCapability({ '0xa': { atomic: { status: 'ready' } } }, 10)).toBe(true)
  })

  it('detects the older atomicBatch.supported shape', () => {
    expect(detectAtomicBatchCapability({ '0xa': { atomicBatch: { supported: true } } }, 10)).toBe(true)
  })

  it('accepts decimal chain-id keys', () => {
    expect(detectAtomicBatchCapability({ '10': { atomic: { status: 'supported' } } }, 10)).toBe(true)
  })

  it('returns false for unsupported / missing / malformed capabilities', () => {
    expect(detectAtomicBatchCapability({ '0xa': { atomic: { status: 'unsupported' } } }, 10)).toBe(false)
    expect(detectAtomicBatchCapability({ '0x1': { atomic: { status: 'supported' } } }, 10)).toBe(false) // wrong chain
    expect(detectAtomicBatchCapability(undefined, 10)).toBe(false)
    expect(detectAtomicBatchCapability(null, 10)).toBe(false)
    expect(detectAtomicBatchCapability({}, 10)).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(detectAtomicBatchCapability('nope' as any, 10)).toBe(false)
    expect(detectAtomicBatchCapability({ '0xa': null }, 10)).toBe(false)
  })
})

describe('buildSetPreSignatureCalls', () => {
  const SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859'
  const encode = (uid: string): string => `0xenc(${uid})`

  it('builds one call per leg, all to the settlement contract, in order', () => {
    const calls = buildSetPreSignatureCalls(['0xaa', '0xbb', '0xcc'], SETTLEMENT, encode)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.to === SETTLEMENT && c.value === '0x0')).toBe(true)
    expect(calls.map((c) => c.data)).toEqual(['0xenc(0xaa)', '0xenc(0xbb)', '0xenc(0xcc)'])
  })

  it('throws on empty uids or missing settlement', () => {
    expect(() => buildSetPreSignatureCalls([], SETTLEMENT, encode)).toThrow()
    expect(() => buildSetPreSignatureCalls(['0xaa'], '', encode)).toThrow()
  })
})
