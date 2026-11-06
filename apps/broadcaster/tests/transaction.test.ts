import { describe, expect, it } from 'vitest'
import { Wallet, ZeroAddress } from 'ethers'
import { ADAPT, parseRequest } from '../src/transaction'
import { config, privateRequest, signedNativeWithdrawalRequest, signedWithdrawalRequest } from './request.fixture'
import { CHAIN, CHAIN_ID, NETWORK, TOKENS } from '../src/config'

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

describe('permissionless guarded withdrawal boundary', () => {
  const operator = Wallet.createRandom().address, guard = Wallet.createRandom().address
  const settings = { ...config, executionGuard: guard }
  const recipient = Wallet.createRandom().address, token = Wallet.createRandom().address
  function changeTransfer(action: any, index: number, change: (output: any) => void) {
    const output = ADAPT.decodeFunctionData('transfer', action.calls[index].data)[0][0]
    const edited = { ...output.toObject(), token: { ...output.token.toObject() } }
    change(edited)
    action.calls[index].data = ADAPT.encodeFunctionData('transfer', [[edited]])
  }
  it('accepts a signed ERC20 principal outside the fee catalog without accepting it as a fee', async () => {
    const raw = await signedWithdrawalRequest('ab'.repeat(32), 'view', recipient, token)
    expect(parseRequest(raw, operator, settings).withdrawal).toEqual({ token, recipient, amount: 1000n, grossAmount: 1000n })
    expect(() => parseRequest(raw, operator, config)).toThrow('guarded withdrawals')
  })
  it.runIf(CHAIN_ID === 56)('accepts exact native unwrap and send with one fee-bearing WBNB proof', async () => {
    const raw = await signedNativeWithdrawalRequest('ab'.repeat(32), 'view', recipient)
    const parsed = parseRequest(raw, operator, settings)
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.withdrawal).toEqual({ token: TOKENS[0].address, recipient, amount: 1000n, grossAmount: 1000n })
    expect(() => parseRequest(raw, operator, config)).toThrow('guarded withdrawals')
  })
  it.each(['operator', 'guard', 'pool', 'delegate', 'account'])('rejects a %s address masquerading as the principal token', async (kind) => {
    const selected = kind === 'operator' ? operator : kind === 'guard' ? guard : kind === 'pool'
      ? NETWORK.proxyContract : kind === 'delegate' ? NETWORK.relayAdapt7702Contract : token
    const raw = await signedWithdrawalRequest('ab'.repeat(32), 'view', recipient, selected, undefined, (transactions, action, account) => {
      if (kind === 'account') {
        transactions[1].unshieldPreimage.token.tokenAddress = account
        changeTransfer(action, 0, (output) => { output.token.tokenAddress = account })
      }
    })
    expect(() => parseRequest(raw, operator, settings)).toThrow('principal token')
  })
  it.each(['zero-token', 'mismatched-token', 'nft', 'sub-id', 'recipient-account', 'zero-recipient', 'zero-value', 'call-value', 'extra-call', 'wrong-chain', 'unbound-account'])('rejects a signed malformed ERC20 withdrawal: %s', async (kind) => {
    const raw = await signedWithdrawalRequest('ab'.repeat(32), 'view', recipient, token, undefined, (transactions, action, account) => {
      if (kind === 'zero-token') {
        transactions[1].unshieldPreimage.token.tokenAddress = ZeroAddress
        changeTransfer(action, 0, (output) => { output.token.tokenAddress = ZeroAddress })
      }
      if (kind === 'mismatched-token') changeTransfer(action, 0, (output) => { output.token.tokenAddress = TOKENS[1].address })
      if (kind === 'nft') changeTransfer(action, 0, (output) => { output.token.tokenType = 1 })
      if (kind === 'sub-id') changeTransfer(action, 0, (output) => { output.token.tokenSubID = 1 })
      if (kind === 'recipient-account') changeTransfer(action, 0, (output) => { output.to = account })
      if (kind === 'zero-recipient') changeTransfer(action, 0, (output) => { output.to = ZeroAddress })
      if (kind === 'zero-value') changeTransfer(action, 0, (output) => { output.value = 0n })
      if (kind === 'call-value') action.calls[0].value = 1n
      if (kind === 'extra-call') action.calls.push({ ...action.calls[0] })
      if (kind === 'wrong-chain') transactions[1].boundParams.chainID = CHAIN_ID === 1 ? 56 : 1
      if (kind === 'unbound-account') transactions[1].boundParams.adaptContract = ZeroAddress
    })
    expect(() => parseRequest(raw, operator, settings)).toThrow()
  })
  it.runIf(CHAIN_ID === 56).each(['unwrap-zero', 'unwrap-more', 'unwrap-less', 'reordered', 'extra-call', 'external-call', 'call-value',
    'non-native-output', 'wrong-principal', 'wrong-unshield-account', 'no-unshield', 'missing-fee-output', 'ciphertext-count',
    'zero-value', 'different-send-value', 'recipient-account', 'zero-recipient', 'requireSuccess-false'])('rejects a signed malformed native withdrawal: %s', async (kind) => {
    const raw = await signedNativeWithdrawalRequest('ab'.repeat(32), 'view', recipient, undefined, (transactions, action, account) => {
      if (kind.startsWith('unwrap-')) action.calls[0].data = ADAPT.encodeFunctionData('unwrapBase', [kind === 'unwrap-zero' ? 0n : kind === 'unwrap-more' ? 1001n : 999n])
      if (kind === 'reordered') action.calls.reverse()
      if (kind === 'extra-call') action.calls.push({ ...action.calls[1] })
      if (kind === 'external-call') action.calls[0].to = recipient
      if (kind === 'call-value') action.calls[1].value = 1n
      if (kind === 'non-native-output') changeTransfer(action, 1, (output) => { output.token.tokenAddress = TOKENS[0].address })
      if (kind === 'wrong-principal') transactions[0].unshieldPreimage.token.tokenAddress = token
      if (kind === 'wrong-unshield-account') transactions[0].unshieldPreimage.npk = `0x${recipient.slice(2).padStart(64, '0')}`
      if (kind === 'no-unshield') transactions[0].boundParams.unshield = 0
      if (kind === 'missing-fee-output') transactions[0].commitments.shift()
      if (kind === 'ciphertext-count') transactions[0].boundParams.commitmentCiphertext = []
      if (kind === 'zero-value') changeTransfer(action, 1, (output) => { output.value = 0n })
      if (kind === 'different-send-value') changeTransfer(action, 1, (output) => { output.value = 999n })
      if (kind === 'recipient-account') changeTransfer(action, 1, (output) => { output.to = account })
      if (kind === 'zero-recipient') changeTransfer(action, 1, (output) => { output.to = ZeroAddress })
      if (kind === 'requireSuccess-false') action.requireSuccess = false
    })
    expect(() => parseRequest(raw, operator, settings)).toThrow()
  })
  it.runIf(CHAIN_ID !== 56)('keeps native unwrap outside BNB closed without changing guarded ERC20 support', async () => {
    const raw = await signedNativeWithdrawalRequest('ab'.repeat(32), 'view', recipient)
    expect(() => parseRequest(raw, operator, settings)).toThrow()
  })
  it.runIf(CHAIN_ID === 56)('still rejects a BNB public transfer with requireSuccess disabled', async () => {
    const raw = await signedWithdrawalRequest('ab'.repeat(32), 'view', recipient, token, undefined,
      (_transactions, action) => { action.requireSuccess = false })
    expect(() => parseRequest(raw, operator, settings)).toThrow('must require')
  })
})
