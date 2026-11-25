import { atoms, fetchOphisSolanaQuote, key } from './api.js';
import { SOLANA_NATIVE_ASSET } from './tokens.js';

export { fetchOphisSolanaOrder, key as solanaAddress } from './api.js';
export { fetchOphisSolanaTrades } from './trades.js';

export async function fetchOphisSolanaSellQuote(
  baseUrl: string,
  owner: string,
  sell: string,
  buy: string,
  sellAtoms: string,
) {
  const quote = await fetchOphisSolanaQuote(baseUrl, {
    from: key(owner),
    walletCreatesBuyTokenAccount: true,
    sellToken: sell === 'SOL' ? SOLANA_NATIVE_ASSET : key(sell),
    buyToken: buy === 'SOL' ? SOLANA_NATIVE_ASSET : key(buy),
    side: { kind: 'sell', sellAmountBeforeFee: BigInt(atoms(sellAtoms, true)) },
  });
  if (!quote.verified)
    throw Error('Ophis could not verify an executable quote for this wallet and amount.');
  if (BigInt(quote.quote.sellAmount) + BigInt(quote.quote.feeAmount) !== BigInt(sellAtoms))
    throw Error('Verified quote does not match the requested sell amount');
  return quote;
}
