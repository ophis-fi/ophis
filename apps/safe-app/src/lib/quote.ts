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
  appData: string,
  appDataHash: string,
) {
  const api = ophisOrderBook(chainId);
  // Quote WITH the Ophis appData (partner fee + referrer). The partner fee is encoded in
  // appData, so a quote without it prices a NO-fee order: the returned buyAmount/feeAmount would
  // overstate the user's proceeds and the slippage-adjusted limit would be derived from a price
  // the fee path cannot reach (risking an unfillable order). Passing the same appData/appDataHash
  // we later submit keeps the quote and the signed order consistent.
  return api.getQuote({
    from: owner,
    receiver: owner, // pin the receiver to the Safe
    sellToken,
    buyToken,
    sellAmountBeforeFee,
    kind: OrderQuoteSideKindSell.SELL,
    signingScheme: SigningScheme.PRESIGN, // Safe = smart-contract wallet -> presign, never EIP-712
    appData,
    appDataHash,
  } as any);
}
