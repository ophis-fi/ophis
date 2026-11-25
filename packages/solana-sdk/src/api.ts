import { address, blockhash, getBase16Encoder, type Address } from '@solana/kit';
import type { OphisSolanaChainContext } from './transaction.js';
import {
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  type SolanaTokenProgram,
} from './tokens.js';
import { SOLANA_NATIVE_ASSET as NATIVE_SOL, WRAPPED_SOL_MINT as WSOL } from './tokens.js';

export interface OphisSolanaQuoteRequest {
  from: Address;
  sellToken: Address;
  buyToken: Address;
  receiver?: Address;
  walletCreatesBuyTokenAccount?: boolean;
  side: { kind: 'sell'; sellAmountBeforeFee: bigint } | { kind: 'buy'; buyAmountAfterFee: bigint };
  validFor?: number;
  priceQuality?: 'fast' | 'optimal' | 'verified';
}

export interface OphisSolanaQuote {
  from: Address;
  quote: {
    sellToken: Address;
    buyToken: Address;
    receiver: Address | null;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    validTo: number;
    appData: string;
    feeTerms?: { baseBps: number; improvementShareBps: number; improvementCapBps: number };
    kind: 'sell' | 'buy';
    costs: {
      token: Address;
      networkFees: string;
      buyTokenAtaCosts: string;
      protocolFee: string;
      total: string;
    };
    partiallyFillable: boolean;
  };
  expiration: string;
  id: number | null;
  verified: boolean;
  funder: Address | null;
}

export const OPHIS_MAINNET_PROGRAM = address('BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h');
const mainnetStables = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
]);

export function checkedQuoteAppData(
  program: Address,
  quote: OphisSolanaQuote['quote'],
): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(quote.appData)) throw Error('Invalid quote app data');
  const bytes = new Uint8Array(getBase16Encoder().encode(quote.appData.slice(2)));
  if (program !== OPHIS_MAINNET_PROGRAM) return bytes;

  const view = new DataView(bytes.buffer);
  const maxCost =
    BigInt(atoms(quote.costs.networkFees)) + BigInt(atoms(quote.costs.buyTokenAtaCosts));
  const stableSell = mainnetStables.has(quote.sellToken),
    stableBuy = mainnetStables.has(quote.buyToken);
  const isSol = (mint: Address) => mint === NATIVE_SOL || mint === WSOL;
  const lowBase =
    (stableSell && stableBuy) ||
    (stableSell && isSol(quote.buyToken)) ||
    (stableBuy && isSol(quote.sellToken));
  const terms = quote.feeTerms;
  if (
    new TextDecoder().decode(bytes.subarray(0, 8)) !== 'OPHISPI3' ||
    quote.kind !== 'sell' ||
    quote.partiallyFillable ||
    quote.costs.token !== quote.buyToken ||
    view.getBigUint64(8, true) !== BigInt(atoms(quote.buyAmount, true)) ||
    view.getBigUint64(16, true) !== maxCost ||
    terms?.baseBps !== (lowBase ? 1 : 5) ||
    terms.improvementShareBps !== 5000 ||
    terms.improvementCapBps !== (stableSell && stableBuy ? 20 : 99)
  )
    throw Error('Request a new quote with matching actual-output fee terms');
  return bytes;
}

export interface OphisSolanaOrder {
  uid: string;
  owner: Address;
  sellToken: Address;
  buyToken: Address;
  orderPda: Address;
  sellAmount: string;
  buyAmount: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  status: 'open' | 'fulfilled' | 'cancelled' | 'expired';
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid native API response');
  return value as Record<string, unknown>;
}

export function atoms(value: unknown, positive = false): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 20 ||
    BigInt(value) > 0xffff_ffff_ffff_ffffn ||
    (positive && BigInt(value) === 0n)
  )
    throw Error('Invalid u64 token amount');
  return value;
}

export function key(value: unknown): Address {
  if (typeof value !== 'string') throw Error('Invalid Solana address');
  return address(value);
}

export function uid(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value))
    throw Error('Invalid native order UID');
  return value;
}

export class OphisSolanaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorType?: string,
  ) {
    super(`Ophis native API returned HTTP ${status}`);
  }
}

export async function request(baseUrl: string, path: string, body?: unknown): Promise<unknown> {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error('Supply a public Ophis orderbook base URL');
  base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(path === 'api/v1/quote' ? 25_000 : 10_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const kind = typeof detail?.errorType === 'string' ? detail.errorType : undefined;
    throw new OphisSolanaHttpError(response.status, kind);
  }
  return response.json();
}

/** One explicit request; no retries, refresh loop or fallback host. Token amounts remain exact strings. */
export async function fetchOphisSolanaQuote(
  baseUrl: string,
  input: OphisSolanaQuoteRequest,
): Promise<OphisSolanaQuote> {
  if (
    !['sell', 'buy'].includes(input.side.kind) ||
    (input.validFor !== undefined &&
      (!Number.isInteger(input.validFor) || input.validFor <= 0 || input.validFor > 0xffff_ffff)) ||
    (input.priceQuality !== undefined &&
      !['fast', 'optimal', 'verified'].includes(input.priceQuality))
  )
    throw Error('Invalid native quote request');
  const amount =
    input.side.kind === 'sell' ? input.side.sellAmountBeforeFee : input.side.buyAmountAfterFee;
  if (typeof amount !== 'bigint') throw Error('Specify bigint token atoms');
  atoms(amount.toString(), true);
  const from = key(input.from),
    sellToken = key(input.sellToken) === NATIVE_SOL ? WSOL : key(input.sellToken),
    buyToken = key(input.buyToken);
  const side =
    input.side.kind === 'sell'
      ? { kind: 'sell', sellAmountBeforeFee: amount.toString() }
      : { kind: 'buy', buyAmountAfterFee: amount.toString() };
  const value = record(
    await request(baseUrl, 'api/v1/quote', {
      from,
      sellToken,
      ...(input.sellToken === NATIVE_SOL ? { sellFromNativeSol: true } : {}),
      buyToken,
      ...(input.walletCreatesBuyTokenAccount === true
        ? { walletCreatesBuyTokenAccount: true }
        : {}),
      ...side,
      ...(input.receiver === undefined ? {} : { receiver: key(input.receiver) }),
      validFor: input.validFor ?? 1800,
      priceQuality: input.priceQuality ?? 'verified',
    }),
  );
  const quote = record(value.quote);
  const costs = record(quote.costs);
  const sellAmount = atoms(quote.sellAmount, true);
  const buyAmount = atoms(quote.buyAmount, true);
  const feeAmount = atoms(quote.feeAmount);
  const quotedAmount =
    input.side.kind === 'sell' ? BigInt(sellAmount) + BigInt(feeAmount) : BigInt(buyAmount);
  if (quotedAmount !== amount)
    throw Error(`Quote ${input.side.kind} amount does not match the requested trade`);
  if (key(costs.token) !== (input.side.kind === 'sell' ? buyToken : sellToken))
    throw Error('Invalid quote cost token');
  if (
    key(value.from) !== from ||
    key(quote.sellToken) !== sellToken ||
    key(quote.buyToken) !== buyToken ||
    quote.kind !== input.side.kind ||
    quote.receiver !== (input.receiver ?? null)
  )
    throw Error('Quote does not match the requested trade');
  if (
    typeof value.verified !== 'boolean' ||
    quote.partiallyFillable !== false ||
    typeof value.expiration !== 'string' ||
    !Number.isFinite(Date.parse(value.expiration)) ||
    typeof quote.validTo !== 'number' ||
    !Number.isInteger(quote.validTo) ||
    quote.validTo <= 0 ||
    quote.validTo > 0xffff_ffff ||
    quote.validTo > Math.floor(Date.now() / 1000) + (input.validFor ?? 1800) + 60 ||
    typeof quote.appData !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(quote.appData) ||
    (value.id !== null && (!Number.isSafeInteger(value.id) || Number(value.id) < 0))
  )
    throw Error('Invalid native quote metadata');
  let feeTerms: OphisSolanaQuote['quote']['feeTerms'];
  if (quote.feeTerms !== undefined) {
    const terms = record(quote.feeTerms);
    if (
      !value.verified ||
      value.id === null ||
      /^0x0{64}$/.test(quote.appData) ||
      (terms.baseBps !== 1 && terms.baseBps !== 5) ||
      terms.improvementShareBps !== 5000 ||
      (terms.improvementCapBps !== 20 && terms.improvementCapBps !== 99) ||
      (terms.improvementCapBps === 20 && terms.baseBps !== 1)
    )
      throw Error('Invalid Ophis fee terms');
    feeTerms = {
      baseBps: terms.baseBps,
      improvementShareBps: terms.improvementShareBps,
      improvementCapBps: terms.improvementCapBps,
    };
  }
  return {
    from,
    quote: {
      sellToken,
      buyToken,
      receiver: quote.receiver === null ? null : key(quote.receiver),
      sellAmount,
      buyAmount,
      feeAmount,
      validTo: quote.validTo,
      appData: quote.appData,
      ...(feeTerms && { feeTerms }),
      kind: input.side.kind,
      costs: {
        token: key(costs.token),
        networkFees: atoms(costs.networkFees),
        buyTokenAtaCosts: atoms(costs.buyTokenAtaCosts),
        protocolFee: atoms(costs.protocolFee),
        total: atoms(costs.total),
      },
      partiallyFillable: quote.partiallyFillable,
    },
    expiration: value.expiration,
    id: value.id as number | null,
    verified: value.verified,
    funder: value.funder === null ? null : key(value.funder),
  };
}

export async function fetchOphisSolanaOrder(
  baseUrl: string,
  orderUid: string,
): Promise<OphisSolanaOrder> {
  uid(orderUid);
  const value = record(await request(baseUrl, `api/v1/orders/${orderUid}`));
  if (
    uid(value.uid) !== orderUid ||
    !['open', 'fulfilled', 'cancelled', 'expired'].includes(String(value.status))
  )
    throw Error('Invalid native order status');
  return {
    uid: orderUid,
    owner: key(value.owner),
    sellToken: key(value.sellToken),
    buyToken: key(value.buyToken),
    orderPda: key(value.orderPda),
    sellAmount: atoms(value.sellAmount, true),
    buyAmount: atoms(value.buyAmount, true),
    executedSellAmount: atoms(value.executedSellAmount),
    executedBuyAmount: atoms(value.executedBuyAmount),
    status: value.status as OphisSolanaOrder['status'],
  };
}

export interface OphisSolanaMintMetadata {
  address: Address;
  tokenProgram: SolanaTokenProgram;
  decimals: number;
  extensions: readonly string[];
}

export async function fetchOphisSolanaChainContext(
  baseUrl: string,
): Promise<OphisSolanaChainContext> {
  const value = record(await request(baseUrl, 'api/v1/solana/context'));
  return {
    programAddress: key(value.programAddress),
    genesisHash: key(value.genesisHash),
    blockhash: blockhash(key(value.blockhash)),
    lastValidBlockHeight: BigInt(atoms(value.lastValidBlockHeight)),
    contextSlot: BigInt(atoms(value.contextSlot)),
  };
}

export async function fetchOphisSolanaMint(
  baseUrl: string,
  mint: Address,
): Promise<OphisSolanaMintMetadata> {
  key(mint);
  const value = record(await request(baseUrl, `api/v1/solana/mints/${mint}`));
  const program = key(value.tokenProgram);
  if (
    key(value.address) !== mint ||
    (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022_PROGRAM_ADDRESS) ||
    !Number.isInteger(value.decimals) ||
    Number(value.decimals) < 0 ||
    Number(value.decimals) > 255 ||
    !Array.isArray(value.extensions) ||
    value.extensions.some((extension) => typeof extension !== 'string')
  )
    throw Error('Invalid SPL mint metadata');
  return {
    address: mint,
    tokenProgram: program as SolanaTokenProgram,
    decimals: value.decimals as number,
    extensions: value.extensions as string[],
  };
}
