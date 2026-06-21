import { OrderKind } from '@cowprotocol/cow-sdk';
import { ophisOrderReceiver, assertReceiverIsOwner } from '@ophis/sdk';

export interface QuotedOrder {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string; // the appDataHash (bytes32)
  feeAmount: string;
  kind: OrderKind;
  partiallyFillable: boolean;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
}

// Build the final order from a CoW quote: pin the receiver to the Safe, apply slippage to buyAmount.
export function assembleOrder(
  owner: `0x${string}`,
  quote: any,
  appDataHash: string,
  slippageBps = 50,
): QuotedOrder {
  const q = quote.quote ?? quote;
  const receiver = ophisOrderReceiver(owner) as string;
  assertReceiverIsOwner(owner, receiver as `0x${string}`); // drain guard

  return {
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    receiver,
    sellAmount: q.sellAmount,
    buyAmount: applySlippage(BigInt(q.buyAmount), slippageBps).toString(),
    validTo: q.validTo ?? Math.floor(Date.now() / 1000) + 30 * 60,
    appData: appDataHash,
    feeAmount: q.feeAmount ?? '0',
    kind: OrderKind.SELL,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  };
}

function applySlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}
