// The real desk (owner decision of 2026-11-14). Non-custodial: Ophis never holds a key or funds. The organisation's own
// linked wallet signs, the order goes to the public Ophis orderbook of its chain, and the receiver is always that wallet.
// This module holds the constants (chains, assets, caps), the appData, the terms an approval binds, the GPv2 order built
// from them, and the calls to the orderbook. It reads no row.
import { concat, encodeFunctionData, getAddress, hashTypedData, keccak256, numberToHex, parseAbi, recoverTypedDataAddress, toBytes, type Hex } from 'viem'
import { NATIVE, readCapped } from './chain.ts'
import { fixed } from './demo.ts'
import { CHAIN_NAME } from './typed.ts'

// The orderbook, settlement and vault relayer of each wallet chain, exactly as @ophis/sdk has them (orderbook.ts,
// domain.ts; tests/fixtures/appdata-golden.json is made by the SDK and the unit suite compares). OP Mainnet, Robinhood Chain
// and Arc (owner, 2026-11-19) are Ophis orderbooks with their own settlement; the others are CoW's.
const COW = { settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', relayer: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' } as const
export const CHAINS: Record<number, { orderbook: string; settlement: Hex; relayer: Hex }> = {
  1: { orderbook: 'https://api.cow.fi/mainnet', ...COW },
  10: { orderbook: 'https://optimism-mainnet.ophis.fi', settlement: '0x310784c7FCE12d578dA6f53460777bAc9718B859', relayer: '0x83847EaB41ad9ea43809ce71569eB2e9daF51830' },
  8453: { orderbook: 'https://api.cow.fi/base', ...COW },
  42161: { orderbook: 'https://api.cow.fi/arbitrum_one', ...COW },
  4663: { orderbook: 'https://robinhood-mainnet.ophis.fi', settlement: '0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD', relayer: '0xB52C38097c19cd38238c62DD36027a7918eFa890' },
  5042: { orderbook: 'https://arc-mainnet.ophis.fi', settlement: '0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A', relayer: '0x895505F1FE6D762296685fF4a8201782FFdCB8E9' },
}

// ETH itself (owner, 2026-11-19: people trade ETH, not WETH). Bought: the settlement pays it out of WETH, to the marker
// address NATIVE. Sold: the wallet sends it to the chain's EthFlow contract in one transaction, which places a GPv2 order
// selling WETH, owned by that contract (EIP-1271), with the expiry of the order in its own data and the largest uint32 in
// the order. Each contract below is @ophis/sdk's (CoW's on the hosted chains), and its cowSwapSettlement() and
// wrappedNativeToken() are the settlement above and the WETH below (eth_call, 2026-11-19). Arc has no ETH of its own: its
// gas is USDC, and its WETH is bridged.
export const ETHFLOW: Record<number, Hex> = {
  1: '0xbA3cB449bD2B4ADddBc894D8697F5170800EAdeC', 8453: '0xbA3cB449bD2B4ADddBc894D8697F5170800EAdeC', 42161: '0xbA3cB449bD2B4ADddBc894D8697F5170800EAdeC',
  10: '0x764fE4aa1FF493cf39931c7923C8ff5837596504', 4663: '0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29',
}
const MAX_VALID_TO = 0xffff_ffff

// The assets. An asset is listed on a
// chain only where two independent sources agree on its address and eth_call symbol() and decimals() on a public RPC
// matched (2026-11-14; ARCHITECTURE.md "The real desk" names each source). stable: in the stable list of @ophis/sdk
// (stablecoins.ts), which decides the price-improvement share of a hosted chain. cap: the most one order sells, in units of
// the asset: about 5,000,000 EUR at the price of a real quote on api.cow.fi/mainnet on 2026-11-14 (1 WETH = 1,750.93 EURC,
// 1 USDC = 0.9076 EURC; the three euro tokens at 1 EUR). No price feed. ETH first: the ticket opens on it.
const CAP = { ETH: 2_850, WETH: 2_850, USDC: 5_500_000, USDG: 5_500_000, EURC: 5_000_000, EURe: 5_000_000, EURCV: 5_000_000 }
export type Symbol = keyof typeof CAP
export interface Asset { token: Hex; decimals: number; stable: boolean }
const at = (token: Hex, decimals: number, stable = false): Asset => ({ token, decimals, stable })
const ETH = at(NATIVE, 18)
export const ASSETS: Record<number, Partial<Record<Symbol, Asset>>> = {
  1: {
    ETH, USDC: at('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, true), EURC: at('0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', 6),
    EURe: at('0x39b8B6385416f4cA36a20319F70D28621895279D', 18, true), EURCV: at('0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2', 18), WETH: at('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18),
  },
  10: { ETH, USDC: at('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6, true), WETH: at('0x4200000000000000000000000000000000000006', 18) },
  8453: { ETH, USDC: at('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, true), EURC: at('0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 6, true), WETH: at('0x4200000000000000000000000000000000000006', 18) },
  42161: { ETH, USDC: at('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, true), EURe: at('0x0c06cCF38114ddfc35e07427B9424adcca9F44F8', 18, true), WETH: at('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18) },
  // 2026-11-19: Robinhood Chain has WETH (bridged from Ethereum, and the WETH its EthFlow wraps into) and USDG, its one
  // stablecoin (Robinhood's contract docs and DefiLlama; USDG is also in the SDK's stable list); Arc has Circle's USDC and
  // EURC (Circle's address pages and Arc's docs) and a bridged WETH (Arc's docs and DefiLlama). symbol() and decimals()
  // matched on both endpoints of each chain.
  4663: { ETH, USDG: at('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6, true), WETH: at('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 18) },
  5042: { WETH: at('0x128cC466B61f542da60c70e3aA11c10e19B84EDB', 18), USDC: at('0x3600000000000000000000000000000000000000', 6, true), EURC: at('0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', 6, true) },
}
const assetOf = (chainId: number, symbol: unknown) => (typeof symbol === 'string' && Object.hasOwn(ASSETS[chainId] ?? {}, symbol) ? ASSETS[chainId][symbol as Symbol]! : null)
export const capOf = (symbol: Symbol, decimals: number) => BigInt(CAP[symbol]) * 10n ** BigInt(decimals)
/** The token an order really moves: WETH for ETH, which the settlement wraps (a sale) or unwraps (a purchase). */
export const wrapped = (chainId: number, token: string) => (token === NATIVE ? ASSETS[chainId].WETH!.token : (token as Hex))
/** Does this order sell ETH itself, through the chain's EthFlow contract? */
export const sellsEth = (t: { sell: { token: string } }) => t.sell.token === NATIVE

export const VALIDITY = [1800, 14_400, 86_400] // seconds after signing: 30 minutes, 4 hours, 24 hours
export const SLIPPAGE = { default: 50, max: 300 } // bps
// The least amount of a market order rests on the live quote of its review: so it is approved within 1 hour of being sent
// for approval, and signed within 1 hour of the approval. A limit order rests on the member's own price: 24 hours to sign.
export const APPROVE_MS = 60 * 60_000
export const SIGN_MS = { market: 60 * 60_000, limit: 24 * 60 * 60_000 }
export const MIN_VALID_MS = 60_000 // the orderbook refuses an order valid less than 1 minute more (InsufficientValidTo, read-only quotes of 2026-11-14)
/** Until when approved terms can be signed: their window from the approval, and, once the signing page fixed the expiry, while the orderbook still takes the order. */
export const signBy = (o: { type: Ticket['type']; approvedAt: number | null; validTo: number | null }) => Math.min((o.approvedAt ?? 0) + SIGN_MS[o.type], o.validTo === null ? Infinity : o.validTo * 1000 - MIN_VALID_MS)
export const REVIEW_MS = 5 * 60_000 // a review is sent for approval within 5 minutes, or quoted again
export const MAX_OPEN_ORDERS = 20 // orders that wait for approval, per organisation
export const ORDERS_PER_HOUR = 30 // orders one member files in an hour
export const PREPARERS = ['owner', 'admin', 'trader'] as const
export const SIGNERS = ['owner', 'admin', 'trader', 'approver', 'compliance'] as const // who issues a signing link: a Trader or a key role

// ---- appData and the Ophis fee: exactly what @ophis/sdk buildOphisFullAppData(chainId, slippageBips, undefined,
// 'business', undefined, isStablePair) makes, but for a limit order, whose orderClass is 'limit' (the SDK has market only) ----
const FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'
const OPHIS_CHAINS = new Set([10, 4663, 5042])
/** The CIP-75 partner fee: 1 bp of the volume. On a hosted chain also a share of a price better than the quote, capped. */
export const fee = (chainId: number, stable: boolean) => {
  const base = { volumeBps: 1, recipient: FEE_RECIPIENT }
  // The Ophis chains (OP Mainnet, Robinhood Chain, Arc): the Ophis backend applies the price-improvement share itself, so
  // appData carries the base only, as the SDK's SOVEREIGN_CHAIN_IDS.
  return OPHIS_CHAINS.has(chainId) ? base : [base, { priceImprovementBps: stable ? 5000 : 8000, maxVolumeBps: stable ? 20 : 99, recipient: FEE_RECIPIENT }]
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
  if (wrapped(chainId, s.token) === wrapped(chainId, b.token)) return 'same_asset' // ETH for WETH is a wrap, which the orderbook refuses
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
  const asked = askedOf(t)
  return typeof asked === 'string' ? asked : terms(asked, walletOf(t), BigInt(t.quoted))
}
/** The ticket that stored terms answer, checked again: the refusal, or the ticket. */
export function askedOf(t: Terms) {
  const s = assetOf(t.chainId, t.sell.symbol)
  return ticket({ type: t.type, chainId: t.chainId, walletId: t.walletId, sell: t.sell.symbol, buy: t.buy.symbol, amount: s && /^\d{1,78}$/.test(t.sell.amount) ? decimal(t.sell.amount, s.decimals) : null, slippageBips: t.slippageBips, limitPrice: t.limitPrice, validFor: t.validFor })
}
export const walletOf = (t: Terms): Wallet => ({ id: t.walletId, label: t.label, address: t.wallet, kind: t.scheme === 'presign' ? 'safe' : 'key' })

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
/**
 * The order of approved terms, with the expiry fixed when the signing page read it. typed: as a wallet signs it
 * (eth_signTypedData_v4). An ETH sale is the order its EthFlow contract places and owns: WETH sold, the largest expiry.
 */
export function gpv2(t: Terms, validTo: number) {
  const domain = domainOf(t.chainId)
  const eth = sellsEth(t)
  const message = {
    sellToken: wrapped(t.chainId, t.sell.token), buyToken: t.buy.token, receiver: t.wallet as Hex, sellAmount: t.sell.amount, buyAmount: t.buy.minimum, validTo: eth ? MAX_VALID_TO : validTo,
    appData: t.appDataHash, feeAmount: '0', kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  }
  const hashed = { domain, types: ORDER_TYPES, primaryType: 'Order' as const, message: { ...message, sellAmount: BigInt(message.sellAmount), buyAmount: BigInt(message.buyAmount), feeAmount: 0n } }
  // The order id: the EIP-712 digest, the owner, the expiry.
  const uid = concat([hashTypedData(hashed), eth ? ETHFLOW[t.chainId] : (t.wallet as Hex), numberToHex(message.validTo, { size: 4 })]).toLowerCase()
  return { message, uid, hashed, typed: { domain, types: { EIP712Domain: DOMAIN_FIELDS, ...ORDER_TYPES }, primaryType: 'Order', message } }
}
const ETHFLOW_ABI = parseAbi([
  'struct Data { address buyToken; address receiver; uint256 sellAmount; uint256 buyAmount; bytes32 appData; uint256 feeAmount; uint32 validTo; bool partiallyFillable; int64 quoteId; }',
  'function createOrder(Data order) payable returns (bytes32)', 'function invalidateOrder(Data order)',
])
/**
 * The one transaction of an ETH sale, as @ophis/sdk's getEthFlowTransaction builds it: the wallet sends the amount sold to
 * the EthFlow contract, which places the order (createOrder), or takes it back with the ETH (invalidateOrder, any time;
 * after the expiry the refunder does it). quoteId: a fresh quote's, which spares the orderbook a quote of its own.
 */
export function ethflowCall(t: Terms, validTo: number, call: 'createOrder' | 'invalidateOrder', quoteId = 0) {
  const data = { buyToken: t.buy.token, receiver: t.wallet as Hex, sellAmount: BigInt(t.sell.amount), buyAmount: BigInt(t.buy.minimum), appData: t.appDataHash, feeAmount: 0n, validTo, partiallyFillable: false, quoteId: BigInt(quoteId) }
  return { to: ETHFLOW[t.chainId], value: call === 'createOrder' ? t.sell.amount : '0', data: encodeFunctionData({ abi: ETHFLOW_ABI, functionName: call, args: [data] }) }
}
/** The off-chain cancellation of one order (the orderbook's DELETE /api/v1/orders), as the wallet signs it. */
export const cancellation = (chainId: number, uid: string) => {
  const domain = domainOf(chainId)
  const message = { orderUids: [uid as Hex] }
  return { hashed: { domain, types: CANCEL_TYPES, primaryType: 'OrderCancellations' as const, message }, typed: { domain, types: { EIP712Domain: DOMAIN_FIELDS, ...CANCEL_TYPES }, primaryType: 'OrderCancellations', message } }
}
/** Did the wallet's own key sign this? Anything that is no signature of it is no (viem throws on it). */
export async function signedBy(hashed: object, signature: unknown, wallet: string) {
  const by = await recoverTypedDataAddress({ ...hashed, signature } as never).catch(() => null)
  return by !== null && by.toLowerCase() === wallet.toLowerCase()
}

// ---- the orderbook: one call each, 5 seconds, 64 KB ----
/** Tests lower these. */
export const ORDERBOOK = { timeoutMs: 5000, maxBytes: 64 * 1024 }
type Settings = { ENVIRONMENT: string; ORDERBOOK_URL?: string }
/** A local stand-in's base address: only in `local`, only plain http to this machine. Any other value is not read (null). */
// The local rule of indexerBase() in partner.ts, written here: partner.ts imports data.ts, which imports this module.
export function standIn(env: { ENVIRONMENT: string }, value: string | undefined) {
  let url: URL | null = null
  try {
    url = new URL(value ?? '')
  } catch {
    // not set, or not an address: the real one
  }
  const here = env.ENVIRONMENT === 'local' && url?.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && !url.username && !url.password && !url.search && !url.hash
  return here ? `${url!.origin}${url!.pathname.replace(/\/+$/, '')}` : null
}
/** The orderbook of a chain. Locally only, ORDERBOOK_URL names a stand-in on this machine. */
export function orderbook(env: Settings, chainId: number) {
  const here = standIn(env, env.ORDERBOOK_URL)
  return here ? `${here}/${chainId}` : CHAINS[chainId].orderbook
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

/**
 * A live quote for a ticket, from the wallet, with the exact appData the order will sign. The buy amount and the quote's
 * id, or the refusal. An ETH sale is quoted as @ophis/sdk quotes it: WETH sold, an onchain EIP-1271 order whose
 * verification the orderbook does not charge.
 */
export async function quote(env: Settings, t: Ticket, wallet: Wallet) {
  const [s, b] = [ASSETS[t.chainId][t.sell]!, ASSETS[t.chainId][t.buy]!]
  const atoms = atomsOf(t.amount, s.decimals)!
  const data = appData(t.chainId, t.type, t.slippageBips, s.stable && b.stable)
  const from = getAddress(wallet.address)
  const sold = wrapped(t.chainId, s.token)
  const scheme = s.token === NATIVE ? { signingScheme: 'eip1271', onchainOrder: true, verificationGasLimit: 0 } : { signingScheme: wallet.kind === 'safe' ? 'presign' : 'eip712', onchainOrder: false }
  const answer = await ask(env, t.chainId, '/api/v1/quote', {
    method: 'POST',
    body: JSON.stringify({
      sellToken: sold, buyToken: b.token, from, receiver: from, kind: 'sell', sellAmountBeforeFee: atoms.toString(), partiallyFillable: false,
      sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', priceQuality: 'optimal', ...scheme,
      // The Ophis orderbook of OP Mainnet refuses a key wallet's quote valid more than 3 hours (ExcessiveValidTo, read-only
      // quotes of 2026-11-14). A quote's validity changes neither its price nor its appData, and the order's own expiry is
      // fixed when the signing page first opens: so the quote asks for 3 hours at most, and the terms keep the validity picked.
      appData: data.full, appDataHash: data.hash, validFor: Math.min(t.validFor, 10_800),
    }),
  })
  if (answer.status === 0 || answer.status === 429 || answer.status >= 500) return { error: 'quote_unavailable' }
  const body = answer.body as { quote?: Record<string, unknown>; id?: unknown } | null
  const q = body?.quote
  if (answer.status !== 200 || !q) return { error: 'quote_refused', reason: errorType(answer.body) }
  // The quote must be for exactly what was asked: the two tokens, and the whole amount (what it sells plus its fee).
  const same = (a: unknown, token: string) => typeof a === 'string' && a.toLowerCase() === token.toLowerCase()
  if (!same(q.sellToken, sold) || !same(q.buyToken, b.token) || !digits(q.sellAmount) || !digits(q.feeAmount) || !digits(q.buyAmount)) return { error: 'quote_unavailable' }
  if (BigInt(q.sellAmount as string) + BigInt(q.feeAmount as string) !== atoms) return { error: 'quote_unavailable' }
  // The id, an int64 of the orderbook: 0 (none) if it is not one, so that the orderbook quotes the order itself.
  const id = Number.isSafeInteger(body!.id) && (body!.id as number) > 0 ? (body!.id as number) : 0
  return { quoted: BigInt(q.buyAmount as string), id }
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
/**
 * PUT /api/v1/app_data/{hash}: the full appData of an ETH sale, whose transaction commits only its hash. Without it the
 * orderbook applies no partner fee (the Ophis fee is lost): @ophis/sdk ethflow.ts uploads it first too. 201 new, 200 there.
 */
export async function appDataUp(env: Settings, t: Terms) {
  const answer = await ask(env, t.chainId, `/api/v1/app_data/${t.appDataHash}`, { method: 'PUT', body: JSON.stringify({ fullAppData: t.appData }) })
  return answer.status === 200 || answer.status === 201
}
/** DELETE /api/v1/orders: the off-chain cancellation a key wallet signed. */
export async function cancel(env: Settings, chainId: number, uid: string, signature: string) {
  const answer = await ask(env, chainId, '/api/v1/orders', { method: 'DELETE', body: JSON.stringify({ orderUids: [uid], signature, signingScheme: 'eip712' }) })
  return answer.status === 200 ? 'ok' : answer.status === 0 || answer.status === 429 || answer.status >= 500 ? 'orderbook_unavailable' : 'order_refused'
}
const STATUS = ['presignaturePending', 'open', 'fulfilled', 'cancelled', 'expired']
/**
 * The orderbook's state of a sent order, and the transaction of its trade once it is filled. Null: no usable answer.
 * fee: executedFee (the network fee and the protocol fees, the Ophis fee among them), kept only in the asset sold.
 */
export async function status(env: Settings, chainId: number, uid: string, sellToken: string) {
  const order = await ask(env, chainId, `/api/v1/orders/${uid}`)
  const o = order.body as Record<string, unknown> | null
  if (order.status === 404) return 'missing' as const // the orderbook does not have this order id
  if (order.status !== 200 || !o || !STATUS.includes(o.status as string) || !digits(o.executedSellAmount) || !digits(o.executedBuyAmount)) return null
  let tx: string | null = null
  if (o.status === 'fulfilled') {
    const trades = await ask(env, chainId, `/api/v1/trades?orderUid=${uid}`)
    const hash = Array.isArray(trades.body) ? (trades.body[0] as { txHash?: unknown } | undefined)?.txHash : null
    tx = typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash) ? hash : null
  }
  const fee = digits(o.executedFee) && typeof o.executedFeeToken === 'string' && o.executedFeeToken.toLowerCase() === wrapped(chainId, sellToken).toLowerCase() ? (o.executedFee as string) : null
  return { status: o.status as string, sold: o.executedSellAmount as string, bought: o.executedBuyAmount as string, tx, fee }
}

// ---- routes: what an asset sells for on its chain, and how far the price moves with the size ----
/** The sizes read, as parts of the most one order sells: a thousandth (the reference, about 5,000 EUR), then a hundredth, a tenth and all of it. */
const DEPTH = [1000n, 100n, 10n, 1n]
const DEEP_BPS = 50 // the price moves at most 0.5%
const NOBODY = '0x000000000000000000000000000000000000dEaD' // a route names no wallet: the quote is from no one's
const ROUTES_MS = 5 * 60_000
// ponytail: a cache of this isolate, 5 minutes, shared by every organisation (the answer names no wallet), at most one
// entry per chain and asset (about 20). A miss costs at most 16 quotes (4 routes of 4 sizes), under the 50 calls a free
// Worker may make. An answer with a route the orderbook did not answer for is not kept. The Cache API if isolates multiply.
export const ROUTES = new Map<string, { at: number; value: Awaited<ReturnType<typeof readRoutes>> }>()
/**
 * Each asset the ticket's asset sells for on its chain, with how far the price moves at each size from the reference
 * (bps; null: no quote at that size), and a score: deep (at most 0.5% at the most per order), medium (at a tenth of it),
 * thin (more), none (the orderbook has no route), unavailable (it did not answer at some size). ETH and WETH are one route,
 * read as WETH. One route at a time, its 4 quotes at once: a Worker waits on 6 connections at most, and each quote's 5
 * seconds start at its fetch.
 */
export async function routes(env: Settings, chainId: number, sell: Symbol, now: number) {
  const key = `${chainId} ${sell}`
  const seen = ROUTES.get(key)
  if (seen && now - seen.at < ROUTES_MS) return seen.value
  const value = await readRoutes(env, chainId, sell)
  if (!value.routes.some((r) => r.score === 'unavailable')) ROUTES.set(key, { at: now, value })
  return value
}
async function readRoutes(env: Settings, chainId: number, sell: Symbol) {
  const s = ASSETS[chainId][sell]!
  const sold = wrapped(chainId, s.token)
  const cap = capOf(sell, s.decimals)
  const sizes = DEPTH.map((part) => cap / part)
  const buys = new Map<string, { symbols: Symbol[]; asset: Asset }>()
  for (const [symbol, b] of Object.entries(ASSETS[chainId]) as [Symbol, Asset][]) {
    const token = wrapped(chainId, b.token)
    if (token !== sold) buys.set(token, { symbols: [...(buys.get(token)?.symbols ?? []), symbol], asset: b })
  }
  const read = []
  for (const [token, { symbols, asset }] of buys) read.push(await (async () => {
    const data = appData(chainId, 'market', SLIPPAGE.default, s.stable && asset.stable)
    const quotes = await Promise.all(sizes.map(async (size) => {
      const answer = await ask(env, chainId, '/api/v1/quote', {
        method: 'POST',
        body: JSON.stringify({ sellToken: sold, buyToken: token, from: NOBODY, kind: 'sell', sellAmountBeforeFee: size.toString(), priceQuality: 'optimal', signingScheme: 'eip712', appData: data.full, appDataHash: data.hash }),
      })
      const q = (answer.body as { quote?: Record<string, unknown> } | null)?.quote
      if (answer.status === 200 && q && digits(q.sellAmount) && digits(q.buyAmount) && BigInt(q.sellAmount as string) > 0n) return { sold: BigInt(q.sellAmount as string), bought: BigInt(q.buyAmount as string) }
      return answer.status === 0 || answer.status === 429 || answer.status >= 500 ? 'unavailable' : 'none'
    }))
    const [first, ...rest] = quotes
    if (typeof first === 'string') return { buy: symbols, score: first, moves: rest.map(() => null) }
    // How far the price at each size is from the reference, in bps, never below 0 (the fee weighs more on a small order).
    const moves = rest.map((q) => (typeof q === 'string' ? null : Number(10_000n - (q.bought * first.sold * 10_000n) / (q.sold * first.bought)))).map((m) => (m === null ? null : Math.max(m, 0)))
    const within = (m: number | null) => m !== null && m <= DEEP_BPS
    return { buy: symbols, score: rest.includes('unavailable') ? 'unavailable' : within(moves[2]) ? 'deep' : within(moves[1]) ? 'medium' : 'thin', moves }
  })())
  return { chainId, sell, sizes: sizes.slice(1).map((size) => decimal(size, s.decimals)), routes: read }
}

// ---- words ----
/** What the blotter says of an order: its approval row and its order row. */
// An ETH sale waits in the same state as a Safe's order: checked, its link live, until its transaction lands (eth).
export function stateOf(o: { state: string; open: boolean; type: Ticket['type']; approvedAt: number | null; uid: string | null; status: string | null; validTo: number | null; eth: boolean }, now: number) {
  if (o.state === 'pending') return o.open ? 'Pending approval' : 'Expired'
  if (o.state === 'rejected' || o.status === 'refused') return 'Refused'
  if (o.state !== 'applied') return 'Cancelled'
  if (!o.uid) return o.status === 'cancelled' ? 'Withdrawn' : signBy(o) > now ? 'Approved: waiting for signature' : 'Expired'
  if (o.status === 'presignaturePending' && (o.validTo ?? 0) * 1000 > now) return o.eth ? 'Sent: waiting for the ETH transaction' : 'Sent: waiting for the Safe transaction'
  if (o.status === 'fulfilled') return 'Filled'
  if (o.status === 'cancelled') return 'Cancelled'
  return o.status === 'expired' || (o.validTo ?? 0) * 1000 <= now ? 'Expired' : 'Open'
}
const VALID_WORDS: Record<number, string> = { 1800: '30 minutes', 14_400: '4 hours', 86_400: '24 hours' }
/** The terms in words, as the signing page and the Approvals card show them. binding: what the wallet's signature binds, in three sentences. */
export function words(t: Terms, validTo: number | null) {
  const [s, b] = [ASSETS[t.chainId][t.sell.symbol], ASSETS[t.chainId][t.buy.symbol]]
  const [sell, least] = [`${decimal(t.sell.amount, s?.decimals ?? 18)} ${t.sell.symbol}`, `${decimal(t.buy.minimum, b?.decimals ?? 18)} ${t.buy.symbol}`]
  const until = validTo ? `${new Date(validTo * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : null
  return {
    sell, buy: `at least ${least}`,
    type: t.type === 'market' ? `Market, slippage ${t.slippageBips! / 100}%` : `Limit, at ${t.limitPrice} ${t.buy.symbol} per ${t.sell.symbol}`,
    chain: CHAIN_NAME[t.chainId] ?? `Chain ${t.chainId}`,
    wallet: `${t.label} (${t.wallet})`,
    valid: until ? `Until ${until}` : `${VALID_WORDS[t.validFor]} after signing`,
    signWithin: t.type === 'market' ? '1 hour' : '24 hours', // SIGN_MS in words: how long after the approval the wallet can sign
    fee: '0.01% of the volume, plus a share of any price better than the quote',
    quote: `${decimal(t.quoted, b?.decimals ?? 18)} ${t.buy.symbol}`,
    binding: `Sell exactly ${sell}. Receive at least ${least}. ${until ? `Valid until ${until}` : `Valid for ${VALID_WORDS[t.validFor]} after signing`}.`,
  }
}
