import { OrderBookApi, OrderQuoteSideKindSell, SigningScheme } from '@cowprotocol/cow-sdk';
import { getOphisOrderbookUrl } from '@ophis/sdk';

// Always point the orderbook at the Ophis host. On OP that is optimism-mainnet.ophis.fi;
// hitting api.cow.fi directly would zero the partner fee.
export function ophisOrderBook(chainId: number): OrderBookApi {
  return new OrderBookApi({ chainId, baseUrls: { [chainId]: getOphisOrderbookUrl(chainId) } } as any);
}

export async function getQuote(
  chainId: number,
  owner: string,
  sellToken: string,
  buyToken: string,
  sellAmountBeforeFee: string,
) {
  const api = ophisOrderBook(chainId);
  return api.getQuote({
    from: owner,
    receiver: owner, // pin the receiver to the Safe
    sellToken,
    buyToken,
    sellAmountBeforeFee,
    kind: OrderQuoteSideKindSell.SELL,
    signingScheme: SigningScheme.PRESIGN, // Safe = smart-contract wallet -> presign, never EIP-712
  } as any);
}
