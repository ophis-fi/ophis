import { tagAcrossIntegratorCalldata } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, AcrossQuoteResult, BridgeHook, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { CowShedSdk } from '@cowprotocol/sdk-cow-shed'

import { ERC20, GuardedHookTerms, GUARD_MARGIN_BPS, NOT_OWNER, OrdersOf } from './ophisAcrossConstants'
import { rememberHook } from './ophisAcrossPlacedHooks'
import { assertPlaceable } from './ophisAcrossPlacement'
import { signedByOwner } from './ophisAcrossSignature'

/**
 * Upstream's Across deposit program, plus the guard call getSignedHook puts
 * first: the shed transfers the order's minimum output (less
 * GUARD_MARGIN_BPS) to itself, which reverts while the shed is empty. Also
 * keeps what assertPlaceable checks: the owner, the shed and the Across
 * quote's time limits.
 */
export function guardedHookTerms(
  cowShedSdk: CowShedSdk,
  request: QuoteBridgeRequest,
  quote: AcrossQuoteResult,
): GuardedHookTerms {
  const shed = cowShedSdk.getCowShedAccount(request.sellTokenChainId, request.account)
  const minIn = (request.amount * (10_000n - GUARD_MARGIN_BPS)) / 10_000n

  const fees = quote.suggestedFees
  const { sellTokenAddress, account } = request

  return {
    owner: account,
    receiver: request.receiver || account,
    shed,
    guard: { target: sellTokenAddress, callData: ERC20.encodeFunctionData('transfer', [shed, minIn]) },
    minIn,
    pct: BigInt(fees.totalRelayFee.pct),
    quoteTimestamp: BigInt(fees.timestamp),
    fillDeadline: BigInt(fees.fillDeadline),
    exclusivityDeadline: BigInt(fees.exclusivityDeadline),
    exclusiveRelayer: fees.exclusiveRelayer,
  }
}

/**
 * The signed CoW Shed hook: the guard call, then upstream's deposit program,
 * with Across's on-chain integrator tag appended to the factory calldata (see
 * tagAcrossIntegratorCalldata; the SDK reads deposits back from the
 * FundsDeposited event, never from this calldata).
 *
 * The hook is public in the order's appData and anyone may run it. Run early
 * on the empty shed, the deposit would send nothing and burn the nonce, so the
 * settlement's run would fail and leave the order's output in the shed; the
 * guard makes that early run revert whole instead.
 */
export async function getSignedHook(
  cowShedSdk: CowShedSdk,
  dappId: string,
  terms: GuardedHookTerms | undefined,
  ordersOf: OrdersOf | undefined,
  ...args: Parameters<AcrossBridgeProvider['getSignedHook']>
): Promise<BridgeHook> {
  const [chainId, unsignedCall, bridgeHookNonce, deadline, hookGasLimit, signer] = args
  if (!terms) throw new Error('Across bridge call was not built by this provider')

  // The swap flow shows a refusal's message as is.
  const placing = await assertPlaceable(chainId, terms, deadline, signer, ordersOf)

  const calls = [
    {
      target: terms.guard.target,
      value: 0n,
      callData: terms.guard.callData,
      allowFailure: false,
      isDelegateCall: false,
    },
    {
      target: unsignedCall.to,
      value: unsignedCall.value,
      callData: unsignedCall.data,
      allowFailure: false,
      isDelegateCall: true,
    },
  ]
  const { signedMulticall, cowShedAccount, gasLimit } = await cowShedSdk.signCalls({
    calls,
    chainId,
    signer,
    gasLimit: BigInt(hookGasLimit),
    deadline,
    nonce: bridgeHookNonce,
  })
  // The app's signer follows the selected account: switched while placing, it signs for another wallet's shed, or
  // (between the SDK's two reads of it) returns this shed with a signature by another wallet. Either way the hook
  // would not run, and the order's output would stay in the shed.
  if (placing && !areAddressesEqual(cowShedAccount, terms.shed)) throw new Error(NOT_OWNER)
  if (placing && !(await signedByOwner(chainId, terms, calls, bridgeHookNonce, deadline, signedMulticall.data))) {
    throw new Error(NOT_OWNER)
  }
  if (placing) {
    // Public once its order is posted, which may happen without this tab hearing back: remembered now, or the
    // placement stops here.
    const hook = { chainId, nonce: bridgeHookNonce.toLowerCase(), deadline: String(deadline) }
    rememberHook(terms.owner, hook)
  }

  return {
    postHook: {
      target: signedMulticall.to,
      callData: tagAcrossIntegratorCalldata(signedMulticall.data),
      gasLimit: gasLimit.toString(),
      dappId,
    },
    recipient: cowShedAccount,
  }
}
