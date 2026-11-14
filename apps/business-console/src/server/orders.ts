// The real desk (owner decision of 2026-11-14). Non-custodial: Ophis never holds a key or funds. The organisation's own
// linked wallet signs, the order goes to the public Ophis orderbook of its chain, and the receiver is always that wallet.
// This module holds the constants (chains, assets, caps), the appData, the terms an approval binds, the GPv2 order built
// from them, and the calls to the orderbook. It reads no row.
import { concat, getAddress, hashTypedData, keccak256, numberToHex, recoverTypedDataAddress, toBytes, type Hex } from 'viem'
import { readCapped } from './chain.ts'
import { fixed } from './demo.ts'
import { CHAIN_NAME } from './typed.ts'

// The orderbook, settlement and vault relayer of each wallet chain, exactly as @ophis/sdk has them (orderbook.ts,
// domain.ts; tests/fixtures/appdata-golden.json is made by the SDK and the unit suite compares). OP Mainnet is the Ophis
// orderbook with its own settlement; the others are CoW's.
const COW = { settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', relayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' } as const
export const CHAINS: Record<number, { orderbook: string; settlement: Hex; relayer: Hex }> = {
  1: { orderbook: 'https://api.cow.fi/mainnet', ...COW },
  10: { orderbook: 'https://optimism-mainnet.ophis.fi', settlement: '0x310784c7FCE12d578dA6f53460777bAc9718B859', relayer: '0x83847EaB41ad9ea43809ce71569eB2e9daF51830' },
  8453: { orderbook: 'https://api.cow.fi/base', ...COW },
  42161: { orderbook: 'https://api.cow.fi/arbitrum_one', ...COW },
}

// The assets, ERC-20 only (WETH, not native ETH: selling native ETH needs another contract flow). An asset is listed on a
// chain only where two independent sources agree on its address and eth_call symbol() and decimals() on a public RPC
// matched (2026-11-14; ARCHITECTURE.md "The real desk" names each source). stable: in the stable list of @ophis/sdk
// (stablecoins.ts), which decides the price-improvement share of a hosted chain. cap: the most one order sells, in units of
// the asset: about 5,000,000 EUR at the price of a real quote on api.cow.fi/mainnet on 2026-11-14 (1 WETH = 1,750.93 EURC,
// 1 USDC = 0.9076 EURC; the three euro tokens at 1 EUR). No price feed.
const CAP = { WETH: 2_850, USDC: 5_500_000, EURC: 5_000_000, EURe: 5_000_000, EURCV: 5_000_000 }
export type Symbol = keyof typeof CAP
export interface Asset { token: Hex; decimals: number; stable: boolean }
const at = (token: Hex, decimals: number, stable = false): Asset => ({ token, decimals, stable })
export const ASSETS: Record<number, Partial<Record<Symbol, Asset>>> = {
  1: {
    WETH: at('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18), USDC: at('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, true),
    EURC: at('0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', 6), EURe: at('0x39b8B6385416f4cA36a20319F70D28621895279D', 18, true), EURCV: at('0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2', 18),
  },
  10: { WETH: at('0x4200000000000000000000000000000000000006', 18), USDC: at('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6, true) },
  8453: { WETH: at('0x4200000000000000000000000000000000000006', 18), USDC: at('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, true), EURC: at('0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 6, true) },
  42161: { WETH: at('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18), USDC: at('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, true), EURe: at('0x0c06cCF38114ddfc35e07427B9424adcca9F44F8', 18, true) },
}
const assetOf = (chainId: number, symbol: unknown) => (typeof symbol === 'string' && Object.hasOwn(ASSETS[chainId] ?? {}, symbol) ? ASSETS[chainId][symbol as Symbol]! : null)
export const capOf = (symbol: Symbol, decimals: number) => BigInt(CAP[symbol]) * 10n ** BigInt(decimals)

export const VALIDITY = [1800, 14_400, 86_400] // seconds after signing: 30 minutes, 4 hours, 24 hours
export const SLIPPAGE = { default: 50, max: 300 } // bps
export const SIGN_MS = 24 * 60 * 60_000 // approved terms can be signed for 24 hours
export const REVIEW_MS = 5 * 60_000 // a review is sent for approval within 5 minutes, or quoted again
export const MAX_OPEN_ORDERS = 20 // orders that wait for approval, per organisation
export const ORDERS_PER_HOUR = 30 // orders one member files in an hour
export const PREPARERS = ['owner', 'admin', 'trader'] as const
export const SIGNERS = ['owner', 'admin', 'trader', 'approver', 'compliance'] as const // who issues a signing link: a Trader or a key role

// ---- appData and the Ophis fee: exactly what @ophis/sdk buildOphisFullAppData(chainId, slippageBips, undefined,
// 'business', undefined, isStablePair) makes, but for a limit order, whose orderClass is 'limit' (the SDK has market only) ----
const FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'
/** The CIP-75 partner fee: 1 bp of the volume. On a hosted chain also a share of a price better than the quote, capped. */
export const fee = (chainId: number, stable: boolean) => {
  const base = { volumeBps: 1, recipient: FEE_RECIPIENT }
  // OP Mainnet: the Ophis backend applies the price-improvement share itself, so appData carries the base only.
  return chainId === 10 ? base : [base, { priceImprovementBps: stable ? 5000 : 8000, maxVolumeBps: stable ? 20 : 99, recipient: FEE_RECIPIENT }]
}
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v
export function appData(chainId: number, orderClass: 'market' | 'limit', slippageBips: number | null, stable: boolean) {
  const metadata = { orderClass: { orderClass }, partnerFee: fee(chainId, stable), ...(slippageBips !== null && { quote: { slippageBips } }), ophisSource: { app: 'business' } }
  const full = JSON.stringify(sorted({ version: '1.14.0', appCode: 'ophis', metadata }))
  return { full, hash: keccak256(toBytes(full)) }
}

// ---- money: atoms are bigints; a decimal string is parsed by fixed() (demo.ts, 18 decimals, no float) ----
const atomsOf = (text: unknown, decimals: number) => {
  const value = fixed(text, decimals)
  return value === null ? null : value / 10n ** BigInt(18 - decimals)
}
/** Atoms as a plain decimal string, every decimal kept, trailing zeros cut. */
export const decimal = (atoms: string | bigint, decimals: number) => {
  const digits = BigInt(atoms).toString().padStart(decimals + 1, '0')
  const part = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${digits.slice(0, digits.length - decimals)}${part ? `.${part}` : ''}`
}

// ---- the ticket and the terms ----
export interface Ticket { type: 'market' | 'limit'; chainId: number; walletId: string; sell: Symbol; buy: Symbol; amount: string; slippageBips: number | null; limitPrice: string | null; validFor: number }
/** The ticket checks. Returns the refusal, or the ticket with known fields only. Whatever else the caller sent is not read. */
export function ticket(body: Record<string, unknown>): string | Ticket {
  const { type, chainId, walletId, sell, buy, amount } = body
  if (type !== 'market' && type !== 'limit') return 'type_invalid'
  if (typeof chainId !== 'number' || !Object.hasOwn(CHAINS, chainId)) return 'chain_not_allowed'
  const [s, b] = [assetOf(chainId, sell), assetOf(chainId, buy)]
  if (!s || !b) return 'asset_not_permitted'
  if (sell === buy) return 'same_asset'
  if (typeof walletId !== 'string') return 'wallet_not_linked' // whether it is a linked wallet of the organisation is read from the rows
  const atoms = atomsOf(amount, s.decimals)
  if (atoms === null || atoms <= 0n) return 'amount_invalid'
  if (atoms > capOf(sell as Symbol, s.decimals)) return 'over_limit'
  const slippageBips = type === 'market' ? body.slippageBips ?? SLIPPAGE.default : body.slippageBips ?? null
  if (type === 'market' ? !Number.isInteger(slippageBips) || (slippageBips as number) < 0 || (slippageBips as number) > SLIPPAGE.max : slippageBips !== null) return 'slippage_invalid'
  const limitPrice = body.limitPrice ?? null
  const price = type === 'limit' ? fixed(limitPrice, 18) : null
  if (type === 'limit' ? price === null || price <= 0n : limitPrice !== null) return 'limit_price_invalid'
  const validFor = body.validFor ?? VALIDITY[0]
  if (!VALIDITY.includes(validFor as number)) return 'validity_invalid'
  return { type, chainId, walletId, sell: sell as Symbol, buy: buy as Symbol, amount: decimal(atoms, s.decimals), slippageBips: slippageBips as number | null, limitPrice: limitPrice as string | null, validFor: validFor as number }
}

export type Scheme = 'eip712' | 'presign'
export interface Wallet { id: string; label: string; address: string; kind: string }
/** What an approval binds, complete: its value is this, and payload_hash covers it. The receiver is the wallet. */
export interface Terms {
  type: 'market' | 'limit'; chainId: number; walletId: string; wallet: string; label: string; scheme: Scheme
  sell: { symbol: Symbol; token: Hex; amount: string }; buy: { symbol: Symbol; token: Hex; minimum: string }
  quoted: string; slippageBips: number | null; limitPrice: string | null; validFor: number
  appData: string; appDataHash: Hex; fee: ReturnType<typeof fee>
}
/**
 * The terms of a ticket, from the quote's buy amount. Market: the quote, less the Ophis volume fee and the slippage the
 * member picked (as @ophis/cli does: the fee is taken from what is bought). Limit: the amount at the member's limit price
 * (units of the asset bought per unit sold), within 20% of the quote on both sides.
 */
export function terms(t: Ticket, wallet: Wallet, quoted: bigint): string | Terms {
  const [s, b] = [ASSETS[t.chainId][t.sell]!, ASSETS[t.chainId][t.buy]!]
  const atoms = atomsOf(t.amount, s.decimals)!
  const minimum = t.type === 'market'
    ? (((quoted * 9_999n) / 10_000n) * BigInt(10_000 - t.slippageBips!)) / 10_000n
    : (atoms * fixed(t.limitPrice, 18)! * 10n ** BigInt(b.decimals)) / (10n ** BigInt(s.decimals) * 10n ** 18n)
  if (t.type === 'limit' && (minimum * 5n < quoted * 4n || minimum * 5n > quoted * 6n)) return 'limit_out_of_band'
  if (minimum <= 0n) return 'amount_too_small'
  const stable = s.stable && b.stable
  const data = appData(t.chainId, t.type, t.slippageBips, stable)
  return {
    type: t.type, chainId: t.chainId, walletId: wallet.id, wallet: getAddress(wallet.address), label: wallet.label, scheme: wallet.kind === 'safe' ? 'presign' : 'eip712',
    sell: { symbol: t.sell, token: s.token, amount: atoms.toString() }, buy: { symbol: t.buy, token: b.token, minimum: minimum.toString() },
    quoted: quoted.toString(), slippageBips: t.slippageBips, limitPrice: t.limitPrice, validFor: t.validFor, appData: data.full, appDataHash: data.hash, fee: fee(t.chainId, stable),
  }
}
/** Stored terms made again by this server from their own inputs, or the refusal. judge() compares the text. */
export function again(value: string | null): string | Terms {
  let t: Terms
  try {
    t = JSON.parse(value ?? 'null')
  } catch {
    return 'invalid'
  }
  if (!t || typeof t !== 'object' || !t.sell || !t.buy || typeof t.quoted !== 'string' || !/^[1-9]\d{0,77}$/.test(t.quoted)) return 'invalid'
  const s = assetOf(t.chainId, t.sell.symbol)
  const asked = ticket({ type: t.type, chainId: t.chainId, walletId: t.walletId, sell: t.sell.symbol, buy: t.buy.symbol, amount: s && /^\d{1,78}$/.test(t.sell.amount) ? decimal(t.sell.amount, s.decimals) : null, slippageBips: t.slippageBips, limitPrice: t.limitPrice, validFor: t.validFor })
  return typeof asked === 'string' ? asked : terms(asked, { id: t.walletId, label: t.label, address: t.wallet, kind: t.scheme === 'presign' ? 'safe' : 'key' }, BigInt(t.quoted))
}

// ---- the GPv2 order and its cancellation, as the settlement contract hashes them ----
const DOMAIN_FIELDS = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]
export const ORDER_TYPES = {
  Order: [
    { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' }, { name: 'sellAmount', type: 'uint256' },
    { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' }, { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' },
    { name: 'kind', type: 'string' }, { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
  ],
} as const
const CANCEL_TYPES = { OrderCancellations: [{ name: 'orderUids', type: 'bytes[]' }] } as const
export const domainOf = (chainId: number) => ({ name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: CHAINS[chainId].settlement })
/** The order of approved terms, with the expiry fixed when the signing page read it. typed: as a wallet signs it (eth_signTypedData_v4). */
export function gpv2(t: Terms, validTo: number) {
  const domain = domainOf(t.chainId)
  const message = {
    sellToken: t.sell.token, buyToken: t.buy.token, receiver: t.wallet as Hex, sellAmount: t.sell.amount, buyAmount: t.buy.minimum, validTo,
    appData: t.appDataHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  }
  const hashed = { domain, types: ORDER_TYPES, primaryType: 'Order' as const, message: { ...message, sellAmount: BigInt(message.sellAmount), buyAmount: BigInt(message.buyAmount), feeAmount: 0n } }
  // The order id: the EIP-712 digest, the owner, the expiry.
  const uid = concat([hashTypedData(hashed), t.wallet as Hex, numberToHex(validTo, { size: 4 })]).toLowerCase()
  return { message, uid, hashed, typed: { domain, types: { EIP712Domain: DOMAIN_FIELDS, ...ORDER_TYPES }, primaryType: 'Order', message } }
}
/** The off-chain cancellation of one order (the orderbook's DELETE /api/v1/orders), as the wallet signs it. */
export const cancellation = (chainId: number, uid: string) => {
  const domain = domainOf(chainId)
  const message = { orderUids: [uid as Hex] }
  return { hashed: { domain, types: CANCEL_TYPES, primaryType: 'OrderCancellations' as const, message }, typed: { domain, types: { EIP712Domain: DOMAIN_FIELDS, ...CANCEL_TYPES }, primaryType: 'OrderCancellations', message } }
}
/** Did the wallet's own key sign this? A signature of 65 bytes only; anything else is no. */
export async function signedBy(hashed: object, signature: unknown, wallet: string) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false
  const by = await recoverTypedDataAddress({ ...hashed, signature } as never).catch(() => null)
  return by !== null && by.toLowerCase() === wallet.toLowerCase()
}

// ---- the orderbook: one call each, 5 seconds, 64 KB ----
/** Tests lower these. */
export const ORDERBOOK = { timeoutMs: 5000, maxBytes: 64 * 1024 }
type Settings = { ENVIRONMENT: string; ORDERBOOK_URL?: string }
/** The orderbook of a chain. Locally only, ORDERBOOK_URL names a stand-in on this machine (plain http to it): any other value is not read. */
// The local rule of indexerBase() in partner.ts, written here: partner.ts imports data.ts, which imports this module.
export function orderbook(env: Settings, chainId: number) {
  let url: URL | null = null
  try {
    url = new URL(env.ORDERBOOK_URL ?? '')
  } catch {
    // not set, or not an address: the real orderbook
  }
  const here = env.ENVIRONMENT === 'local' && url?.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && !url.username && !url.password && !url.search && !url.hash
  return here ? `${url!.origin}${url!.pathname.replace(/\/+$/, '')}/${chainId}` : CHAINS[chainId].orderbook
}
async function ask(env: Settings, chainId: number, path: string, init: RequestInit = {}) {
  try {
    const response = await fetch(`${orderbook(env, chainId)}${path}`, { ...init, headers: { 'content-type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(ORDERBOOK.timeoutMs) })
    const text = await readCapped(response.body, ORDERBOOK.maxBytes)
    return text === null ? { status: 0, body: null } : { status: response.status, body: JSON.parse(text) as unknown } // too large: no answer
  } catch {
    return { status: 0, body: null }
  }
}
const errorType = (body: unknown) => {
  const type = (body as { errorType?: unknown } | null)?.errorType
  return typeof type === 'string' && /^[A-Za-z]{1,40}$/.test(type) ? type : null
}
const digits = (v: unknown) => typeof v === 'string' && /^\d{1,78}$/.test(v)

/** A live quote for a ticket, from the wallet, with the exact appData the order will sign. The buy amount, or the refusal. */
export async function quote(env: Settings, t: Ticket, wallet: Wallet) {
  const [s, b] = [ASSETS[t.chainId][t.sell]!, ASSETS[t.chainId][t.buy]!]
  const atoms = atomsOf(t.amount, s.decimals)!
  const data = appData(t.chainId, t.type, t.slippageBips, s.stable && b.stable)
  const from = getAddress(wallet.address)
  const answer = await ask(env, t.chainId, '/api/v1/quote', {
    method: 'POST',
    body: JSON.stringify({
      sellToken: s.token, buyToken: b.token, from, receiver: from, kind: 'sell', sellAmountBeforeFee: atoms.toString(), partiallyFillable: false,
      sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', priceQuality: 'optimal', signingScheme: wallet.kind === 'safe' ? 'presign' : 'eip712', onchainOrder: false,
      appData: data.full, appDataHash: data.hash, validFor: t.validFor,
    }),
  })
  if (answer.status === 0 || answer.status === 429 || answer.status >= 500) return { error: 'quote_unavailable' }
  const q = (answer.body as { quote?: Record<string, unknown> } | null)?.quote
  if (answer.status !== 200 || !q) return { error: 'quote_refused', reason: errorType(answer.body) }
  // The quote must be for exactly what was asked: the two tokens, and the whole amount (what it sells plus its fee).
  const same = (a: unknown, token: string) => typeof a === 'string' && a.toLowerCase() === token.toLowerCase()
  if (!same(q.sellToken, s.token) || !same(q.buyToken, b.token) || !digits(q.sellAmount) || !digits(q.feeAmount) || !digits(q.buyAmount)) return { error: 'quote_unavailable' }
  if (BigInt(q.sellAmount as string) + BigInt(q.feeAmount as string) !== atoms) return { error: 'quote_unavailable' }
  return { quoted: BigInt(q.buyAmount as string) }
}
/** POST /api/v1/orders with the order the server built, as @ophis/cli sends it. DuplicatedOrder: that very order is there already. */
export async function post(env: Settings, t: Terms, built: ReturnType<typeof gpv2>, signature: string) {
  const m = built.message
  const answer = await ask(env, t.chainId, '/api/v1/orders', {
    method: 'POST',
    body: JSON.stringify({
      sellToken: m.sellToken, buyToken: m.buyToken, receiver: m.receiver, sellAmount: m.sellAmount, buyAmount: m.buyAmount, validTo: m.validTo, feeAmount: m.feeAmount, kind: m.kind,
      partiallyFillable: m.partiallyFillable, sellTokenBalance: m.sellTokenBalance, buyTokenBalance: m.buyTokenBalance, appData: t.appData, appDataHash: t.appDataHash,
      signingScheme: t.scheme, signature, from: t.wallet,
    }),
  })
  if (answer.status === 201 || answer.status === 200) return answer.body === built.uid ? 'ok' : 'orderbook_unavailable'
  if (errorType(answer.body) === 'DuplicatedOrder') return 'ok'
  return answer.status === 0 || answer.status === 429 || answer.status >= 500 ? 'orderbook_unavailable' : 'order_refused'
}
/** DELETE /api/v1/orders: the off-chain cancellation a key wallet signed. */
export async function cancel(env: Settings, chainId: number, uid: string, signature: string) {
  const answer = await ask(env, chainId, '/api/v1/orders', { method: 'DELETE', body: JSON.stringify({ orderUids: [uid], signature, signingScheme: 'eip712' }) })
  return answer.status === 200 ? 'ok' : answer.status === 0 || answer.status === 429 || answer.status >= 500 ? 'orderbook_unavailable' : 'order_refused'
}
const STATUS = ['presignaturePending', 'open', 'fulfilled', 'cancelled', 'expired']
/** The orderbook's state of a sent order, and the transaction of its trade once it is filled. Null: no usable answer. */
export async function status(env: Settings, chainId: number, uid: string) {
  const order = await ask(env, chainId, `/api/v1/orders/${uid}`)
  const o = order.body as Record<string, unknown> | null
  if (order.status !== 200 || !o || !STATUS.includes(o.status as string) || !digits(o.executedSellAmount) || !digits(o.executedBuyAmount)) return null
  let tx: string | null = null
  if (o.status === 'fulfilled') {
    const trades = await ask(env, chainId, `/api/v1/trades?orderUid=${uid}`)
    const hash = Array.isArray(trades.body) ? (trades.body[0] as { txHash?: unknown } | undefined)?.txHash : null
    tx = typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash) ? hash : null
  }
  return { status: o.status as string, sold: o.executedSellAmount as string, bought: o.executedBuyAmount as string, tx }
}

// ---- words ----
/** What the blotter says of an order: its approval row and its order row. */
export function stateOf(o: { state: string; open: boolean; approvedAt: number | null; uid: string | null; status: string | null; validTo: number | null }, now: number) {
  if (o.state === 'pending') return o.open ? 'Pending approval' : 'Expired'
  if (o.state === 'rejected' || o.status === 'refused') return 'Refused'
  if (o.state !== 'applied') return 'Cancelled'
  if (!o.uid) return (o.approvedAt ?? 0) + SIGN_MS > now ? 'Approved: waiting for signature' : 'Expired'
  if (o.status === 'presignaturePending') return 'Approved: waiting for signature'
  if (o.status === 'fulfilled') return 'Filled'
  if (o.status === 'cancelled') return 'Cancelled'
  return o.status === 'expired' || (o.validTo ?? 0) * 1000 <= now ? 'Expired' : 'Open'
}
const VALID_WORDS: Record<number, string> = { 1800: '30 minutes', 14_400: '4 hours', 86_400: '24 hours' }
/** The terms in words, as the signing page and the Approvals card show them. */
export function words(t: Terms, validTo: number | null) {
  const [s, b] = [ASSETS[t.chainId][t.sell.symbol], ASSETS[t.chainId][t.buy.symbol]]
  return {
    sell: `${decimal(t.sell.amount, s?.decimals ?? 18)} ${t.sell.symbol}`,
    buy: `at least ${decimal(t.buy.minimum, b?.decimals ?? 18)} ${t.buy.symbol}`,
    type: t.type === 'market' ? `Market, slippage ${t.slippageBips! / 100}%` : `Limit, at ${t.limitPrice} ${t.buy.symbol} per ${t.sell.symbol}`,
    chain: CHAIN_NAME[t.chainId] ?? `Chain ${t.chainId}`,
    wallet: `${t.label} (${t.wallet})`,
    valid: validTo ? `Until ${new Date(validTo * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : `${VALID_WORDS[t.validFor]} after signing`,
    fee: '0.01% of the volume, plus a share of any price better than the quote',
  }
}
