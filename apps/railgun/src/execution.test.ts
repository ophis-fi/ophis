import { describe, expect, it } from 'vitest'
import { Wallet, JsonRpcProvider } from 'ethers'
import { RelayAdapt7702ExecutionType, type RelayAdapt7702Request } from '@railgun-community/engine'
import {
  ADAPT,
  PRIVACY,
  assertAuthorization,
  assertReceipt,
  assertPrivateOutput,
  assertTraceSuccess,
  assertSameExecution,
  encodeRequest,
} from './execution'
import { CONFIG, TOKENS } from './config'
import type { WalletSession } from './wallet'

async function request(chainId = 1n, delegate = CONFIG.relayAdapt7702Contract): Promise<RelayAdapt7702Request> {
  const wallet = Wallet.createRandom()
  return {
    transactions: [],
    actionData: { requireSuccess: false, calls: [], minGasLimit: 0n },
    authorization: await wallet.authorize({ address: delegate, chainId, nonce: 0 }),
    ephemeralAddress: wallet.address,
    executionSignature: '0x',
    executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce,
    executeNonce: 0n,
  }
}

describe('private execution guards', () => {
  it('rejects a populated payload or authorization differing from the recorded and simulated request', async () => {
    const provider = new JsonRpcProvider('http://127.0.0.1:8549')
    const session = { provider } as WalletSession
    const valid = await request()
    const transaction = encodeRequest(valid)
    expect(() => assertSameExecution(session, valid, transaction)).not.toThrow()
    expect(() => assertSameExecution(session, valid, { ...transaction, data: '0x' })).toThrow(/differs/)
    expect(() => assertSameExecution(session, valid, { ...transaction, authorizationList: [] })).toThrow(/differs/)
    expect(() => assertSameExecution(session, valid, { ...transaction, value: 1n })).toThrow(/public value/)
    provider.destroy()
  })
  it('blocks failed inner calls and unusable traces even when the outer call succeeds', () => {
    expect(() => assertTraceSuccess({ type: 'CALL', calls: [{ type: 'DELEGATECALL', calls: [] }] })).not.toThrow()
    expect(() => assertTraceSuccess({ type: 'CALL', calls: [{ type: 'CALL', error: 'execution reverted' }] })).toThrow(
      /would fail/,
    )
    for (const invalid of [null, {}, { type: 'CALL', calls: 'unavailable' }])
      expect(() => assertTraceSuccess(invalid)).toThrow()
  })
  it('accepts only the canonical delegate, Ethereum and the correct ephemeral signer', async () => {
    const valid = await request()
    expect(() => assertAuthorization(valid)).not.toThrow()
    for (const chain of [0n, 10n]) {
      const invalid = await request(chain)
      expect(() => assertAuthorization(invalid)).toThrow(/delegate or chain/)
    }
    const wrong = await request(1n, Wallet.createRandom().address)
    expect(() => assertAuthorization(wrong)).toThrow(/delegate or chain/)
    expect(() => assertAuthorization({ ...valid, ephemeralAddress: Wallet.createRandom().address })).toThrow(
      /does not belong/,
    )
  })
  it('does not treat a successful outer receipt with CallError as a successful swap', () => {
    const event = ADAPT.getEvent('CallError')
    if (!event) throw new Error('Missing upstream CallError ABI')
    const encoded = ADAPT.encodeEventLog(event, [1n, '0xdeadbeef'])
    const address = Wallet.createRandom().address
    const receipt = { status: 1, logs: [{ address, ...encoded }] }
    expect(() => assertReceipt(receipt, address)).toThrow(/call failed/)
    expect(() => assertReceipt({ ...receipt, status: 0 }, address)).toThrow(/reverted/)
  })

  it('requires the minimum private output for the exact token and committed note', () => {
    const event = PRIVACY.getEvent('Shield')
    if (!event) throw new Error('Missing upstream Shield ABI')
    const npk = `0x${'01'.padStart(64, '0')}`
    const note = { npk, token: { tokenAddress: TOKENS.WETH.address, tokenType: 0, tokenSubID: 0 }, value: 500n }
    const encoded = PRIVACY.encodeEventLog(event, [0, 0, [note], [], [1]])
    const receipt = { status: 1, logs: [{ address: CONFIG.proxyContract, ...encoded }] }
    expect(() => assertPrivateOutput(receipt, TOKENS.WETH.address, npk, 499n)).not.toThrow()
    expect(() => assertPrivateOutput(receipt, TOKENS.WETH.address, npk, 501n)).toThrow(/not confirmed/)
    expect(() => assertPrivateOutput(receipt, TOKENS.USDC.address, npk, 1n)).toThrow(/not confirmed/)
    expect(() => assertPrivateOutput(receipt, TOKENS.WETH.address, `0x${'02'.padStart(64, '0')}`, 1n)).toThrow(
      /not confirmed/,
    )
    expect(() => assertPrivateOutput({ status: 1, logs: [] }, TOKENS.WETH.address, npk, 1n)).toThrow(/not confirmed/)
  })
})
