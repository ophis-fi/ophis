import { describe, expect, it } from 'vitest'
import { id, Wallet } from 'ethers'
import { authenticateCreditRequest, creditAuthorizationValue, creditDomain, creditMemo, creditRequestKey,
  CREDIT_AUTHORIZATION_TYPES, type CreditAuthorization } from '../../railgun/credit-protocol'

const owner = Wallet.createRandom(), operator = Wallet.createRandom().address
const scope = { chainId: 1, operator, recipient: '0zk1fee-identity', token: Wallet.createRandom().address }
const ledgerId = id('ledger'), now = 1_800_000_000_000
async function authorize(payload = JSON.stringify({ kind: 'execute', maximumCharge: '100', request: { data: '0x1234' } }), expires = now + 60_000): Promise<CreditAuthorization> {
  return { owner: owner.address, payload, expires, signature: await owner.signTypedData(creditDomain(scope, ledgerId),
    CREDIT_AUTHORIZATION_TYPES, creditAuthorizationValue(scope, owner.address, payload, expires)) }
}
describe('prepaid request ownership', () => {
  it('binds every request byte, charge, fee identity, token, ledger, operator and chain', async () => {
    const request = await authorize()
    expect(authenticateCreditRequest(scope, ledgerId, request, now).owner).toBe(owner.address)
    for (const changed of [{ chainId: 56 }, { operator: Wallet.createRandom().address }, { recipient: '0zk1another-recipient' }, { token: operator }])
      expect(() => authenticateCreditRequest({ ...scope, ...changed }, ledgerId, request, now)).toThrow('signature')
    expect(() => authenticateCreditRequest(scope, id('another ledger'), request, now)).toThrow('signature')
    for (const changed of [{ owner: operator }, { payload: request.payload.replace('100', '101') },
      { payload: request.payload.replace('1234', '1235') }, { expires: request.expires + 1 }])
      expect(() => authenticateCreditRequest(scope, ledgerId, { ...request, ...changed }, now)).toThrow('signature')
  })
  it('uses an idempotent operation key across refreshed authentication without changing consent', async () => {
    const first = await authorize(), second = await authorize(first.payload, first.expires + 1_000)
    expect(authenticateCreditRequest(scope, ledgerId, first, now).key).toBe(authenticateCreditRequest(scope, ledgerId, second, now).key)
    expect(creditRequestKey(ledgerId, operator, first.payload)).not.toBe(creditRequestKey(ledgerId, owner.address, first.payload))
  })
  it('rejects expired, overlong, malformed or unauthenticated requests', async () => {
    const request = await authorize()
    for (const expires of [now, now + 300_001, NaN, now + 0.1])
      expect(() => authenticateCreditRequest(scope, ledgerId, { ...request, expires }, now)).toThrow()
    for (const input of [null, [], {}, { ...request, signature: '0x' }, { ...request, payload: 'x'.repeat(300_001) }])
      expect(() => authenticateCreditRequest(scope, ledgerId, input, now)).toThrow()
    expect(() => authenticateCreditRequest(scope, ledgerId, request, request.expires)).toThrow('expired')
    const array = await authorize('[]')
    expect(() => authenticateCreditRequest(scope, ledgerId, array, now)).toThrow('payload')
  })
  it('binds top-up ownership to one ledger and chain and is independent of swapping account rotation', () => {
    const memo = creditMemo(scope, ledgerId, owner.address)
    expect(memo).toBe(creditMemo(scope, ledgerId, owner.address.toLowerCase()))
    expect(memo).not.toBe(creditMemo({ ...scope, chainId: 56 }, ledgerId, owner.address))
    expect(memo).not.toBe(creditMemo(scope, id('other ledger'), owner.address))
    expect(memo).not.toBe(creditMemo(scope, ledgerId, operator))
  })
})
