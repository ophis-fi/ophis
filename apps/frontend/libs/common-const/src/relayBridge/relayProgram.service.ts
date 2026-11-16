import { getGlobalAdapter } from '@cowprotocol/cow-sdk'
import { createWeirollContract, createWeirollDelegateCall, WeirollCommandFlags } from '@cowprotocol/sdk-weiroll'

import { RELAY_DEPOSIT, RELAY_ERC20_ABI, relayDepository } from './relay.constants'
import { RelayHookTerms, RelayProgram } from './relay.types'

export function relayProgram(terms: RelayHookTerms): RelayProgram {
  const { request, quote, shed, owner } = terms
  const adapter = getGlobalAdapter()
  const token = createWeirollContract(
    adapter.getContract(request.sellTokenAddress, RELAY_ERC20_ABI),
    WeirollCommandFlags.CALL,
  )
  const balance = createWeirollContract(
    adapter.getContract(request.sellTokenAddress, RELAY_ERC20_ABI),
    WeirollCommandFlags.STATICCALL,
  )
  const depository = createWeirollContract(
    adapter.getContract(relayDepository(request.sellTokenChainId), RELAY_DEPOSIT.fragments),
    WeirollCommandFlags.CALL,
  )
  const call = createWeirollDelegateCall((planner) => {
    // Exact allowance, zero-first for USDT. A failed deposit reverts the entire hook, including its nonce.
    planner.add(token.approve(depository.address, 0n))
    planner.add(token.approve(depository.address, request.amount))
    planner.add(
      depository.depositErc20(shed, request.sellTokenAddress, request.amount, quote.relay.protocol.v2.orderId),
    )
    // The swap may improve on its guaranteed minimum. Return the excess on the source chain.
    const surplus = planner.add(balance.balanceOf(shed))
    planner.add(token.transfer(owner, surplus))
  })
  return { call, terms }
}
