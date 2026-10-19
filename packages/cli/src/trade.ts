// Quotes, swaps and order status on the Ophis orderbooks.
// The order rules mirror @ophis/agent-swap: sell exactly the requested amount, accept at least
// the expected amount minus slippage, receiver is always the owner, approve only what open orders need.
import {
  bytesToHex,
  concat,
  encodeFunctionData,
  erc20Abi,
  ExecutionRevertedError,
  getAddress,
  hashTypedData,
  isAddress,
  numberToHex,
  parseAbi,
  parseUnits,
  recoverTypedDataAddress,
  type Address,
  type BaseError,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import {
  buildOphisFullAppData,
  buildOrder,
  enrollOphisTrader,
  getOphisOrderbookUrl,
  getOphisVaultRelayer,
  isOphisStablePair,
  NATIVE_TOKEN_SENTINEL,
  OPHIS_CHAIN_IDS,
  OPHIS_PRICE_IMPROVEMENT_BPS,
  OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
  OPHIS_STABLE_PRICE_IMPROVEMENT_BPS,
  OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
  type BuiltOrder,
} from '@ophis/sdk'
// ponytail: token lookup and order relay come straight from the MCP server module (same checks the
// agents get); move them into @ophis/sdk before any public release.
import { findListedToken, isUntradeableToken, resolveToken, submitOrder } from '@ophis/mcp-server/src/ophis.ts'
import { reader, tag, type Network } from './network.ts'
import type { Signer, TxRequest, TypedDataJson } from './phone.ts'
import { amount, bold, clean, dim, finish, green, red, rows, saffron, spinner, UserError } from './ui.ts'

export const ORDER_TTL = 30 * 60 // seconds an order stays open, as in @ophis/agent-swap
const WRAPPED_ABI = parseAbi(['function deposit() payable'])
// OP-stack chains charge an L1 data fee on top of gas. Their fee oracle gives an upper bound per tx size.
const OP_STACK = new Set([10, 130, 8453, 57073])
const GAS_ORACLE = '0x420000000000000000000000000000000000000F'
const ORACLE_ABI = parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)'])
// Arc's gas token, USDC, as its 6-decimal ERC-20 (apps/frontend/libs/common-const/src/arc.const.ts).
const ARC_USDC = '0x3600000000000000000000000000000000000000'

// Each chain's wrapped gas token. Pinned, never read from an RPC: wrapping sends the user's coins to
// this address. Source: @cowprotocol/sdk-config WRAPPED_NATIVE_CURRENCIES plus the Ophis overrides in
// apps/frontend/libs/common-const/src/nativeAndWrappedTokens.ts; all 14 checked against the Ophis
// EthFlow contracts' wrappedNativeToken() on 2026-10-15. Arc has none: its gas token USDC trades as an ERC-20.
export const WRAPPED: Record<number, readonly [Address, string]> = {
  1: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH'],
  10: ['0x4200000000000000000000000000000000000006', 'WETH'],
  56: ['0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'WBNB'],
  100: ['0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', 'WXDAI'],
  130: ['0x4200000000000000000000000000000000000006', 'WETH'],
  137: ['0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'WPOL'],
  4663: ['0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 'WETH'],
  8453: ['0x4200000000000000000000000000000000000006', 'WETH'],
  9745: ['0x6100E367285b01F48D07953803A2d8dCA5D19873', 'WXPL'],
  42161: ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH'],
  43114: ['0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', 'WAVAX'],
  57073: ['0x4200000000000000000000000000000000000006', 'WETH'],
  59144: ['0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', 'WETH'],
  11155111: ['0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', 'WETH'],
}

export interface Token {
  address: Address
  symbol: string
  decimals: number
  native: boolean
  listed: boolean // false: name and decimals came from the RPC, not from the Ophis token list
  note?: string // said above the price, e.g. that ETH was read as the chain's wrapped ether
}

/** What the user asked to trade. Fixed once confirmed: refreshing the price never changes it. */
interface TradeBase {
  net: Network
  sell: Token // what the user typed, e.g. ETH
  pay: Token // what the order sells, e.g. WETH when selling ETH
  buy: Token
  atoms: bigint
  owner: Address
  slippage: number // basis points
  ref?: string
}

export interface Trade extends TradeBase {
  quoted: bigint // the quote's buy amount, before the Ophis fee and slippage
  built: BuiltOrder
  quotedAt: number
}

/** What paying for a swap or a bridge needs: the chain, the tokens, the amount and who pays. */
type Funding = Pick<Trade, 'net' | 'sell' | 'pay' | 'atoms' | 'owner'>

export interface TradeRequest {
  net: Network
  amount: string
  from: string
  to: string
  owner: Address
  slippage: number
  ref?: string
}

/** "100" or "0.5" in token units -> integer atoms. Rejects anything ambiguous. */
export function toAtoms(text: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new UserError(`"${text}" is not an amount. Use digits, like 100 or 0.5.`)
  const exact = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text // 1.50 = 1.5
  if ((exact.split('.')[1] ?? '').length > decimals) throw new UserError(`Too many decimals: this token has ${decimals}.`)
  const atoms = parseUnits(exact, decimals)
  if (atoms <= 0n) throw new UserError('The amount must be more than zero.')
  return atoms
}

/** Slippage given in percent ("0.5") -> basis points (50). */
export function slippageBps(percent: string): number {
  const value = Number(percent)
  if (!/^\d+(\.\d+)?$/.test(percent) || value > 50) throw new UserError('Slippage is a percentage from 0 to 50, like 0.5.')
  // Basis points are the finest step an order takes: a finer value is refused, never rounded wider than asked.
  const bps = Math.round(value * 100)
  if (Math.abs(value * 100 - bps) > 1e-9) throw new UserError('Slippage goes in steps of 0.01%, like 0.5 or 0.25.')
  return bps
}

/** The least the order accepts: the expected amount minus slippage, rounded down. */
export const minOut = (expected: bigint, bps: number) => (expected * BigInt(10_000 - bps)) / 10_000n

interface FeeEntry {
  volumeBps?: number
  priceImprovementBps?: number
  maxVolumeBps?: number
}
const feeEntries = (fee: unknown) => (Array.isArray(fee) ? fee : fee ? [fee] : []) as FeeEntry[]
export const volumeBps = (fee: unknown) => feeEntries(fee).reduce((sum, e) => sum + (e.volumeBps ?? 0), 0)

/** The Ophis volume fee is taken from the trade, after the quote: what the user should expect. */
export const afterFee = (quoted: bigint, bps: number) => (quoted * BigInt(10_000 - bps)) / 10_000n

/** Any address works for a price check; quotes are not tied to funds. Random bytes: no key exists for it. */
export const someAddress = () => getAddress(bytesToHex(crypto.getRandomValues(new Uint8Array(20))))

export async function findToken(net: Network, query: string): Promise<Token> {
  // Arc's gas token is USDC, which only trades as its ERC-20 (see @ophis/sdk assertOphisOrderTokens).
  const isNative = query.toUpperCase() === net.native.toUpperCase() || query.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase()
  if (isNative && net.id !== 5042) {
    return { address: NATIVE_TOKEN_SENTINEL as Address, symbol: net.native, decimals: 18, native: true, listed: true }
  }
  if (isAddress(query)) {
    const address = getAddress(query)
    if (WRAPPED[net.id] && getAddress(WRAPPED[net.id]![0]) === address) return wrappedNative(net)
    // A listed token takes every detail from the Ophis list, looked up by its address. Only unlisted
    // tokens are described by the RPC (and the confirmation screen warns about them).
    const listed = await findListedToken(net.id, address).catch(() => null)
    if (listed) return { address, symbol: clean(listed.symbol), decimals: listed.decimals, native: false, listed: true }
    const client = reader(net)
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ]).catch(() => {
      throw new UserError(`${address} is not a token on ${net.name}.`)
    })
    if (!Number.isInteger(decimals) || decimals > 36) throw new UserError(`${address} reports an impossible number of decimals.`)
    // A token's own symbol is attacker-chosen text: clean it before it reaches the confirmation screen.
    return { address, symbol: clean(symbol).slice(0, 24) || '???', decimals, native: false, listed: false }
  }
  const wrapped = WRAPPED[net.id]
  if (wrapped && query.toUpperCase() === wrapped[1]) return wrappedNative(net) // pinned beats any list
  const found = await resolveToken({ chainId: net.id, symbol: query })
  if (found.canonical) {
    const { address, symbol, decimals } = found.canonical
    return { address, symbol: clean(symbol), decimals, native: false, listed: true }
  }
  if (found.matches.length > 1) {
    const list = found.matches.map((m) => `      ${m.address}  ${clean(m.symbol)}  ${dim(clean(m.name))}`).join('\n')
    throw new UserError(`"${query}" could mean several tokens on ${net.name}. Use the address instead:\n${list}`)
  }
  // Never on a partial view: an Ophis list that could not be read may hold this very name.
  if (found.incomplete) throw new UserError(`Could not read the Ophis token list just now. Try again, or use the token's address.`)
  // A chain with its own coin has ether only as a token: ETH is what the Ophis list names so (BNB Chain), else the
  // chain's wrapped ether, said aloud above the price. Never a public list's lookalike (Wormhole ether on Polygon and
  // Avalanche calls itself WETH but is not the WETH people mean).
  if (query.toUpperCase() === 'ETH' && net.native !== 'ETH') {
    const weth = await findToken(net, 'WETH')
    // Only a token on the Ophis list stands in for a name the user did not type: a public list's WETH is never
    // substituted silently, it must be asked for by name (and then carries the unlisted-token warning).
    if (!weth.listed) throw new UserError(`${net.name} has no ETH: only wrapped ether is available, WETH.`)
    return { ...weth, note: `${net.name} has no ETH: using wrapped ether, ${weth.symbol}.` }
  }
  // Not on the Ophis list: the public lists swap.ophis.fi also offers on this chain may name it. The address found
  // is then described like a typed one (by the Ophis list, else by the chain, and the confirmation warns).
  const named = await publicListAddresses(net.id, query)
  if (named.length === 1) return findToken(net, named[0]!)
  if (named.length > 1) {
    throw new UserError(`"${clean(query)}" could mean several tokens on ${net.name}. Use the address instead:\n${named.map((a) => `      ${a}`).join('\n')}`)
  }
  throw new UserError(`No token called "${clean(query)}" on ${net.name}. You can also use the token's address.`)
}

// The CoW-hosted public lists swap.ophis.fi offers per chain (apps/frontend/libs/tokens/src/const/tokensList.json).
const PUBLIC_LISTS: Readonly<Record<number, readonly string[]>> = {
  1: ['CoinGecko'],
  56: ['CoinGecko', 'Uniswap'],
  100: ['Uniswap', 'CoinGecko'],
  137: ['CoinGecko', 'Uniswap'],
  8453: ['CoinGecko', 'Uniswap'],
  9745: ['CoinGecko'],
  42161: ['Uniswap', 'CoinGecko'],
  43114: ['CoinGecko', 'Uniswap'],
  57073: ['CoinGecko'],
  59144: ['CoinGecko'],
}

/** Addresses a symbol has in those lists. Every list must be read: a partial view could hide another token of that name. */
async function publicListAddresses(chainId: number, symbol: string): Promise<Address[]> {
  const want = symbol.toUpperCase()
  const lists = await Promise.all(
    (PUBLIC_LISTS[chainId] ?? []).map(async (name) => {
      const res = await fetch(`https://files.cow.fi/token-lists/${name}.${chainId}.json`, { signal: AbortSignal.timeout(8_000) }).catch(() => null)
      const body = res?.ok ? ((await res.json().catch(() => null)) as { tokens?: unknown } | null) : null
      if (!Array.isArray(body?.tokens)) throw new UserError(`Could not check the public token lists for "${clean(symbol)}" just now. Try again, or use the token's address.`)
      return body.tokens as { chainId?: unknown; symbol?: unknown; address?: unknown }[]
    }),
  )
  const found = new Set<Address>()
  for (const t of lists.flat()) {
    if (t?.chainId === chainId && typeof t.symbol === 'string' && t.symbol.toUpperCase() === want && typeof t.address === 'string' && isAddress(t.address) && !isUntradeableToken(chainId, t.address)) {
      found.add(getAddress(t.address))
    }
  }
  return [...found]
}

/** The ERC-20 that wraps the chain's gas token (WETH on most chains), from the pinned table. */
export function wrappedNative(net: Network): Token {
  const wrapped = WRAPPED[net.id]
  if (!wrapped) throw new UserError(`Selling ${net.native} directly is not supported on ${net.name}. Swap its wrapped token instead.`)
  return { address: getAddress(wrapped[0]), symbol: wrapped[1], decimals: 18, native: false, listed: true }
}

/** Plain-English version of an orderbook error. */
export function explain(errorType: string | undefined, fallback: string): string {
  const known: Record<string, string> = {
    NoLiquidity: 'No route for this pair right now. Try another amount or token.',
    SellAmountDoesNotCoverFee: 'The amount is too small to cover network costs. Try a larger amount.',
    UnsupportedToken: 'One of these tokens cannot be traded on Ophis.',
    InsufficientBalance: 'Not enough balance for this order.',
    InsufficientAllowance: 'The token approval is missing or too small.',
    TransferSimulationFailed: 'This token cannot be moved normally (it may tax or block transfers).',
    InvalidSignature: 'The orderbook rejected the signature.',
    DuplicatedOrder: 'This exact order was already sent.',
    SameBuyAndSellToken: 'You cannot sell a token for itself.',
  }
  return (errorType && known[errorType]) || fallback
}

/** fetch() that waits and tries again when the orderbook is busy (429) or briefly down (5xx). */
export async function patient(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
    if ((res.status !== 429 && res.status < 500) || attempt === 4) return res
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
  }
}

async function fetchQuote(t: TradeBase, appData: { fullAppData: string; appDataHash: string }) {
  const res = await patient(`${getOphisOrderbookUrl(t.net.id)}/api/v1/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sellToken: t.pay.address,
      buyToken: t.buy.address,
      from: t.owner,
      receiver: t.owner,
      kind: 'sell',
      sellAmountBeforeFee: t.atoms.toString(),
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      priceQuality: 'optimal',
      signingScheme: 'eip712',
      onchainOrder: false,
      appData: appData.fullAppData, // quote with the exact appData the order will sign
      appDataHash: appData.appDataHash,
      validFor: ORDER_TTL,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    quote?: { sellToken: string; buyToken: string; sellAmount: string; buyAmount: string; feeAmount: string }
    errorType?: string
    description?: string
  }
  if (res.status === 429) throw new UserError('Ophis is busy right now. Try again in a minute.')
  if (!res.ok || !body.quote) throw new UserError(explain(body.errorType, `The orderbook said: ${clean(String(body.description ?? res.status))}`))
  return body.quote
}

/** Finds the tokens and the amount, then gets a price. Nothing is signed or sent here. */
export async function prepare(r: TradeRequest): Promise<Trade> {
  const [sell, buy] = await Promise.all([findToken(r.net, r.from), findToken(r.net, r.to)])
  if (sell.native && buy.native) throw new UserError('Pick two different tokens.')
  const pay = sell.native ? wrappedNative(r.net) : sell
  if (pay.address.toLowerCase() === buy.address.toLowerCase()) {
    throw new UserError(sell.native ? `Turning ${sell.symbol} into ${pay.symbol} is a wrap, not a swap.` : 'Pick two different tokens.')
  }
  const atoms = toAtoms(r.amount, sell.decimals)
  return requote({ net: r.net, sell, pay, buy, atoms, owner: r.owner, slippage: r.slippage, ref: r.ref })
}

/** A fresh price for exactly the same tokens and amount, and the order to sign at that price. */
export async function requote(t: TradeBase): Promise<Trade> {
  const stable = isOphisStablePair(t.net.id, t.pay.address, t.buy.address)
  const appData = buildOphisFullAppData(t.net.id, t.slippage, t.ref, 'cli', undefined, stable)
  const q = await fetchQuote(t, appData)

  // Same refusals as @ophis/agent-swap: the quote must be for exactly what was asked.
  if (getAddress(q.sellToken) !== getAddress(t.pay.address) || getAddress(q.buyToken) !== getAddress(t.buy.address)) {
    throw new UserError('The quote came back for different tokens; refusing to continue.')
  }
  if (BigInt(q.sellAmount) + BigInt(q.feeAmount) !== t.atoms) throw new UserError('The quote does not match your amount; refusing to continue.')
  const floor = minOut(afterFee(BigInt(q.buyAmount), volumeBps(appData.partnerFee)), t.slippage)
  if (floor <= 0n) throw new UserError('The amount is too small to get a usable price.')

  const built = buildOrder(
    {
      chainId: t.net.id,
      owner: t.owner,
      sellToken: t.pay.address,
      buyToken: t.buy.address,
      isStablePair: stable,
      sellAmount: t.atoms.toString(),
      buyAmount: floor.toString(),
      kind: 'sell',
      validForSeconds: ORDER_TTL,
      slippageBips: t.slippage,
      referrerCode: t.ref,
      source: 'cli',
    },
    Math.floor(Date.now() / 1000),
  )
  if (built.appDataHash !== appData.appDataHash) throw new Error('appData changed between quote and order')
  const { net, sell, pay, buy, atoms, owner, slippage, ref } = t
  return { net, sell, pay, buy, atoms, owner, slippage, ref, quoted: BigInt(q.buyAmount), built, quotedAt: Date.now() }
}

/** The Ophis fee an order's appData partnerFee charges, in plain words. */
export function feeText(net: Network, partnerFee: unknown, stable: boolean): string {
  const volume = volumeBps(partnerFee)
  if (!volume) return 'none'
  let share = feeEntries(partnerFee).find((e) => e.priceImprovementBps)
  // Ophis-operated chains apply the same price-improvement share in the backend, not in appData.
  if (!share && (Object.values(OPHIS_CHAIN_IDS) as number[]).includes(net.id)) {
    share = stable
      ? { priceImprovementBps: OPHIS_STABLE_PRICE_IMPROVEMENT_BPS, maxVolumeBps: OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS }
      : { priceImprovementBps: OPHIS_PRICE_IMPROVEMENT_BPS, maxVolumeBps: OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS }
  }
  const pct = (bps: number) => `${bps / 100}%`
  if (!share?.priceImprovementBps) return `${pct(volume)} Ophis fee`
  const cap = dim(`(${pct(volume + (share.maxVolumeBps ?? 0))} at most)`)
  return `${pct(volume)} Ophis fee, plus ${pct(share.priceImprovementBps)} of any price better than quoted ${cap}`
}

/** The quote, in plain words, with the exact token contracts. */
export function showTrade(t: Trade, extra: [string, string][] = []): void {
  const expected = afterFee(t.quoted, volumeBps(t.built.partnerFee))
  const price = (expected * 10n ** BigInt(t.sell.decimals) * 10n ** 18n) / (t.atoms * 10n ** BigInt(t.buy.decimals))
  const sellWhere = t.sell.native ? `native coin, wrapped first into ${t.pay.symbol} ${t.pay.address}` : t.sell.address
  const notes = [t.sell.note, t.buy.note].filter(Boolean)
  if (notes.length) console.log(`${notes.map((n) => `  ${saffron('!')} ${n}`).join('\n')}\n`)
  rows([
    ['Chain', tag(t.net)],
    ['You pay', `${amount(t.atoms, t.sell.decimals)} ${t.sell.symbol}`],
    ['You get', bold(saffron(`about ${amount(expected, t.buy.decimals)} ${t.buy.symbol}`))],
    ['At least', `${amount(BigInt(t.built.order.buyAmount), t.buy.decimals)} ${t.buy.symbol}  ${dim(`(${t.slippage / 100}% slippage)`)}`],
    ['Price', `1 ${t.sell.symbol} = ${amount(price, 18)} ${t.buy.symbol}`],
    ['Fee', feeText(t.net, t.built.partnerFee, isOphisStablePair(t.net.id, t.pay.address, t.buy.address))],
    ['Tokens', `${t.sell.symbol}  ${dim(sellWhere)}`],
    ['', `${t.buy.symbol}  ${dim(t.buy.native ? 'native coin' : t.buy.address)}`],
    ...extra,
  ])
  for (const token of [t.sell, t.buy].filter((tk) => !tk.listed)) {
    console.log(`  ${saffron('!')} ${token.symbol} is not on the Ophis token list. Its details come from your RPC: check the amounts.`)
  }
}

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint }
type Client = ReturnType<typeof reader>

const plus20 = (gas: bigint) => (gas * 12n) / 10n

/** A transaction still waiting from this wallet would take the next nonce: never stack on it. */
async function waiting(client: Client, owner: Address): Promise<boolean> {
  const [pending, latest] = await Promise.all([
    client.getTransactionCount({ address: owner, blockTag: 'pending' }),
    client.getTransactionCount({ address: owner, blockTag: 'latest' }),
  ])
  return pending > latest
}

/** The fees pinned into a transaction: cap = 2 x base fee + tip (network.ts), or the legacy gas price. */
async function feesNow(client: Client): Promise<Fees> {
  const fees = await client.estimateFeesPerGas()
  return fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined
    ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
    : { gasPrice: fees.gasPrice ?? 0n }
}

/** The L1 data fee an OP-stack chain can charge for a transaction of this size (none elsewhere). */
const l1Fee = async (client: Client, net: Network, bytes: bigint) =>
  OP_STACK.has(net.id) ? client.readContract({ address: GAS_ORACLE, abi: ORACLE_ABI, functionName: 'getL1FeeUpperBound', args: [bytes] }) : 0n

// OP-stack chains add an L1 data fee that no transaction field can cap, so it can only be an estimate there.
const feeWords = (net: Network, maxFee: bigint, steps?: string) =>
  OP_STACK.has(net.id)
    ? `about ${amount(maxFee, 18)} ${net.native} (${steps ? `${steps}; ` : ''}the L1 data fee part can vary)`
    : `at most ${amount(maxFee, 18)} ${net.native}${steps ? ` (${steps})` : ''}`

interface Prep {
  wrap: boolean
  approve: bigint // the allowance to set; 0n when the current one already covers every open order
  resetFirst: boolean // the token refuses to change a non-zero approval (USDT on Ethereum)
  gas: { wrap: bigint; approve: bigint } // gas limit per transaction
  fees: Fees | null
  maxFee: bigint // the most the transactions can cost together, L1 data fee included
  feeText?: string
  notes: string[] // warnings for the confirmation screen
  wrapDone: boolean // set once the wrap is mined: from then on the user holds the wrapped token
}

/** What this owner's other open orders can still pull from the same token, or null if unknown. */
async function reservedByOpenOrders(t: Funding): Promise<bigint | null> {
  let reserved = 0n
  try {
    // Newest first, 100 per page; ten pages reach far past any order that can still be open.
    for (let offset = 0; offset < 1000; offset += 100) {
      const res = await patient(`${getOphisOrderbookUrl(t.net.id)}/api/v1/account/${t.owner}/orders?offset=${offset}&limit=100`)
      const page = res.ok ? ((await res.json()) as unknown) : null
      if (!Array.isArray(page)) return null
      for (const o of page as { status?: string; sellToken?: string; sellAmount?: string; executedSellAmount?: string }[]) {
        if (o?.status !== 'open' || String(o.sellToken).toLowerCase() !== t.pay.address.toLowerCase()) continue
        const left = BigInt(o.sellAmount ?? 0) - BigInt(o.executedSellAmount ?? 0)
        if (left > 0n) reserved += left
      }
      if (page.length < 100) return reserved
    }
    return null // more than 1,000 orders: older open ones could not all be checked, so say "unknown"
  } catch {
    return null
  }
}

/**
 * Read-only checks before asking anything: enough funds (gas included), which transactions are
 * needed, and their network fee. That fee is pinned into the transactions, so they cannot cost
 * more than the user agreed to, whatever the RPC says later.
 */
export async function checkFunds(t: Funding): Promise<Prep> {
  const client = reader(t.net)
  // Every balance below is read through this RPC: first make sure it is the chain the order is for.
  if ((await client.getChainId()) !== t.net.id) throw new UserError('The RPC answers for a different chain. Check --rpc.')
  const spender = getOphisVaultRelayer(t.net.id)
  const [native, payBalance, allowance, reservedOrUnknown] = await Promise.all([
    client.getBalance({ address: t.owner }),
    client.readContract({ address: t.pay.address, abi: erc20Abi, functionName: 'balanceOf', args: [t.owner] }),
    client.readContract({ address: t.pay.address, abi: erc20Abi, functionName: 'allowance', args: [t.owner, spender] }),
    reservedByOpenOrders(t),
  ])
  const have = t.sell.native ? native : payBalance
  if (have < t.atoms) {
    throw new UserError(`Not enough ${t.sell.symbol}: you have ${amount(have, t.sell.decimals)}, the swap needs ${amount(t.atoms, t.sell.decimals)}.`)
  }
  const reserved = reservedOrUnknown ?? 0n
  const needed = t.atoms + reserved // what Ophis may pull for this order and the open ones
  const notes: string[] = []
  if (reservedOrUnknown === null) {
    notes.push(`Could not check your other open orders. If some also sell ${t.pay.symbol}, one of them may not fill.`)
  }
  if (reserved > 0n && payBalance + (t.sell.native ? t.atoms : 0n) < needed) {
    notes.push(`Your other open orders also sell ${amount(reserved, t.pay.decimals)} ${t.pay.symbol}. Your balance cannot cover all of them, so one may not fill.`)
  }
  const prep: Prep = {
    wrap: t.sell.native,
    approve: allowance < needed ? needed : 0n,
    resetFirst: false,
    gas: { wrap: 0n, approve: 0n },
    fees: null,
    maxFee: 0n,
    notes,
    wrapDone: false,
  }
  if (!prep.wrap && !prep.approve) return prep

  if (await waiting(client, t.owner)) throw new UserError('A transaction from this wallet is still waiting to confirm. Try again once it is through.')

  try {
    if (prep.wrap) {
      prep.gas.wrap = plus20(await client.estimateContractGas({ account: t.owner, address: t.pay.address, abi: WRAPPED_ABI, functionName: 'deposit', value: t.atoms }))
    }
    if (prep.approve) {
      const estimate = (value: bigint) =>
        client.estimateContractGas({ account: t.owner, address: t.pay.address, abi: erc20Abi, functionName: 'approve', args: [spender, value] })
      const direct = await estimate(prep.approve).catch(() => null)
      if (direct === null && allowance === 0n) throw new UserError(`${t.pay.symbol} refuses the approval (it may be paused or block Ophis). Nothing was sent.`)
      prep.resetFirst = direct === null // some tokens refuse to change a non-zero approval
      const resetGas = prep.resetFirst ? await estimate(0n) : 0n
      // Approving from zero after a reset costs more than the reset itself: keep a wide margin.
      prep.gas.approve = direct !== null ? plus20(direct) : resetGas * 2n > 100_000n ? resetGas * 2n : 100_000n
    }
    prep.fees = await feesNow(client)
    const txs = (prep.wrap ? 1n : 0n) + (prep.approve ? (prep.resetFirst ? 2n : 1n) : 0n)
    const l1 = txs * (await l1Fee(client, t.net, 200n))
    const perGas = 'gasPrice' in prep.fees ? prep.fees.gasPrice : prep.fees.maxFeePerGas
    prep.maxFee = (prep.gas.wrap + prep.gas.approve * (prep.resetFirst ? 2n : 1n)) * perGas + l1
  } catch (err) {
    if (err instanceof UserError) throw err
    throw new UserError('Could not estimate the network fee. Try again in a moment, or use --rpc with another RPC.')
  }

  // The fee is paid from the native balance (on Arc, from the same USDC that is being sold).
  const nativeNeeded = prep.maxFee + (t.sell.native ? t.atoms : 0n)
  if (native < nativeNeeded) {
    const what = t.sell.native ? ' (the swap plus fees)' : ''
    throw new UserError(`Not enough ${t.net.native} for the network fee: this needs up to ${amount(nativeNeeded, 18)} ${t.net.native}${what}, you have ${amount(native, 18)}.`)
  }
  if (t.net.id === 5042 && t.pay.address.toLowerCase() === ARC_USDC && t.pay.decimals === 6) {
    const scale = 10n ** 12n // native USDC has 18 decimals, its ERC-20 view 6
    if (payBalance < t.atoms + (prep.maxFee + scale - 1n) / scale) {
      throw new UserError(`Not enough ${t.pay.symbol} to sell ${amount(t.atoms, t.pay.decimals)} and pay the network fee from the same balance.`)
    }
  }
  const steps = [prep.wrap && 'wrap', prep.resetFirst && 'approval reset', prep.approve && 'approval'].filter(Boolean).join(' + ')
  prep.feeText = feeWords(t.net, prep.maxFee, steps)
  return prep
}

/**
 * Read-only, like checkFunds for a single transaction: its gas, the fees pinned into it and the most it can cost.
 * Estimating the gas runs it against the chain as it is now, so one that would fail is refused here, before any
 * wallet sees it.
 */
export async function priceTx(net: Network, owner: Address, tx: TxRequest): Promise<{ gas: bigint; fees: Fees; maxFee: bigint; feeText: string }> {
  const client = reader(net)
  if ((await client.getChainId()) !== net.id) throw new UserError('The RPC answers for a different chain. Check --rpc.')
  if (await waiting(client, owner)) throw new UserError('A transaction from this wallet is still waiting to confirm. Try again once it is through.')
  const estimate = await client.estimateGas({ account: owner, to: tx.to, data: tx.data, value: tx.value }).catch((err: BaseError & { details?: string }) => {
    if (!err.walk?.((e) => e instanceof ExecutionRevertedError)) throw new UserError('Could not estimate the network fee. Try again in a moment, or use --rpc with another RPC.')
    throw new UserError(`This transaction would fail on-chain, so it was not sent (${clean(String(err.details)).slice(0, 160)}).`)
  })
  const gas = plus20(estimate)
  let fees: Fees, l1: bigint, native: bigint
  try {
    // The L1 fee is sized on the calldata plus room for the rest of the signed transaction.
    ;[fees, l1, native] = await Promise.all([feesNow(client), l1Fee(client, net, BigInt(((tx.data ?? '0x').length - 2) / 2) + 100n), client.getBalance({ address: owner })])
  } catch {
    throw new UserError('Could not estimate the network fee. Try again in a moment, or use --rpc with another RPC.')
  }
  const maxFee = gas * ('gasPrice' in fees ? fees.gasPrice : fees.maxFeePerGas) + l1
  const needed = maxFee + (tx.value ?? 0n)
  if (native < needed) {
    throw new UserError(`Not enough ${net.native} for the network fee: this needs up to ${amount(needed, 18)} ${net.native}, you have ${amount(native, 18)}.`)
  }
  return { gas, fees, maxFee, feeText: feeWords(net, maxFee) }
}

/**
 * Wraps and approves as needed. Each transaction is signed and sent by the user's own wallet app
 * (the CLI proposes the gas and fees shown at confirmation), then waits for its receipt.
 */
export async function fund(t: Funding, prep: Prep, signer: Signer): Promise<void> {
  if (!prep.wrap && !prep.approve) return
  if (!prep.fees) throw new Error('fund() needs the fees from checkFunds()')
  if (getAddress(signer.address) !== getAddress(t.owner)) throw new UserError('The connected wallet changed. Run ophis connect again.')
  const fees = prep.fees
  if ((await reader(t.net).getChainId()) !== t.net.id) throw new UserError('The RPC answers for a different chain. Check --rpc.')
  const send = (label: string, tx: TxRequest) => sendTx(t.net, signer, fees, label, tx)
  if (prep.wrap) {
    const data = encodeFunctionData({ abi: WRAPPED_ABI, functionName: 'deposit' })
    await send(`Wrapping ${amount(t.atoms, 18)} ${t.sell.symbol} into ${t.pay.symbol}`, { to: t.pay.address, data, value: t.atoms, gas: prep.gas.wrap })
    prep.wrapDone = true
  }
  if (prep.approve) {
    const spender = getOphisVaultRelayer(t.net.id)
    const approve = (value: bigint): TxRequest => ({
      to: t.pay.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, value] }),
      gas: prep.gas.approve,
    })
    if (prep.resetFirst) await send(`Resetting the ${t.pay.symbol} approval`, approve(0n))
    const others = prep.approve > t.atoms ? ' (this swap plus your other open orders)' : ''
    await send(`Approving ${amount(prep.approve, t.pay.decimals)} ${t.pay.symbol} for Ophis${others}`, approve(prep.approve))
  }
}

/**
 * Sends one transaction from the user's wallet app with the gas and fees shown at confirmation, then waits for its
 * receipt. Checked again before each one: the user may have waited, or started another one meanwhile.
 */
export async function sendTx(net: Network, signer: Signer, fees: Fees, label: string, tx: TxRequest, client: Client = reader(net)): Promise<TransactionReceipt> {
  if (await waiting(client, signer.address)) throw new UserError('Another transaction from this wallet is waiting to confirm, so the next one was not sent.')
  if ('maxFeePerGas' in fees) {
    const base = (await client.getBlock()).baseFeePerGas ?? 0n
    if ((base * 9n) / 8n + fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
      throw new UserError('Network fees went up since you confirmed, so the next transaction was not sent. Run the command again to see the new fee.')
    }
  }
  const spin = spinner(`${label}: approve it in your wallet`)
  let hash: Hex | undefined
  try {
    hash = await signer.sendTransaction(net.id, { ...tx, ...fees })
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new UserError('The wallet returned an invalid transaction id.')
    // The wallet may speed it up (repriced: the same call, higher fee), or cancel or replace it before it mines: then
    // the receipt is another transaction's, and what this one was sent to do did not happen.
    let replaced: string | undefined
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000, onReplaced: (r) => void (replaced = r.reason) })
    if (replaced && replaced !== 'repriced') {
      throw new UserError(`${label}: your wallet ${replaced === 'cancelled' ? 'cancelled it' : 'replaced it with another transaction'} (${clean(receipt.transactionHash)}), so it did not happen.`)
    }
    if (receipt.status !== 'success') throw new UserError(`${label} failed on-chain (transaction ${clean(receipt.transactionHash)}).`)
    spin.stop(`${green('✓')} ${label}  ${dim(clean(receipt.transactionHash))}`)
    return receipt
  } catch (err) {
    spin.stop(`${red('✗')} ${label}`)
    if ((err as Error).name === 'WaitForTransactionReceiptTimeoutError') {
      throw new UserError(`Transaction ${hash} has not confirmed after 3 minutes. It may still go through: wait for it before trying again.`)
    }
    throw err
  }
}

interface Signed {
  uid: string
  signature: Hex
}

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

/**
 * Has the user's wallet sign the order (free, off-chain), then checks the signature really comes
 * from the connected address. The order id is known from the signed data alone.
 */
export async function sign(t: Trade, signer: Signer): Promise<Signed> {
  if (getAddress(signer.address) !== getAddress(t.owner)) throw new UserError('The connected wallet changed. Run ophis connect again.')
  const o = t.built.order
  const domain = t.built.signing.domain // per-chain Ophis settlement contract, from @ophis/sdk
  // What the wallet shows and signs (numbers as text, the way wallets expect eth_signTypedData_v4)...
  const asJson: TypedDataJson = { domain, types: { EIP712Domain: DOMAIN_TYPES, ...t.built.signing.types } as never, primaryType: 'Order', message: { ...o } }
  // ...and the same data with real numbers, to hash it and check who signed.
  const typed = {
    domain,
    types: t.built.signing.types,
    primaryType: 'Order',
    message: { ...o, sellAmount: BigInt(o.sellAmount), buyAmount: BigInt(o.buyAmount), feeAmount: BigInt(o.feeAmount) },
  } as never
  const spin = spinner('Sign the order in your wallet')
  let signature: Hex
  try {
    signature = await signer.signTypedData(t.net.id, asJson)
    const by = await recoverTypedDataAddress({ ...(typed as object), signature } as never).catch(() => null)
    if (!by || getAddress(by) !== getAddress(t.owner)) {
      throw new UserError('The signature did not come from the connected address (a smart-contract wallet cannot sign this way yet). Nothing was sent.')
    }
    spin.stop(`${green('✓')} Order signed in your wallet`)
  } catch (err) {
    spin.stop(`${red('✗')} Order not signed`)
    throw err
  }
  // Order id = EIP-712 digest + owner + validTo.
  return { signature, uid: concat([hashTypedData(typed), t.owner, numberToHex(o.validTo, { size: 4 })]).toLowerCase() }
}

/** Sends a signed order. An unclear failure is checked against the orderbook, so a retry never doubles a swap. */
export async function send(t: Trade, signed: Signed): Promise<string> {
  try {
    await submitOrder({ chainId: t.net.id, order: t.built.order, signature: signed.signature, from: t.owner, fullAppData: t.built.fullAppData })
  } catch (err) {
    const message = clean((err as Error).message)
    const errorType = /"errorType":"(\w+)"/.exec(message)?.[1]
    // DuplicatedOrder: this very order is already there (a retried send), so it is checked below like a timeout.
    if (errorType && errorType !== 'DuplicatedOrder') {
      // The signature exists: were the order sent on anyway, it could fill until its expiry, and a new one with it.
      const until = new Date(t.built.order.validTo * 1000).toLocaleString()
      throw new UserError(
        `${explain(errorType, `The orderbook refused the order: ${message}`)} The order you signed stays valid until ${until}: before signing a new one, check ophis status ${signed.uid} on ${t.net.alias}`,
      )
    }
    // No clear refusal (a timeout, a dropped connection): the order may have arrived anyway.
    if (!(await getOrder(t.net, signed.uid).catch(() => null))) {
      throw new UserError(`Could not confirm the order reached Ophis (${message}). Before trying again, check: ophis status ${signed.uid} on ${t.net.alias}`)
    }
  }
  enrollOphisTrader(t.owner).catch(() => {}) // best effort: lets the rebate indexer see this wallet
  return signed.uid
}

export const explorer = (uid: string) => `https://explorer.ophis.fi/orders/${uid}`

interface OrderView {
  status: string
  owner?: string
  receiver?: string | null
  fullAppData?: string | null
  sellToken: string
  buyToken: string
  sellAmount: string
  executedSellAmount: string
  executedBuyAmount: string
  creationDate: string
}

export async function getOrder(net: Network, uid: string): Promise<OrderView | null> {
  const res = await patient(`${getOphisOrderbookUrl(net.id)}/api/v1/orders/${uid}`)
  if (res.status === 404) return null
  if (!res.ok) throw new UserError(`The orderbook did not answer (HTTP ${res.status}). Try again.`)
  return (await res.json()) as OrderView
}

type Outcome = 'filled' | 'unfilled' | 'unknown'

/** Follows an order until it fills or expires. Ctrl+C stops watching, not the order. */
export async function watch(net: Network, uid: string, buy: Token, validTo: number, wrapped?: Token, filled?: string): Promise<Outcome> {
  const spin = spinner('Waiting for solvers to fill your order')
  const leave = () => {
    spin.stop(`Stopped watching. The order is still live: ${bold(`ophis status ${uid} on ${net.alias}`)}`)
    finish(130)
  }
  process.once('SIGINT', leave)
  try {
    for (;;) {
      const order = await getOrder(net, uid).catch(() => null)
      if (order?.status === 'fulfilled') {
        spin.stop(`${green("✓")} ${filled ?? `Filled: you received ${bold(saffron(`${amount(BigInt(order.executedBuyAmount), buy.decimals)} ${buy.symbol}`))}`}`)
        return 'filled'
      }
      if (order && (order.status === 'expired' || order.status === 'cancelled')) {
        const kept = wrapped ? ` You now hold ${wrapped.symbol} instead of ${net.native}.` : ''
        spin.stop(`${red('✗')} The order ${order.status} without filling. Nothing was swapped.${kept}`)
        return 'unfilled'
      }
      if (Date.now() / 1000 > validTo + 120) {
        // Past expiry and still no clear answer (orderbook unreachable?): stop, and say how to check.
        spin.stop(`${saffron('!')} Could not get the final result. Check it later with: ${bold(`ophis status ${uid} on ${net.alias}`)}`)
        return 'unknown'
      }
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  } finally {
    process.off('SIGINT', leave)
  }
}

/** `ophis status`: what happened to an order. */
export async function status(net: Network, uid: string, extra: [string, string][] = []): Promise<void> {
  if (!/^0x[0-9a-fA-F]{112}$/.test(uid)) throw new UserError('That is not an order id (0x followed by 112 hex characters).')
  const order = await getOrder(net, uid)
  if (!order) throw new UserError(`No such order on ${net.name}. Is it on another chain? Name it, for example: ophis status ${uid} on ${net.id === 42161 ? 'base' : 'arbitrum'}`)
  // The orderbook's fields are its own text: only token addresses are looked up, never names it could inject.
  if (![order.sellToken, order.buyToken].every((t) => typeof t === 'string' && isAddress(t))) throw new UserError('The orderbook returned an unreadable order.')
  const [sell, buy] = await Promise.all([findToken(net, order.sellToken), findToken(net, order.buyToken)])
  const state: Record<string, string> = { fulfilled: green('Filled'), open: saffron('Open, waiting for solvers'), expired: red('Expired'), cancelled: red('Cancelled') }
  rows([
    ['Status', state[order.status] ?? clean(String(order.status))],
    ['Sold', `${amount(BigInt(order.executedSellAmount), sell.decimals)} of ${amount(BigInt(order.sellAmount), sell.decimals)} ${sell.symbol}`],
    ['Received', `${amount(BigInt(order.executedBuyAmount), buy.decimals)} ${buy.symbol}`],
    ...extra,
    ['Created', new Date(order.creationDate).toLocaleString()],
    ['Details', explorer(uid)],
  ])
}
