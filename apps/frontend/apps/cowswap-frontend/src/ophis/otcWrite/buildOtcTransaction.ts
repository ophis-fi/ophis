import { assertTradeTokenPolicy, TokenPolicyProfile } from '@cowprotocol/tokens'

import { OPHIS_ETHEREUM_OTC_MANIFEST } from 'ophis/otc'
import { encodeFunctionData, getAddress, isAddressEqual, type Address, type Hex } from 'viem'

import { OTC_APPROVE_ABI, OTC_ERC20_WRITE_ABI } from './otcWrite.abi'

import type {
  OtcApproveCreateIntent,
  OtcApproveFillIntent,
  OtcCancelIntent,
  OtcCreateDraft,
  OtcCreateIntent,
  OtcFillIntent,
  OtcRevokeCreateIntent,
  OtcRevokeFillIntent,
  OtcTransactionRequest,
  OtcWriteIntent,
} from './otcWrite.types'
import type { OtcOrder } from 'ophis/otc'

export const OTC_FILL_DEADLINE_WINDOW_SECONDS = 180n
export const OTC_MAX_FILL_DEADLINE_SECONDS = 300n
export const OTC_APPROVE_SELECTOR = '0x095ea7b3'
const UINT256_MAX = 2n ** 256n - 1n

function fail(reason: string): never {
  throw new Error(`Ophis OTC write rejected: ${reason}`)
}

function requireAccount(account: Address): Address {
  try {
    return getAddress(account)
  } catch {
    return fail('invalid account')
  }
}

function assertAmount(value: bigint): void {
  if (value <= 0n) fail('amount must be positive')
  if (value > UINT256_MAX) fail('amount exceeds uint256')
}

function assertEscrowPolicy(tokenA: Address, tokenB: Address): void {
  assertTradeTokenPolicy(
    { chainId: OPHIS_ETHEREUM_OTC_MANIFEST.chainId, address: tokenA },
    { chainId: OPHIS_ETHEREUM_OTC_MANIFEST.chainId, address: tokenB },
    TokenPolicyProfile.OTC_ESCROW,
  )
}

function assertDraft(draft: OtcCreateDraft): void {
  assertAmount(draft.amountA)
  assertAmount(draft.amountB)
  if (isAddressEqual(draft.tokenA, draft.tokenB)) fail('token pair must differ')
  assertEscrowPolicy(draft.tokenA, draft.tokenB)
}

function assertOrderTerms(order: OtcOrder): void {
  assertAmount(order.amountA)
  assertAmount(order.amountB)
  if (isAddressEqual(order.tokenA, order.tokenB)) fail('token pair must differ')
  assertEscrowPolicy(order.tokenA, order.tokenB)
}

function assertOrder(order: OtcOrder): void {
  assertOrderTerms(order)
  if (!order.active) fail('order is inactive')
}

function selector(data: Hex): Hex {
  return data.slice(0, 10) as Hex
}

function contractRequest(kind: OtcWriteIntent['kind'], account: Address, data: Hex): OtcTransactionRequest {
  const callSelector = selector(data)
  if (!OPHIS_ETHEREUM_OTC_MANIFEST.enabledTransactionSelectors.includes(callSelector)) {
    return fail('selector is not enabled')
  }
  return {
    kind,
    chainId: OPHIS_ETHEREUM_OTC_MANIFEST.chainId,
    account: requireAccount(account),
    to: OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
    data,
    value: 0n,
  }
}

function approvalRequest(
  kind: 'approve-create' | 'approve-fill' | 'revoke-create' | 'revoke-fill',
  account: Address,
  token: Address,
  amount: bigint,
): OtcTransactionRequest {
  const data = encodeFunctionData({
    abi: OTC_APPROVE_ABI,
    functionName: 'approve',
    args: [OPHIS_ETHEREUM_OTC_MANIFEST.contract.address, amount],
  })
  if (selector(data) !== OTC_APPROVE_SELECTOR) return fail('approval selector mismatch')
  return {
    kind,
    chainId: OPHIS_ETHEREUM_OTC_MANIFEST.chainId,
    account: requireAccount(account),
    to: token,
    data,
    value: 0n,
  }
}

/** Write sink 1/5: exact approval for the maker's escrow leg. */
export function buildOtcCreateApproval(intent: OtcApproveCreateIntent): OtcTransactionRequest {
  assertDraft(intent.draft)
  assertAmount(intent.draft.amountA)
  return approvalRequest(intent.kind, intent.account, intent.draft.tokenA, intent.draft.amountA)
}

/** Write sink 2/5: create an allowlisted ERC-20 order. */
export function buildOtcCreateTransaction(intent: OtcCreateIntent): OtcTransactionRequest {
  assertDraft(intent.draft)
  return contractRequest(
    intent.kind,
    intent.account,
    encodeFunctionData({
      abi: OTC_ERC20_WRITE_ABI,
      functionName: 'createOrder',
      args: [intent.draft.tokenA, intent.draft.amountA, intent.draft.tokenB, intent.draft.amountB],
    }),
  )
}

/** Write sink 3/5: exact approval for the taker's payment leg. */
export function buildOtcFillApproval(intent: OtcApproveFillIntent): OtcTransactionRequest {
  assertOrder(intent.order)
  assertAmount(intent.order.amountB)
  return approvalRequest(intent.kind, intent.account, intent.order.tokenB, intent.order.amountB)
}

/** Recovery sink 1/2: clear a maker allowance left after failed creation. */
export function buildOtcRevokeCreateApproval(intent: OtcRevokeCreateIntent): OtcTransactionRequest {
  // Clearing an allowance must work even when the create form has no valid amounts.
  if (isAddressEqual(intent.draft.tokenA, intent.draft.tokenB)) fail('token pair must differ')
  assertEscrowPolicy(intent.draft.tokenA, intent.draft.tokenB)
  return approvalRequest(intent.kind, intent.account, intent.draft.tokenA, 0n)
}

/** Recovery sink 2/2: clear a taker allowance after a failed or raced fill. */
export function buildOtcRevokeFillApproval(intent: OtcRevokeFillIntent): OtcTransactionRequest {
  // Revocation must remain possible after another transaction made the order
  // inactive. Validate immutable terms and both token legs, but not activity.
  assertOrderTerms(intent.order)
  return approvalRequest(intent.kind, intent.account, intent.order.tokenB, 0n)
}

/** Write sink 4/5: all-or-nothing fill with a short, nonzero deadline. */
export function buildOtcFillTransaction(intent: OtcFillIntent, nowSeconds: bigint): OtcTransactionRequest {
  assertOrder(intent.order)
  if (intent.deadline <= nowSeconds) fail('fill deadline must be in the future')
  if (intent.deadline > nowSeconds + OTC_MAX_FILL_DEADLINE_SECONDS) fail('fill deadline is too long')
  return contractRequest(
    intent.kind,
    intent.account,
    encodeFunctionData({
      abi: OTC_ERC20_WRITE_ABI,
      functionName: 'fillOrder',
      args: [intent.order.orderId, intent.deadline],
    }),
  )
}

/** Write sink 5/5: maker-only cancellation after policy and active-state checks. */
export function buildOtcCancelTransaction(intent: OtcCancelIntent): OtcTransactionRequest {
  assertOrder(intent.order)
  if (!isAddressEqual(intent.account, intent.order.maker)) fail('only the maker may cancel')
  return contractRequest(
    intent.kind,
    intent.account,
    encodeFunctionData({ abi: OTC_ERC20_WRITE_ABI, functionName: 'cancelOrder', args: [intent.order.orderId] }),
  )
}

export function buildOtcTransaction(intent: OtcWriteIntent, nowSeconds: bigint): OtcTransactionRequest {
  switch (intent.kind) {
    case 'approve-create':
      return buildOtcCreateApproval(intent)
    case 'create':
      return buildOtcCreateTransaction(intent)
    case 'approve-fill':
      return buildOtcFillApproval(intent)
    case 'revoke-create':
      return buildOtcRevokeCreateApproval(intent)
    case 'revoke-fill':
      return buildOtcRevokeFillApproval(intent)
    case 'fill':
      return buildOtcFillTransaction(intent, nowSeconds)
    case 'cancel':
      return buildOtcCancelTransaction(intent)
  }
}
