import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { ADAPT, parseRequest } from '../src/transaction'
import { config, privateRequest } from './request.fixture'

describe('EIP-7702 request boundary', () => {
  it('accepts nonce-bound SDK execution signatures and the actual SDK JSON authorization shape', async () => {
    const raw = await privateRequest('ab'.repeat(32), 'viewing-public-key')
    const parsed = parseRequest(raw, Wallet.createRandom().address, config)
    expect(parsed.type4).toBe(true)
    expect(parsed.authorization?.chainId).toBe(1n)
    expect(parsed.executeNonce).toBe(0n)
    expect(parsed.nullifiers).toEqual([`0x${'12'.repeat(32)}`])
  })
  it('rejects changed calldata signatures, chain, identity and gas limits', async () => {
    const raw = await privateRequest('ab'.repeat(32), 'viewing-public-key')
    const operator = Wallet.createRandom().address
    for (const change of [{ chainID: 56 }, { chainType: 1 }, { useRelayAdapt: false },
      { gasLimit: '9000000' }, { maxFeePerGas: '11000000000' }, { maxPriorityFeePerGas: '0' },
      { txidVersion: 'V3_PoseidonMerkle' }, { minVersion: '9.0.0' }, { feesID: 'not-issued' }])
      expect(() => parseRequest({ ...raw, ...change }, operator, config)).toThrow()
    const args = ADAPT.decodeFunctionData('execute', String(raw.data))
    const changed = ADAPT.encodeFunctionData('execute', [args[0], args[1], 1n, args[3]])
    expect(() => parseRequest({ ...raw, data: changed }, operator, config)).toThrow()
    expect(() => parseRequest({ ...raw, to: operator }, operator, config)).toThrow()
    const auth = raw.authorization as Record<string, unknown>
    expect(() => parseRequest({ ...raw, authorization: { ...auth, chainId: '0' } }, operator, config)).toThrow()
  })
})
