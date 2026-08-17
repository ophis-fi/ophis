import {
  buildWalletSendCallsRequest,
  canSafelyRetryWalletCalls,
  getWalletCallsId,
  getWalletCapabilitiesForChain,
  hasAtomicBatchCapability,
  parseWalletCallsStatus,
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

  it('accepts only a bounded hexadecimal batch identifier', () => {
    expect(getWalletCallsId('0xabcd')).toBe('0xabcd')
    expect(getWalletCallsId({ id: '0xabcd' })).toBe('0xabcd')
    expect(() => getWalletCallsId({ id: { id: '0xabcd' } })).toThrow('invalid batch identifier')
    expect(() => getWalletCallsId({})).toThrow('invalid batch identifier')
    expect(() => getWalletCallsId({ id: '' })).toThrow('invalid batch identifier')
    expect(() => getWalletCallsId('batch')).toThrow('invalid batch identifier')
    expect(() => getWalletCallsId(`0x${'a'.repeat(8193)}`)).toThrow('invalid batch identifier')
    expect(() => getWalletCallsId(null)).toThrow('invalid batch identifier')
  })
})

describe('wallet call safety', () => {
  it('parses only a status for the expected batch and chain', () => {
    expect(
      parseWalletCallsStatus(
        {
          version: '2.0.0',
          chainId: '0x0a',
          status: 200,
          atomic: true,
          receipts: [{ transactionHash: '0x1234', status: '0x1' }],
        },
        '0xabcd',
        10,
      ),
    ).toEqual({
      id: '0xabcd',
      chainId: 10,
      status: 200,
      category: 'confirmed',
      atomic: true,
      transactionHashes: ['0x1234'],
    })
  })

  it('fails closed for mismatched, unknown, and malformed statuses', () => {
    const valid = { version: '2.0.0', chainId: '0xa', status: 100, atomic: true }

    expect(() => parseWalletCallsStatus({ ...valid, id: '0x1234' }, '0xabcd', 10)).toThrow('invalid batch status')
    expect(() => parseWalletCallsStatus(valid, 'not-hex', 10)).toThrow('invalid batch identifier')
    expect(() => parseWalletCallsStatus({ ...valid, chainId: '0x1' }, '0xabcd', 10)).toThrow('invalid batch status')
    expect(() => parseWalletCallsStatus({ ...valid, status: 201 }, '0xabcd', 10)).toThrow('invalid batch status')
    expect(() => parseWalletCallsStatus({ ...valid, atomic: false }, '0xabcd', 10)).toThrow('invalid batch status')
    expect(() => parseWalletCallsStatus({ ...valid, version: '1.0.0' }, '0xabcd', 10)).toThrow('invalid batch status')
    expect(() => parseWalletCallsStatus({ ...valid, status: 200 }, '0xabcd', 10)).toThrow(
      'invalid confirmed batch receipt',
    )
    expect(() =>
      parseWalletCallsStatus(
        { ...valid, status: 200, receipts: [{ transactionHash: '0x1234', status: '0x0' }] },
        '0xabcd',
        10,
      ),
    ).toThrow('invalid confirmed batch receipt')
    expect(() =>
      parseWalletCallsStatus(
        { ...valid, status: 400, receipts: [{ transactionHash: '0x1234', status: '0x0' }] },
        '0xabcd',
        10,
      ),
    ).toThrow('unsafe retry batch receipt')
    expect(() =>
      parseWalletCallsStatus(
        { ...valid, status: 500, receipts: [{ transactionHash: '0x1234', status: '0x1' }] },
        '0xabcd',
        10,
      ),
    ).toThrow('unsafe retry batch receipt')
  })

  it('allows stepped retry only after a terminal non-partial failure', () => {
    const getStatus = (status: 100 | 200 | 400 | 500 | 600): ReturnType<typeof parseWalletCallsStatus> =>
      parseWalletCallsStatus(
        {
          version: '2.0.0',
          id: '0xabcd',
          chainId: '0xa',
          status,
          atomic: true,
          receipts: status === 200 ? [{ transactionHash: '0x1234', status: '0x1' }] : undefined,
        },
        '0xabcd',
        10,
      )

    expect(canSafelyRetryWalletCalls(getStatus(100))).toBe(false)
    expect(canSafelyRetryWalletCalls(getStatus(200))).toBe(false)
    expect(canSafelyRetryWalletCalls(getStatus(400))).toBe(true)
    expect(canSafelyRetryWalletCalls(getStatus(500))).toBe(true)
    expect(canSafelyRetryWalletCalls(getStatus(600))).toBe(false)
  })
})

describe('wallet call request safety', () => {
  it('builds a version-2 atomic direct-call request', () => {
    expect(
      buildWalletSendCallsRequest(
        [
          {
            to: '0x1111111111111111111111111111111111111111',
            data: '0x1234',
            value: '15',
            operation: 0,
          },
        ],
        '0x2222222222222222222222222222222222222222',
        10,
      ),
    ).toEqual({
      version: '2.0.0',
      from: '0x2222222222222222222222222222222222222222',
      chainId: '0xa',
      atomicRequired: true,
      calls: [{ to: '0x1111111111111111111111111111111111111111', data: '0x1234', value: '0xf' }],
    })
  })

  it('rejects empty, malformed, and delegate-call batches', () => {
    const account = '0x2222222222222222222222222222222222222222'
    const directCall = { to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' }

    expect(() => buildWalletSendCallsRequest([], account, 1)).toThrow('invalid wallet call batch')
    expect(() => buildWalletSendCallsRequest([directCall], '0x0000000000000000000000000000000000000000', 1)).toThrow(
      'invalid wallet call batch',
    )
    expect(() =>
      buildWalletSendCallsRequest([{ ...directCall, to: '0x0000000000000000000000000000000000000000' }], account, 1),
    ).toThrow('direct calls only')
    expect(() => buildWalletSendCallsRequest([{ ...directCall, operation: 1 }], account, 1)).toThrow(
      'direct calls only',
    )
    expect(() => buildWalletSendCallsRequest([{ ...directCall, value: '-1' }], account, 1)).toThrow('direct calls only')
    expect(() => buildWalletSendCallsRequest([{ ...directCall, value: ' 1' }], account, 1)).toThrow('direct calls only')
    expect(() => buildWalletSendCallsRequest([{ ...directCall, value: `0x1${'0'.repeat(64)}` }], account, 1)).toThrow(
      'exceeds uint256',
    )
  })
})
