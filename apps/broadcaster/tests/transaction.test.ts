import { describe, expect, it } from 'vitest'
import { Wallet } from 'ethers'
import { ADAPT, parseRequest } from '../src/transaction'
import { config, privateRequest } from './request.fixture'
import { CHAIN, CHAIN_ID } from '../src/config'

describe('EIP-7702 request boundary', () => {
  it('rejects a validly signed type-4 proof with a gas-price floor that can fail after base-fee changes', async () => {
    const request = await privateRequest('ab'.repeat(32), 'viewing-public-key', `0x${'12'.repeat(32)}`, 1n)
    expect(() => parseRequest(request, Wallet.createRandom().address, config)).toThrow('zero gas-price floor')
  })
  it('accepts nonce-bound SDK execution signatures and the actual SDK JSON authorization shape', async () => {
    const raw = await privateRequest('ab'.repeat(32), 'viewing-public-key')
    const parsed = parseRequest(raw, Wallet.createRandom().address, config)
    expect(parsed.type4).toBe(true)
    expect(parsed.authorization?.chainId).toBe(CHAIN)
    expect(parsed.transaction.chainId).toBe(CHAIN)
    expect(parsed.executeNonce).toBe(0n)
    expect(parsed.nullifiers).toEqual([`0x${'12'.repeat(32)}`])
  })
  it('rejects changed calldata signatures, chain, identity and gas limits', async () => {
    const raw = await privateRequest('ab'.repeat(32), 'viewing-public-key')
    const operator = Wallet.createRandom().address
    for (const change of [{ chainID: CHAIN_ID === 56 ? 1 : 56 }, { chainType: 1 }, { useRelayAdapt: false },
      { gasLimit: '9000000' }, { maxFeePerGas: '11000000000' }, { maxPriorityFeePerGas: '0' },
      { txidVersion: 'V3_PoseidonMerkle' }, { minVersion: '9.0.0' }, { feesID: 'not-issued' }])
      expect(() => parseRequest({ ...raw, ...change }, operator, config)).toThrow()
    const args = ADAPT.decodeFunctionData('execute', String(raw.data))
    const changed = ADAPT.encodeFunctionData('execute', [args[0], args[1], 1n, args[3]])
    expect(() => parseRequest({ ...raw, data: changed }, operator, config)).toThrow()
    expect(() => parseRequest({ ...raw, to: operator }, operator, config)).toThrow()
    const auth = raw.authorization as Record<string, unknown>
    expect(() => parseRequest({ ...raw, authorization: { ...auth, chainId: '0' } }, operator, config)).toThrow()
    for (const chainId of [1, 56, 137, 42161, 8453].filter((id) => id !== CHAIN_ID)) {
      const authorization = await Wallet.createRandom().authorize({ chainId, nonce: 0, address: String(auth.address) })
      expect(() => parseRequest({ ...raw, authorization }, operator, config)).toThrow()
    }
    expect(() => parseRequest(raw, operator, { ...config, chainId: CHAIN_ID === 1 ? 56 : 1 })).toThrow()
  })
})
