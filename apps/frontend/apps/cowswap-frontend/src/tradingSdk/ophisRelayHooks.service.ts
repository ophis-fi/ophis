import { getRpcProvider, RELAY_DAPP_ID, RelayHookTerms } from '@cowprotocol/common-const'
import { areAddressesEqual, getGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import { HookBridgeProvider, BridgeQuoteResult, BridgeQuoteResults } from '@cowprotocol/sdk-bridging'
import { CowShedSdk } from '@cowprotocol/sdk-cow-shed'

import { BRIDGE_QUOTE_ACCOUNT } from 'common/constants/bridgeQuoteAccount'

import { ERC20, LEFTOVER_SHARE, NOT_OWNER, OrdersOf, QUOTE_CHANGED, SHED_NOT_EMPTY } from './ophisAcrossConstants'
import { assertNoOpenBridge } from './ophisAcrossOpenBridge'
import { rememberHook } from './ophisAcrossPlacedHooks'
import { takeConfirmedRelay } from './ophisAcrossPlacement'
import { signedByOwner } from './ophisAcrossSignature'

function assertConfirmed(shown: BridgeQuoteResults | undefined, terms: RelayHookTerms): void {
  if (!shown) throw new Error(QUOTE_CHANGED)
  const { request, quote } = terms
  const previous = shown.tradeParameters
  const matching = [
    previous.amount === request.amount,
    previous.sellTokenChainId === request.sellTokenChainId,
    previous.buyTokenChainId === request.buyTokenChainId,
    areAddressesEqual(previous.sellTokenAddress, request.sellTokenAddress),
    areAddressesEqual(previous.buyTokenAddress, request.buyTokenAddress),
    areAddressesEqual(previous.receiver || terms.owner, request.receiver || terms.owner),
    quote.amountsAndCosts.afterSlippage.buyAmount >= shown.amountsAndCosts.afterSlippage.buyAmount,
  ]
  if (matching.includes(false)) throw new Error(QUOTE_CHANGED)
}

async function assertRelayPlaceable(
  chainId: SupportedChainId,
  terms: RelayHookTerms,
  deadline: bigint,
  ordersOf: OrdersOf,
): Promise<void> {
  assertConfirmed(takeConfirmedRelay(terms.owner), terms)
  const provider = getRpcProvider(chainId)
  const now = BigInt((await provider.getBlock('latest')).timestamp)
  if (deadline <= now || deadline > BigInt(terms.quote.depositUntil)) throw new Error(QUOTE_CHANGED)
  await assertNoOpenBridge(chainId, terms, ordersOf, now)
  const balance = BigInt(
    await provider.call({
      to: terms.request.sellTokenAddress,
      data: ERC20.encodeFunctionData('balanceOf', [terms.shed]),
    }),
  )
  if (balance * LEFTOVER_SHARE >= terms.request.amount) throw new Error(SHED_NOT_EMPTY)
}

export async function signRelayHook(
  ordersOf: OrdersOf,
  terms: RelayHookTerms,
  ...[chainId, call, nonce, deadline, gasLimit, signer]: Parameters<
    HookBridgeProvider<BridgeQuoteResult>['getSignedHook']
  >
): ReturnType<HookBridgeProvider<BridgeQuoteResult>['getSignedHook']> {
  const adapter = getGlobalAdapter()
  const signerAddress = await (signer ? adapter.createSigner(signer) : adapter.signer).getAddress()
  const placing = !areAddressesEqual(signerAddress, BRIDGE_QUOTE_ACCOUNT)
  if (placing) {
    if (!areAddressesEqual(signerAddress, terms.owner)) throw new Error(NOT_OWNER)
    await assertRelayPlaceable(chainId, terms, deadline, ordersOf)
  }
  const calls = [{ target: call.to, callData: call.data, value: call.value, allowFailure: false, isDelegateCall: true }]
  const result = await new CowShedSdk(adapter).signCalls({
    calls,
    chainId,
    signer,
    nonce,
    deadline,
    gasLimit: BigInt(gasLimit),
  })
  if (
    placing &&
    (!areAddressesEqual(result.cowShedAccount, terms.shed) ||
      !(await signedByOwner(chainId, terms, calls, nonce, deadline, result.signedMulticall.data)))
  )
    throw new Error(NOT_OWNER)
  if (placing) rememberHook(terms.owner, { chainId, nonce: nonce.toLowerCase(), deadline: String(deadline) })
  return {
    recipient: result.cowShedAccount,
    postHook: {
      target: result.signedMulticall.to,
      callData: result.signedMulticall.data,
      gasLimit: String(result.gasLimit),
      dappId: RELAY_DAPP_ID,
    },
  }
}
