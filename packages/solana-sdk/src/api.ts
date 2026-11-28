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
  executionMode?: 'walletAtomic';
  /** Minimum received in the exact-input wallet preview uses this tolerance. */
  slippageBps?: number;
  walletCreatesBuyTokenAccount?: boolean;
  side: { kind: 'sell'; sellAmountBeforeFee: bigint } | { kind: 'buy'; buyAmountAfterFee: bigint };
  validFor?: number;
  priceQuality?: 'fast' | 'optimal' | 'verified';
}

export interface NativeProtocolFee {
  /** Value in SOL of the full quoted buy amount, expressed as a ratio of atomic units. */
  rateLamports: string;
  rateBuyAtoms: string;
  estimatedLamports: string;
  maxLamports: string;
}

export interface OphisSolanaQuote {
  executionMode?: 'walletAtomic';
  /** Retains the user's original choice between native SOL and an existing wSOL balance. */
  sellFromNativeSol?: boolean;
  solver?: Address;
  routeProgram?: Address;
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
    nativeProtocolFee?: NativeProtocolFee;
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

const isSol = (mint: Address) => mint === NATIVE_SOL || mint === WSOL;

function feeTier(sell: Address, buy: Address) {
  const stableSell = mainnetStables.has(sell);
  const stableBuy = mainnetStables.has(buy);
  const stablePair = stableSell && stableBuy;
  const lowBase = stablePair || (stableSell && isSol(buy)) || (stableBuy && isSol(sell));
  return { baseBps: lowBase ? 1 : 5, improvementCapBps: stablePair ? 20 : 99 };
}

/** Bound before a native SOL sell quote exists. The executable quote rounds first in buy atoms. */
export function getOphisNativeSellFeeCap(sellLamports: bigint, buyMint: Address): bigint {
  atoms(sellLamports.toString());
  const tier = feeTier(NATIVE_SOL, buyMint);
  const base = BigInt(tier.baseBps);
  return (
    (sellLamports * (10000n * base + (10000n - base) * BigInt(tier.improvementCapBps))) / 100000000n
  );
}

export function readNativeProtocolFee(value: unknown): NativeProtocolFee {
  const fee = record(value);
  return {
    rateLamports: atoms(fee.rateLamports, true),
    rateBuyAtoms: atoms(fee.rateBuyAtoms, true),
    estimatedLamports: atoms(fee.estimatedLamports),
    maxLamports: atoms(fee.maxLamports),
  };
}

export function checkedQuoteAppData(
  program: Address,
  quote: OphisSolanaQuote['quote'],
): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(quote.appData)) throw Error('Invalid quote app data');
  const bytes = new Uint8Array(getBase16Encoder().encode(quote.appData.slice(2)));
  if (program !== OPHIS_MAINNET_PROGRAM && !quote.nativeProtocolFee) return bytes;

  // Bytes 24–31 are an order nonce. The settlement program selects the fee tier from the two mints.
  const view = new DataView(bytes.buffer);
  const maxCost =
    BigInt(atoms(quote.costs.networkFees)) + BigInt(atoms(quote.costs.buyTokenAtaCosts));
  const tier = feeTier(quote.sellToken, quote.buyToken);
  const terms = quote.feeTerms;
  const nativeFee = quote.nativeProtocolFee;
  const gross = BigInt(atoms(quote.buyAmount, true));
  if (nativeFee) {
    const checked = readNativeProtocolFee(nativeFee);
    const sol = BigInt(checked.rateLamports);
    const base = (gross * BigInt(tier.baseBps)) / 10000n;
    const improvementCap = ((gross - base) * BigInt(tier.improvementCapBps)) / 10000n;
    if (
      checked.rateBuyAtoms !== quote.buyAmount ||
      (isSol(quote.buyToken) && sol !== gross) ||
      (isSol(quote.sellToken) && checked.rateLamports !== quote.sellAmount) ||
      BigInt(checked.estimatedLamports) !== (base * sol) / gross ||
      BigInt(checked.maxLamports) !== ((base + improvementCap) * sol) / gross ||
      maxCost !== 0n ||
      quote.feeAmount !== '0' ||
      quote.costs.protocolFee !== '0' ||
      quote.costs.total !== '0'
    )
      throw Error('Invalid quoted Solana protocol fee.');
  }
  if (
    new TextDecoder().decode(bytes.subarray(0, 8)) !== (nativeFee ? 'OPHISPI5' : 'OPHISPI3') ||
    quote.kind !== 'sell' ||
    quote.partiallyFillable ||
    quote.costs.token !== quote.buyToken ||
    view.getBigUint64(8, true) !== gross ||
    view.getBigUint64(16, true) !== (nativeFee ? BigInt(nativeFee.maxLamports) : maxCost) ||
    terms?.baseBps !== tier.baseBps ||
    terms.improvementShareBps !== 5000 ||
    terms.improvementCapBps !== tier.improvementCapBps
  )
    throw Error('Request a new quote with matching actual-output fee terms');
  return bytes;
}

export interface OphisSolanaOrder {
  creationDate?: string;
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

export function checkSlippageBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 5000)
    throw Error('Slippage must be an integer from 0 to 5000 bps');
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
  if (input.slippageBps !== undefined) {
    if (input.executionMode !== 'walletAtomic' || input.side.kind !== 'sell')
      throw Error('A quote slippage limit requires an exact-input wallet swap');
    checkSlippageBps(input.slippageBps);
  }
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
      ...(input.executionMode && { executionMode: input.executionMode }),
      ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
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
  if (
    value.executionMode !== input.executionMode &&
    (input.executionMode || value.executionMode === 'walletAtomic')
  )
    throw Error('The quote did not match the requested Solana execution mode');
  const solver = input.executionMode ? key(value.solver) : undefined;
  if (
    solver &&
    (solver === from ||
      !value.verified ||
      value.id == null ||
      value.funder != null ||
      input.side.kind !== 'sell' ||
      (input.receiver && input.receiver !== from) ||
      quote.feeAmount !== '0' ||
      costs.networkFees !== '0' ||
      costs.buyTokenAtaCosts !== '0' ||
      costs.total !== costs.protocolFee)
  )
    throw Error('Unexpected wallet-paid swap costs or signer');
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
  const result: OphisSolanaQuote = {
    ...(solver && {
      executionMode: input.executionMode,
      solver,
      routeProgram: key(value.routeProgram),
      sellFromNativeSol: input.sellToken === NATIVE_SOL,
    }),
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
      ...(solver && { nativeProtocolFee: readNativeProtocolFee(quote.nativeProtocolFee) }),
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
  if (solver) checkedQuoteAppData(OPHIS_MAINNET_PROGRAM, result.quote);
  return result;
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
    ...(typeof value.creationDate === 'string' && Number.isFinite(Date.parse(value.creationDate))
      ? { creationDate: value.creationDate }
      : {}),
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
  if (value.walletAtomic !== undefined && typeof value.walletAtomic !== 'boolean')
    throw Error('Invalid Solana execution capability');
  return {
    ...(value.walletAtomic === true ? { walletAtomic: true as const } : {}),
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
