import { AbiCoder, getAddress, id, isHexString, keccak256, toUtf8Bytes, verifyTypedData, ZeroAddress } from 'ethers'

export const CREDIT_PROTOCOL = 'ophis.prepaid.v1'
export const CREDIT_REQUEST_LIFETIME = 5 * 60_000
export const CREDIT_MAX_PAYLOAD = 300_000
export interface CreditScope { chainId: number; operator: string; recipient: string; token: string; funding?: 'native' }
export interface CreditAuthorization { owner: string; payload: string; expires: number; signature: string }
export const creditTopics = (chainId: number) => ({ request: `ophis-prepaid-v1-${chainId}`, response: `ophis-prepaid-v1-${chainId}-response` })
export const encryptedCreditTopic = (topic: string) => `/railgun/v2/encrypted-${topic}/json`

export const CREDIT_AUTHORIZATION_TYPES = { CreditRequest: [
  { name: 'owner', type: 'address' }, { name: 'payloadHash', type: 'bytes32' },
  { name: 'expires', type: 'uint64' }, { name: 'feeRecipient', type: 'bytes32' }, { name: 'feeToken', type: 'address' },
] }
export function creditDomain(scope: CreditScope, ledgerId: string) {
  const native = scope.funding === 'native'
  if ((scope.funding !== undefined && !native) || ![1, 56].includes(scope.chainId) || !isHexString(ledgerId, 32) || /^0x0{64}$/i.test(ledgerId) ||
    getAddress(scope.operator) === ZeroAddress || (native
      ? getAddress(scope.token) !== ZeroAddress || getAddress(scope.recipient) !== getAddress(scope.operator)
      : getAddress(scope.token) === ZeroAddress || !scope.recipient.startsWith('0zk1')))
    throw new Error('Invalid prepaid broadcaster identity.')
  return { name: 'Ophis prepaid broadcaster', version: native ? '2-native' : '1', chainId: scope.chainId, verifyingContract: scope.operator, salt: ledgerId }
}

const NATIVE_PAYMENT_TYPES = ['bytes32', 'uint256', 'address', 'bytes32', 'address', 'bytes32']
const NATIVE_PAYMENT_TAG = id('ophis.native-credit.v1')
export function nativeCreditData(scope: CreditScope, ledgerId: string, owner: string, paymentId: string): string {
  creditDomain(scope, ledgerId)
  if (scope.funding !== 'native' || getAddress(owner) === ZeroAddress || !isHexString(paymentId, 32) || /^0x0{64}$/i.test(paymentId))
    throw new Error('Invalid native prepaid payment identity.')
  // The random payment ID stays in the encrypted claim, hiding the derived credit owner on-chain.
  const commitment = keccak256(AbiCoder.defaultAbiCoder().encode(NATIVE_PAYMENT_TYPES,
    [NATIVE_PAYMENT_TAG, scope.chainId, getAddress(scope.operator), ledgerId, getAddress(owner), paymentId]))
  return AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [NATIVE_PAYMENT_TAG, commitment])
}
export function creditAuthorizationValue(scope: CreditScope, owner: string, payload: string, expires: number) {
  if (getAddress(owner) === ZeroAddress || typeof payload !== 'string' || payload.length > CREDIT_MAX_PAYLOAD ||
    !Number.isSafeInteger(expires) || expires < 0) throw new Error('Invalid credit authorization.')
  return { owner: getAddress(owner), payloadHash: keccak256(toUtf8Bytes(payload)), expires,
    feeRecipient: id(scope.recipient), feeToken: getAddress(scope.token) }
}
export function creditRequestKey(ledgerId: string, owner: string, payload: string): string {
  return creditRequestKeyFromPayloadHash(ledgerId, owner, keccak256(toUtf8Bytes(payload)))
}
export function creditRequestKeyFromPayloadHash(ledgerId: string, owner: string, payloadHash: string): string {
  if (!isHexString(payloadHash, 32)) throw new Error('Invalid prepaid request payload hash.')
  return keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address', 'bytes32'],
    [ledgerId, getAddress(owner), payloadHash]))
}
export function authenticateCreditRequest(scope: CreditScope, ledgerId: string, input: unknown, now = Date.now()):
  { owner: string; key: string; payload: Record<string, unknown>; authorization: CreditAuthorization } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Missing credit authorization.')
  const request = input as Record<string, unknown>
  if (typeof request.owner !== 'string' || typeof request.payload !== 'string' || typeof request.signature !== 'string' ||
    !isHexString(request.signature, 65) || typeof request.expires !== 'number' ||
    request.expires <= now || request.expires > now + CREDIT_REQUEST_LIFETIME || !Number.isSafeInteger(request.expires))
    throw new Error('Credit authorization is malformed or expired.')
  const value = creditAuthorizationValue(scope, request.owner, request.payload, request.expires)
  const recovered = verifyTypedData(creditDomain(scope, ledgerId), CREDIT_AUTHORIZATION_TYPES, value, request.signature)
  if (getAddress(recovered) !== value.owner) throw new Error('Invalid credit owner signature.')
  const payload: unknown = JSON.parse(request.payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>).kind !== 'string') throw new Error('Invalid credit request payload.')
  return { owner: value.owner, key: creditRequestKey(ledgerId, value.owner, request.payload), payload: payload as Record<string, unknown>,
    authorization: { owner: value.owner, payload: request.payload, expires: request.expires, signature: request.signature } }
}
export function creditMemo(scope: CreditScope, ledgerId: string, owner: string): string {
  creditDomain(scope, ledgerId)
  if (getAddress(owner) === ZeroAddress) throw new Error('Invalid credit owner.')
  return `${CREDIT_PROTOCOL}:${scope.chainId}:${ledgerId.toLowerCase()}:${getAddress(owner).toLowerCase()}`
}
export function creditRefundMemo(scope: CreditScope, ledgerId: string, refundId: string): string {
  creditDomain(scope, ledgerId)
  if (!isHexString(refundId, 32)) throw new Error('Invalid refund identity.')
  return `${CREDIT_PROTOCOL}:refund:${scope.chainId}:${ledgerId.toLowerCase()}:${refundId.toLowerCase()}`
}
