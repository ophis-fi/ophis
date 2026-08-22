import { assertTradeTokenPolicy, TokenPolicyProfile } from '@cowprotocol/tokens'

import { OPHIS_ETHEREUM_OTC_MANIFEST } from 'ophis/otc'
import { decodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from 'viem'

import { buildOtcTransaction } from './buildOtcTransaction'
import { OTC_APPROVE_ABI, OTC_ERC20_WRITE_ABI } from './otcWrite.abi'

import type { OtcTransactionRequest, OtcWriteIntent } from './otcWrite.types'

function reject(reason: string): never {
  throw new Error(`Ophis OTC wallet request rejected: ${reason}`)
}

function selector(data: Hex): Hex {
  return data.slice(0, 10) as Hex
}

function assertReviewedToken(token: Address): void {
  assertTradeTokenPolicy(
    { chainId: OPHIS_ETHEREUM_OTC_MANIFEST.chainId, address: token },
    { chainId: OPHIS_ETHEREUM_OTC_MANIFEST.chainId, address: token },
    TokenPolicyProfile.OTC_ESCROW,
  )
}

function assertApprovalRequest(request: OtcTransactionRequest): void {
  assertReviewedToken(request.to)
  let decoded: ReturnType<typeof decodeFunctionData<typeof OTC_APPROVE_ABI>>
  try {
    decoded = decodeFunctionData({ abi: OTC_APPROVE_ABI, data: request.data })
  } catch {
    return reject('invalid approval calldata')
  }
  if (decoded.functionName !== 'approve') reject('invalid approval function')
  const [spender, amount] = decoded.args
  if (!isAddressEqual(spender, OPHIS_ETHEREUM_OTC_MANIFEST.contract.address)) reject('invalid approval spender')
  const revoke = request.kind === 'revoke-create' || request.kind === 'revoke-fill'
  if (revoke ? amount !== 0n : amount <= 0n) reject('invalid approval amount')
}

function assertCreateTerms(tokenA: Address, amountA: bigint, tokenB: Address, amountB: bigint): void {
  assertReviewedToken(tokenA)
  assertReviewedToken(tokenB)
  if (isAddressEqual(tokenA, tokenB)) reject('token pair must differ')
  if (amountA <= 0n || amountB <= 0n) reject('amount must be positive')
}

function assertContractRequest(request: OtcTransactionRequest): void {
  if (!isAddressEqual(request.to, OPHIS_ETHEREUM_OTC_MANIFEST.contract.address)) reject('invalid contract target')
  if (!OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors.includes(selector(request.data))) {
    reject('selector is not enabled')
  }
  let decoded: ReturnType<typeof decodeFunctionData<typeof OTC_ERC20_WRITE_ABI>>
  try {
    decoded = decodeFunctionData({ abi: OTC_ERC20_WRITE_ABI, data: request.data })
  } catch {
    return reject('invalid contract calldata')
  }
  if (decoded.functionName !== `${request.kind}Order`) reject('intent and selector disagree')
  if (decoded.functionName === 'createOrder') {
    const [tokenA, amountA, tokenB, amountB] = decoded.args
    assertCreateTerms(tokenA, amountA, tokenB, amountB)
  }
  if (decoded.functionName === 'fillOrder' && decoded.args[1] <= 0n) reject('fill deadline must be nonzero')
}

function assertCanonicalIntent(request: OtcTransactionRequest, intent: OtcWriteIntent, nowSeconds: bigint): void {
  const canonical = buildOtcTransaction(intent, nowSeconds)
  if (
    request.kind !== canonical.kind ||
    request.chainId !== canonical.chainId ||
    !isAddressEqual(request.account, canonical.account) ||
    !isAddressEqual(request.to, canonical.to) ||
    request.data.toLowerCase() !== canonical.data.toLowerCase() ||
    request.value !== canonical.value
  ) {
    reject('request differs from reviewed intent')
  }
}

/** Last in-process boundary before either wallet adapter asks a connector to sign. */
export function assertOtcTransactionRequest(
  request: OtcTransactionRequest,
  intent: OtcWriteIntent,
  nowSeconds: bigint,
): void {
  if (request.chainId !== OPHIS_ETHEREUM_OTC_MANIFEST.chainId) reject('wrong chain')
  if (request.value !== 0n) reject('native value is disabled')
  try {
    getAddress(request.account)
    getAddress(request.to)
  } catch {
    return reject('invalid address')
  }

  if (
    request.kind === 'approve-create' ||
    request.kind === 'approve-fill' ||
    request.kind === 'revoke-create' ||
    request.kind === 'revoke-fill'
  ) {
    assertApprovalRequest(request)
  } else {
    assertContractRequest(request)
  }
  assertCanonicalIntent(request, intent, nowSeconds)
}
