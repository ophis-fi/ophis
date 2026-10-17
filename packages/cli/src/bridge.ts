// Bridging between chains through Across, the way swap.ophis.fi does it: a CoW order on the source chain sells
// into the user's own CoW Shed (a personal proxy), and a post-hook signed by the user deposits into Across for
// the user on the destination chain. The CLI never holds a key: the user's wallet signs both, and nothing
// reaches the wallet unless it passes the checks in bridgeAccount below.
import { OrderBookApi, setGlobalAdapter, TradingSdk } from '@cowprotocol/cow-sdk'
import { BridgingSdk, type QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { COW_SHED_FACTORY, COW_SHED_IMPLEMENTATION, COW_SHED_PROXY_INIT_CODE } from '@cowprotocol/sdk-cow-shed'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import {
  buildOphisAppDataPartnerFee,
  buildOphisOrderMetadata,
  getOphisOrderbookUrl,
  getOphisOrderDomain,
} from '@ophis/sdk'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, getContractAddress, hashTypedData, keccak256, numberToHex, pad, parseAbi, parseEventLogs, parseSignature, recoverTypedDataAddress, serializeSignature, toBytes, toFunctionSelector, type Address, type Hex } from 'viem'
import { toAccount } from 'viem/accounts'
import { findListedToken } from '@ophis/mcp-server/src/ophis.ts'
import { ACROSS_EXECUTABLE_SOURCE_IDS, ACROSS_INTEGRATOR_ID, OphisAcrossBridgeProvider } from './across.ts'
import { OPHIS_HOME } from './home.ts'
import type { Network } from './network.ts'
import { reader } from './network.ts'
import type { Signer, TypedDataJson } from './phone.ts'
import { amount, bold, clean, dim, green, note, red, rows, saffron, spinner, UserError } from './ui.ts'
import { afterFee, explain, feeText, getOrder, ORDER_TTL, patient, someAddress, volumeBps, WRAPPED, wrappedNative, type Token } from './trade.ts'

// Pinned from the installed @cowprotocol/sdk-bridging 4.0.2 (ACROSS_SPOOK_CONTRACT_ADDRESSES,
// ACROSS_MATH_CONTRACT_ADDRESSES) and sdk-weiroll 0.1.30 (WEIROLL_ADDRESS), for the source chains Ophis
// enables. If the SDK ever builds a hook with other addresses, bridgeAccount refuses to have it signed.
const WEIROLL = '0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963'
export const ACROSS: Readonly<Record<number, { spokePool: Address; math: Address }>> = {
  1: { spokePool: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', math: '0xf2ae6728b6f146556977Af0A68bFbf5bADA22863' },
  42161: { spokePool: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a', math: '0x5771A4b4029832e79a75De7B485E5fBbec28848f' },
  8453: { spokePool: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64', math: '0xd4e943dc6ddc885f6229ce33c2e3dfe402a12c81' },
}
const EXECUTE = parseAbi(['function execute(bytes32[] commands, bytes[] state)'])
const BALANCE_OF = toFunctionSelector('balanceOf(address)')
const APPROVE = toFunctionSelector('approve(address,uint256)')
const MULTIPLY_AND_SUBTRACT = toFunctionSelector('multiplyAndSubtract(uint256,uint256)')
const ERC20_TRANSFER = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])
const DEPOSIT_V3 = toFunctionSelector('depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)')
const EMPTY_BYTES: Hex = `0x${'00'.repeat(32)}` // a dynamic weiroll argument holds its length word, then its data
const CALL = 1
const STATICCALL = 2
const END = 0xff // weiroll: no more arguments, or no output
const WHOLE_STATE = 0xfe // weiroll: the whole state as one argument or output
const DYNAMIC = 0x80
const PCT_100 = 10n ** 18n
// Across SpokePool on Ethereum, Arbitrum and Base (read on-chain 10-15): a deposit reverts if its quote time is in the
// future or more than depositQuoteTimeBuffer old, or its fill deadline is past or more than fillDeadlineBuffer ahead.
const DEPOSIT_QUOTE_BUFFER = 3_600n
// Across quotes a block the RPC may not have seen yet; the hook only runs in a later block, once it has passed.
const QUOTE_TIME_SKEW = 60n
const FILL_DEADLINE_BUFFER = 21_600n
// Exclusivity lets one relayer fill first: it must end within 5 minutes. Across sends it as an offset, or above the
// SpokePool's MAX_EXCLUSIVITY_PERIOD_SECONDS (31536000 on all three chains, read on-chain) as a timestamp. A fill
// deadline at least 15 minutes after the order's expiry leaves relayers time to fill an order that fills last minute.
const MAX_EXCLUSIVITY = 300n
const EXCLUSIVITY_OFFSET_MAX = 31_536_000n
const FILL_MARGIN = 900n
// The provider's guard asks the shed for the quoted output less 0.1% (the SDK takes the 0.01% Ophis fee off the order
// only when it posts it). It must ask for nearly all of the order's output: a guard for a few atoms would cost a
// griefer nothing to pass.
const GUARD_SLACK_BPS = 20n
// Hook gas: what the SDK sets (sdk-bridging 4.0.2: DEFAULT_GAS_COST_FOR_HOOK_ESTIMATION, COW_SHED_PROXY_CREATION_GAS)
// plus GUARD_GAS for the guard call (OphisAcrossBridgeProvider in across.ts). Measured: 137k with an existing shed and 364k creating it
// on Base, about 505k creating it on Ethereum. The settlement forwards exactly this gas to the hook and ignores a hook
// that fails, so less would leave the tokens in the shed.
const GUARD_GAS = 50_000n
const HOOK_GAS = 240_000n + GUARD_GAS
const SHED_CREATION_GAS = 360_000n
// The CoW Shed's EIP-712 signing domain and types, as the deployed shed (factory below) verifies them; read from
// sdk-cow-shed 0.3.8 and proven by executing a signed hook on a Base fork. Anything else would not verify on-chain.
export const SHED_VERSION = '1.0.1'
export const SHED_FACTORY_ADDRESS = COW_SHED_FACTORY[SHED_VERSION]
export const SHED_TYPES = {
  ExecuteHooks: [{ name: 'calls', type: 'Call[]' }, { name: 'nonce', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }],
  Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }, { name: 'allowFailure', type: 'bool' }, { name: 'isDelegateCall', type: 'bool' }],
}
// What the CLI hands the SDK in place of the order signature: well-formed, but not the user's. Only guardSendOrder,
// after its checks, puts the real one in the order it posts, so no order can be posted any other way.
const WITHHELD_SIGNATURE: Hex = `0x${'00'.repeat(31)}01${'00'.repeat(31)}011b`
export const SHED_FACTORY = parseAbi(['function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature)'])
const TRADE = parseAbi(['event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)'])
const FUNDS_DEPOSITED = parseAbi([
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
])
const FEE_ROOM_BPS = 10n // how far the Across fee may rise between your confirmation and signing (see bridgeQuote)
const HOOK_DEADLINE_SLACK = 300n // seconds of clock skew allowed on the hook's deadline
const FEE_ROSE = new UserError('The bridge fee rose after you confirmed, so nothing was signed or sent. Run the command again to see the new price.')
// A placeholder signature for quotes: the SDK only needs a well-formed one and uses a fixed gas estimate
// ("since quoteSigner is not the real signer, the estimation will fail"). No key exists behind it.
const PLACEHOLDER_SIGNATURE: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`

export const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** The owner's own CoW Shed: where the factory deploys it (CREATE2), computed without the SDK's global adapter. */
export const shedOf = (owner: Address): Address =>
  getContractAddress({
    opcode: 'CREATE2',
    from: SHED_FACTORY_ADDRESS,
    salt: pad(owner),
    bytecode: concat([COW_SHED_PROXY_INIT_CODE[SHED_VERSION], encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [COW_SHED_IMPLEMENTATION[SHED_VERSION], owner])]),
  })

/** What a weiroll call reads: a state word as the program set it, or the output of an earlier call. */
interface WeirollArg {
  dynamic: boolean
  literal?: Hex
  output?: number
}

/**
 * The calls a weiroll program makes, each argument resolved the way the VM resolves it (CommandBuilder): the
 * arguments stop at the first END, a slot holds the output of the last call that wrote it, and a static argument
 * must be exactly one 32-byte word (a dynamic one, whole words) or the VM reverts. Anything not modelled throws.
 */
export function weirollCalls(data: Hex): { callType: number; target: Address; selector: string; args: WeirollArg[]; out: number }[] {
  const {
    args: [commands, state],
  } = decodeFunctionData({ abi: EXECUTE, data })
  const slots: { literal?: Hex; output?: number }[] = state.map((literal) => ({ literal }))
  const calls: { callType: number; target: Address; selector: string; args: WeirollArg[]; out: number }[] = []
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i] ?? '0x'
    const flags = parseInt(c.slice(10, 12), 16)
    // Call type in bits 0-1, 0x40 = the arguments are in the next word. Tuple returns and reserved bits never appear here.
    if ((flags & ~0x43) !== 0 || ((flags & 3) !== CALL && (flags & 3) !== STATICCALL)) throw new Error(`unexpected weiroll flags ${flags}`)
    const indices = flags & 0x40 ? commands[++i]?.slice(2) : c.slice(12, 24)
    if (!indices) throw new Error('a weiroll command lost its argument word')
    const args: WeirollArg[] = []
    for (const b of (indices.match(/../g) ?? []).map((h) => parseInt(h, 16))) {
      if (b === END) break
      const slot = b === WHOLE_STATE ? undefined : slots[b & 0x7f]
      const dynamic = (b & DYNAMIC) !== 0
      const size = slot?.literal ? (slot.literal.length - 2) / 2 : 32
      if (!slot || (slot.output !== undefined && dynamic) || (dynamic ? size % 32 !== 0 : size !== 32)) throw new Error('a weiroll argument the VM would not pass as built')
      args.push({ dynamic, ...slot })
    }
    const out = parseInt(c.slice(24, 26), 16)
    if (out !== END) {
      if (out & DYNAMIC || !slots[out]) throw new Error('a weiroll output this check cannot follow')
      slots[out] = { output: calls.length }
    }
    calls.push({ callType: flags & 3, target: getAddress(`0x${c.slice(26, 66)}`), selector: c.slice(0, 10), args, out })
  }
  return calls
}

/** A static literal word as a number; an output, dynamic or missing argument is -1, which no check accepts. */
const word = (a: WeirollArg | undefined) => (a && !a.dynamic && a.literal ? BigInt(a.literal) : -1n)
const fromCall = (a: WeirollArg | undefined, k: number) => !!a && !a.dynamic && a.output === k

/**
 * The SDK's Across hook, call by call: balanceOf(shed) = B; multiplyAndSubtract(B, fee) = B less the relay fee;
 * approve(SpokePool, B); depositV3(shed, you, token, confirmed token, B, B less the fee, confirmed chain, relayer,
 * quote time, fill deadline, exclusivity, no message). Pinned SpokePool and math contract; nothing else runs.
 */
function acrossHook(callData: Hex, srcChainId: number, want: BridgeWant, now: bigint): { token: bigint; pct: bigint; fillDeadline: bigint; quoteTime: bigint } | undefined {
  const across = ACROSS[srcChainId]
  const [balance, fee, approve, deposit, ...more] = weirollCalls(callData)
  if (!across || !balance || !fee || !approve || !deposit || more.length) return undefined
  const token = BigInt(balance.target)
  if (token !== BigInt(want.via)) return undefined // only the intermediate token checked at quote time
  const pct = word(fee.args[1])
  const d = deposit.args
  const [relayer, quoteTime, fillDeadline, exclusivity] = [d[7], d[8], d[9], d[10]].map(word) as [bigint, bigint, bigint, bigint]
  const exclusiveUntil = exclusivity === 0n ? 0n : exclusivity <= EXCLUSIVITY_OFFSET_MAX ? now + exclusivity : exclusivity
  const ok =
    balance.selector === BALANCE_OF && balance.callType === STATICCALL && balance.args.length === 1 && word(balance.args[0]) === BigInt(want.shed) &&
    fee.selector === MULTIPLY_AND_SUBTRACT && same(fee.target, across.math) && fee.callType === CALL && fee.args.length === 2 && fromCall(fee.args[0], 0) && pct >= 0n && pct <= PCT_100 &&
    approve.selector === APPROVE && BigInt(approve.target) === token && approve.callType === CALL && approve.args.length === 2 && word(approve.args[0]) === BigInt(across.spokePool) && fromCall(approve.args[1], 0) &&
    // approve and depositV3 store nothing: the VM reverts when a stored output is not exactly one word
    approve.out === END && deposit.out === END &&
    deposit.selector === DEPOSIT_V3 && same(deposit.target, across.spokePool) && deposit.callType === CALL && d.length === 12 &&
    word(d[0]) === BigInt(want.shed) && word(d[1]) === BigInt(want.owner) && word(d[2]) === token && word(d[3]) === BigInt(want.dstToken) &&
    fromCall(d[4], 0) && fromCall(d[5], 1) && word(d[6]) === BigInt(want.dstChainId) &&
    // values the SpokePool accepts at any time from now (the chain's clock) on: an address, a uint32 exclusivity only
    // with a named relayer, a quote time reached (or at most 60 s ahead of the RPC) and not yet stale, a deadline ahead
    // but within its buffer.
    // The order's expiry is checked against the quote time when the order is signed.
    relayer >= 0n && relayer < 2n ** 160n && exclusivity >= 0n && exclusivity < 2n ** 32n && (relayer !== 0n || exclusivity === 0n) && exclusiveUntil <= now + MAX_EXCLUSIVITY &&
    quoteTime <= now + QUOTE_TIME_SKEW && quoteTime >= now - DEPOSIT_QUOTE_BUFFER && fillDeadline > now && fillDeadline <= now + FILL_DEADLINE_BUFFER &&
    !!d[11]?.dynamic && d[11].literal === EMPTY_BYTES
  return ok ? { token, pct, fillDeadline, quoteTime } : undefined
}

/** What the user confirmed: the only things bridgeAccount lets the wallet sign. */
interface BridgeWant {
  owner: Address
  shed: Address // the user's own CoW Shed, recomputed here, never read from the data being signed
  sellToken: Address
  via: Address // the token the order buys and Across carries, checked at quote time (bridgeVia)
  viaMin: bigint // the swap's confirmed minimum of `via`: what the bridge fee is checked on before the hook is signed
  amount: bigint
  dstChainId: number
  dstToken: Address
  minOut: bigint
}

// The four fields CoW Shed and GPv2 sign over: any other (a salt) changes the digest, so the contract would reject
// the signature (a hook that then fails leaves the order's output in the shed).
const PLAIN_DOMAIN = 'chainId,name,verifyingContract,version'
const plainDomain = (d: Record<string, unknown>) => Object.keys(d).filter((k) => d[k] !== undefined).sort().join() === PLAIN_DOMAIN

/** eth_signTypedData_v4 form (numbers as text) of what the SDK asks to sign. */
function toWalletJson(td: { domain?: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): TypedDataJson {
  const plain = (v: unknown): unknown =>
    typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v
  const domain = td.domain ?? {}
  const fields: [string, string][] = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']]
  const { EIP712Domain: _ignored, ...types } = td.types as Record<string, { name: string; type: string }[]>
  return {
    domain: { ...(plain(domain) as object), chainId: Number(domain.chainId) } as TypedDataJson['domain'],
    types: { EIP712Domain: fields.filter(([k]) => domain[k] !== undefined).map(([name, type]) => ({ name, type })), ...types },
    primaryType: td.primaryType,
    message: plain(td.message) as TypedDataJson['message'],
  }
}

/**
 * Has the wallet sign typed data and checks the signature came from the owner. Normalized (v = 27 or 28) as the SDK
 * normalizes it: a shed rejects a v of 0 or 1 (InvalidSignature), which some wallets return.
 */
export async function signedBy(wallet: Signer, chainId: number, td: Parameters<typeof toWalletJson>[0], owner: Address): Promise<Hex> {
  const signature = serializeSignature(parseSignature(await wallet.signTypedData(chainId, toWalletJson(td))))
  const by = await recoverTypedDataAddress({ ...(td as object), signature } as never).catch(() => null)
  if (!by || getAddress(by) !== getAddress(owner)) throw new UserError('Refusing to sign: the signature did not come from your connected address. Nothing was sent.')
  return signature
}

/**
 * The account the bridging SDK signs with. It forwards to the user's wallet exactly two things, once, in order:
 *  1. the hook for the user's own CoW Shed: a guard call that only succeeds once the shed holds the order's output,
 *     then one weiroll program that only makes the Across deposit above;
 *  2. then an Order that sells at most the confirmed amount into that shed, for the hook's token, filled whole,
 *     with no fee field and before the deposit deadline, whose bridge output at the hook's fee still meets the
 *     minimum the user accepted. The SDK gets a withheld signature for it; guardSendOrder posts the real one.
 * Anything else is refused before the wallet sees it, and every signature must come back from the user's address.
 * now() reads the source chain's clock; onOrderSigned gets the order id as soon as the order is signed, before it is sent.
 */
export interface BridgeSigned {
  hook?: { callData: Hex } // the shed factory call that runs the signed hook, as it must appear in the order's appData
  order?: { appData: Hex; uid: Hex; signature: Hex }
}

export function bridgeAccount(
  wallet: Signer,
  srcChainId: number,
  want: BridgeWant,
  opts: { now: () => Promise<bigint>; onOrderSigned?: (uid: Hex) => void; onHookSigned?: (callData: Hex) => void },
) {
  let hook: { token: bigint; pct: bigint; deadline: bigint; quoteTime: bigint; fillDeadline: bigint; minIn: bigint; calls: readonly unknown[]; nonce: Hex; hookDeadline: bigint } | undefined
  const signed: BridgeSigned = {}
  let signedOrder = false
  let busy = false // one request at a time, so no check can be raced by a second request
  const refuse = (why: string) => new UserError(`Refusing to sign: ${why}. Nothing was sent.`)
  const no = async (): Promise<Hex> => {
    throw refuse('this bridge only signs typed data')
  }
  const account = toAccount({
    address: want.owner,
    signMessage: no,
    signTransaction: no,
    async signTypedData(request) {
      if (busy) throw refuse('another signature is still pending')
      busy = true
      try {
        // A private copy: what is checked below is exactly what the wallet signs and the signature is checked against.
        const td = structuredClone(request)
        if (signedOrder) throw refuse('this bridge is already signed')
        const d = (td.domain ?? {}) as { name?: string; version?: string; chainId?: number | bigint; verifyingContract?: string }
        const m = td.message as Record<string, unknown>
        const order = getOphisOrderDomain(srcChainId)
        const n = (v: unknown) => BigInt(String(v))
        let next: typeof hook
        const { EIP712Domain: _domainType, ...types } = (td.types ?? {}) as Record<string, unknown>
        if (
          !hook && td.primaryType === 'ExecuteHooks' && plainDomain(d) && d.name === 'COWShed' && d.version === SHED_VERSION && Number(d.chainId) === srcChainId &&
          same(d.verifyingContract, want.shed) && isDeepStrictEqual(types, SHED_TYPES)
        ) {
          type ShedCall = { target: string; value: bigint | string; callData: Hex; allowFailure: unknown; isDelegateCall: unknown }
          const [guard, call, ...extra] = m.calls as ShedCall[]
          // The guard: the shed transfers the order's minimum output to itself, which reverts while the shed is empty.
          const sent = guard ? (() => { try { return decodeFunctionData({ abi: ERC20_TRANSFER, data: guard.callData }) } catch { return undefined } })() : undefined
          const minIn = sent ? BigInt(sent.args[1]) : 0n
          if (
            !guard || !call || extra.length || guard.isDelegateCall !== false || guard.allowFailure !== false || n(guard.value) !== 0n ||
            !same(guard.target, want.via) || !sent || !same(sent.args[0], want.shed) || minIn <= 0n ||
            call.isDelegateCall !== true || call.allowFailure !== false || n(call.value) !== 0n || !same(call.target, WEIROLL)
          ) {
            throw refuse('the bridge step is not a guarded Across program')
          }
          const now = await opts.now()
          let checked: ReturnType<typeof acrossHook>
          try {
            checked = acrossHook(call.callData, srcChainId, want, now)
          } catch {
            checked = undefined
          }
          if (!checked) throw refuse('the bridge step is not exactly one Across deposit paying you the confirmed token on the confirmed chain')
          // The shed checks the hook's own deadline: one far ahead (a skewed local clock) would stay usable, and recorded,
          // long after its deposit could run (never past its quote time's buffer).
          if (n(m.deadline) > now + DEPOSIT_QUOTE_BUFFER + HOOK_DEADLINE_SLACK) throw refuse('the bridge step would stay valid long after this order')
          // Checked again on the order's real buyAmount below; here so a fee that already breaks the floor is never signed.
          if ((want.viaMin * (PCT_100 - checked.pct)) / PCT_100 < want.minOut) throw FEE_ROSE
          const deadline = n(m.deadline) < checked.fillDeadline ? n(m.deadline) : checked.fillDeadline
          const calls = [
            { target: getAddress(guard.target), value: 0n, callData: guard.callData, allowFailure: false, isDelegateCall: false },
            { target: getAddress(call.target), value: 0n, callData: call.callData, allowFailure: false, isDelegateCall: true },
          ]
          next = { token: checked.token, pct: checked.pct, deadline, quoteTime: checked.quoteTime, fillDeadline: checked.fillDeadline, minIn, calls, nonce: m.nonce as Hex, hookDeadline: n(m.deadline) }
        } else if (
          hook && td.primaryType === 'Order' && plainDomain(d) && d.name === order.name && d.version === order.version && Number(d.chainId) === order.chainId &&
          same(d.verifyingContract, order.verifyingContract) && same(m.receiver, want.shed) && m.kind === 'sell' && same(m.sellToken, want.sellToken) &&
          n(m.sellAmount) <= want.amount && n(m.buyToken) === hook.token && n(m.feeAmount) === 0n && m.partiallyFillable === false &&
          m.sellTokenBalance === 'erc20' && m.buyTokenBalance === 'erc20' && n(m.validTo) <= hook.deadline && n(m.validTo) - hook.quoteTime <= DEPOSIT_QUOTE_BUFFER &&
          n(m.validTo) + FILL_MARGIN <= hook.fillDeadline &&
          // the guard passes once the order fills, and not before for anything much less than the order's output
          hook.minIn <= n(m.buyAmount) && hook.minIn * 10_000n >= n(m.buyAmount) * (10_000n - GUARD_SLACK_BPS)
        ) {
          // The deposit sends the shed balance (at least buyAmount) minus the relay fee the SDK just re-quoted.
          if ((n(m.buyAmount) * (PCT_100 - hook.pct)) / PCT_100 < want.minOut) throw FEE_ROSE
        } else {
          throw refuse(`unexpected ${String(td.primaryType)} for ${String(d.verifyingContract)}`)
        }
        // Normalized as the SDK normalizes it, so the hook re-encoded below matches what it posts.
        const signature = await signedBy(wallet, srcChainId, td as never, want.owner)
        if (next) {
          hook = next
          signed.hook = { callData: encodeFunctionData({ abi: SHED_FACTORY, functionName: 'executeHooks', args: [next.calls as never, next.nonce, next.hookDeadline, want.owner, signature] }) }
          // Public from here: the SDK uploads it with the order's appData before the order is even signed. If it cannot
          // be remembered, the SDK never gets it.
          opts.onHookSigned?.(signed.hook.callData)
        } else {
          signedOrder = true
          const uid = concat([hashTypedData(td as never), want.owner, numberToHex(Number(m.validTo), { size: 4 })]).toLowerCase() as Hex
          signed.order = { appData: m.appData as Hex, uid, signature }
          opts.onOrderSigned?.(uid)
          return WITHHELD_SIGNATURE
        }
        return signature
      } finally {
        busy = false
      }
    },
  })
  return Object.assign(account, { signed })
}

/** The appData the frontend sends with bridge orders: the Ophis fee policy, referral and source tag. */
// Bridges always take the standard fee policy, as on swap.ophis.fi (isStableStablePair is false cross-chain).
function appDataDoc(chainId: number, ref: string | undefined) {
  const base = buildOphisOrderMetadata({ chainId, isStablePair: false, referralCode: ref }) as { appCode: string; metadata: Record<string, unknown> }
  return { ...base, metadata: { ...base.metadata, ophisSource: { app: 'cli' } } }
}

/**
 * What is posted must be what the wallet signed: the signed order (its appData hash), from the owner, with exactly the
 * Ophis fee policy (the #1236 duplication guard) and exactly the signed bridge step as its only hook, run through the
 * shed factory. Without that hook the order would fill into the shed and bridge nothing.
 */
export function guardSendOrder(
  api: Pick<OrderBookApi, 'sendOrder'>,
  chainId: number,
  owner: Address,
  signed: () => BridgeSigned | undefined,
  hookGas: () => Promise<bigint>, // the least gas the hook needs: more when the shed does not exist yet
): void {
  const send = api.sendOrder.bind(api)
  api.sendOrder = (async (body: Body, ...rest: unknown[]) => {
    let real: Hex
    try {
      real = await check(body)
    } catch (err) {
      if (err instanceof UserError) throw err
      throw new UserError('The bridge order could not be checked; refusing to post it.')
    }
    return (send as (...a: unknown[]) => Promise<string>)({ ...body, signature: real }, ...rest)
  }) as never
  type Body = { appData: string; appDataHash: string; from: string; signature: string; signingScheme: string }
  async function check(body: Body): Promise<Hex> {
    const s = signed()
    if (
      !s?.hook || !s.order || keccak256(toBytes(body.appData)).toLowerCase() !== body.appDataHash.toLowerCase() || !same(body.appDataHash, s.order.appData) ||
      !same(body.from, owner) || body.signingScheme !== 'eip712' || body.signature !== WITHHELD_SIGNATURE
    ) {
      throw new UserError('The bridge order data changed before sending; refusing to post it.')
    }
    const meta = (JSON.parse(body.appData) as { metadata?: { partnerFee?: unknown; hooks?: { pre?: unknown[]; post?: { target?: unknown; callData?: unknown; gasLimit?: unknown }[] } } }).metadata
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(meta?.partnerFee)), JSON.parse(JSON.stringify(buildOphisAppDataPartnerFee(chainId, false))))) {
      throw new UserError('The bridge order carries an unexpected fee; refusing to post it.')
    }
    const post = meta?.hooks?.post ?? []
    // The provider appends the Across integrator tag (zero padding, then 1dc0de0311); nothing else may differ.
    const call = String(post[0]?.callData ?? '').toLowerCase()
    const tagged = call.startsWith(s.hook.callData.toLowerCase()) && /^(00)*1dc0de0311$/.test(call.slice(s.hook.callData.length))
    if (meta?.hooks?.pre?.length || post.length !== 1 || !same(post[0]?.target, SHED_FACTORY_ADDRESS) || !tagged) {
      throw new UserError('The bridge order does not carry the bridge step you signed; refusing to post it.')
    }
    const gas = String(post[0]?.gasLimit ?? '')
    if (!/^\d+$/.test(gas) || BigInt(gas) < (await hookGas())) {
      throw new UserError('The bridge step would not get enough gas to run; refusing to post it.')
    }
    return s.order.signature
  }
}

// The weiroll planner tells dynamic arguments (bytes, string, arrays, tuples) from static ones by ethers'
// ParamType.baseType, which viem ABIs lack. With the stock Viem adapter the Across deposit's `bytes message`
// becomes a static 64-byte slot and the hook reverts on-chain ("Static state variables must be 32 bytes"),
// leaving the funds in the user's shed. swap.ophis.fi runs the ethers adapter, which sets baseType.
const baseTyped = (p: { type: string; components?: unknown[] }): object => ({
  ...p,
  baseType: p.type.endsWith(']') ? 'array' : p.type.startsWith('tuple') ? 'tuple' : p.type,
  ...(p.components ? { components: (p.components as { type: string }[]).map(baseTyped) } : {}),
})
export class BridgeAdapter extends ViemAdapter {
  override getContract(address: string, abi: unknown) {
    const items = (Array.isArray(abi) && typeof abi[0] === 'string' ? parseAbi(abi as string[]) : abi) as { type: string; inputs?: { type: string }[]; outputs?: { type: string }[] }[]
    const typed = items.map((f) => (f.type === 'function' ? { ...f, inputs: f.inputs?.map(baseTyped), outputs: f.outputs?.map(baseTyped) } : f))
    return super.getContract(address as never, typed as never)
  }
}

function sdks(src: Network, signer: ReturnType<typeof toAccount>) {
  setGlobalAdapter(new BridgeAdapter({ provider: reader(src) as never, signer: signer as never }) as never)
  const orderBookApi = new OrderBookApi({ chainId: src.id, baseUrls: { [src.id]: getOphisOrderbookUrl(src.id) } } as never)
  const tradingSdk = new TradingSdk({ chainId: src.id, appCode: 'ophis' } as never, { orderBookApi } as never)
  // The shared provider (across.ts) guards the shed hook, bounds its deadline and keeps only trusted intermediates.
  const provider = new OphisAcrossBridgeProvider({ apiOptions: { integratorId: ACROSS_INTEGRATOR_ID } })
  const bridgingSdk = new BridgingSdk({ providers: [provider], tradingSdk, orderBookApi } as never)
  return { orderBookApi, bridgingSdk, provider }
}

export interface BridgeRequest {
  src: Network
  dst: Network
  sell: Token // what the user typed (ETH or an ERC-20)
  pay: Token // what the order sells (WETH when selling ETH)
  buy: Token // on the destination chain
  atoms: bigint
  owner: Address
  slippage: number
  ref?: string
}

export interface BridgeQuote extends BridgeRequest {
  quote: Awaited<ReturnType<BridgingSdk['getQuote']>>
  expected: bigint // likely destination amount, after fees
  minOut: bigint // guaranteed floor on the destination chain, after fees and slippage
  acrossFee: bigint // Across relay fee on the minimum, in the destination token
  seconds?: number
  via: Token // what the order buys and Across carries
  guard: bigint // what the shed hook's guard asks the shed to hold: the order's minimum output of `via`, less 0.1%
  arm: (wallet: Signer, opts: Parameters<typeof bridgeAccount>[3]) => ReturnType<typeof bridgeAccount> // once: see bridgeQuote
}

/** A bridge quote. Nothing is signed: the SDK's quote step uses a keyless placeholder. */
export async function bridgeQuote(r: BridgeRequest): Promise<BridgeQuote> {
  if (!ACROSS_EXECUTABLE_SOURCE_IDS.has(r.src.id) || !ACROSS[r.src.id]) {
    throw new UserError(`Bridging can start from Ethereum, Arbitrum or Base for now (not ${r.src.name}).`)
  }
  if (r.src.id === r.dst.id) throw new UserError('Pick a different destination chain.')
  const placeholder = toAccount({
    address: someAddress(),
    signTypedData: async () => PLACEHOLDER_SIGNATURE,
    signMessage: async () => PLACEHOLDER_SIGNATURE,
    signTransaction: async () => {
      throw new Error('quotes never send transactions')
    },
  })
  // The SDK keeps the signer it quoted with to sign the real hook and order later, so the quote gets a gate
  // that refuses everything until placeBridge arms it with bridgeAccount (what the user confirmed).
  let armed: ReturnType<typeof bridgeAccount> | undefined
  const gate = toAccount({
    address: r.owner,
    signTypedData: async (td) => {
      if (!armed) throw new UserError('Refusing to sign: this bridge was not confirmed. Nothing was sent.')
      return armed.signTypedData(td)
    },
    signMessage: no,
    signTransaction: no,
  })
  const { bridgingSdk, orderBookApi } = sdks(r.src, gate)
  // The SDK later posts through this same client.
  const shed = shedOf(r.owner)
  const hookGas = async () => ((await reader(r.src).getCode({ address: shed })) ?? '0x').length > 2 ? HOOK_GAS : HOOK_GAS + SHED_CREATION_GAS
  guardSendOrder(orderBookApi, r.src.id, r.owner, () => armed?.signed, hookGas)
  const request = {
    kind: 'sell',
    amount: r.atoms,
    sellTokenChainId: r.src.id,
    sellTokenAddress: r.pay.address,
    sellTokenDecimals: r.pay.decimals,
    buyTokenChainId: r.dst.id,
    buyTokenAddress: r.buy.address,
    buyTokenDecimals: r.buy.decimals,
    account: r.owner,
    owner: r.owner,
    appCode: 'ophis',
    swapSlippageBps: r.slippage,
  } as unknown as QuoteBridgeRequest
  let quote: BridgeQuote['quote']
  try {
    quote = await bridgingSdk.getQuote(request, { quoteSigner: placeholder, appData: appDataDoc(r.src.id, r.ref) } as never)
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    if (/NO_ROUTES|NO_INTERMEDIATE|not supported|No routes/i.test(msg)) throw new UserError(`Across has no route for ${r.sell.symbol} on ${r.src.name} to ${r.buy.symbol} on ${r.dst.name} right now.`)
    throw new UserError(`Could not get a bridge price: ${clean(msg).slice(0, 140)}`)
  }
  const legs = quote as unknown as {
    swap: { amountsAndCosts: { afterPartnerFees: { buyAmount: bigint }; afterSlippage: { buyAmount: bigint } } }
    bridge: { amountsAndCosts: { beforeFee: { buyAmount: bigint }; afterFee: { buyAmount: bigint }; afterSlippage: { buyAmount: bigint } }; expectedFillTimeSeconds?: number }
  }
  // The bridge leg is quoted on the swap's MINIMUM output. Across re-quotes its fee when the order is signed and
  // the fee moves with gas, so the floor leaves it FEE_ROOM_BPS to rise; bridgeAccount refuses anything below.
  const across = legs.bridge.amountsAndCosts
  const [before, after] = [BigInt(across.beforeFee.buyAmount), BigInt(across.afterFee.buyAmount)]
  const minOut = BigInt(across.afterSlippage.buyAmount) - (before * FEE_ROOM_BPS) / 10_000n
  if (minOut <= 0n) throw new UserError('The amount is too small to bridge after fees. Try a larger amount.')
  // Likely: the swap's expected output less the same Across fee rate and the Ophis volume fee (same decimals: across.ts).
  const likely = afterFee((BigInt(legs.swap.amountsAndCosts.afterPartnerFees.buyAmount) * after) / before, volumeBps(buildOphisAppDataPartnerFee(r.src.id, false)))
  const via = await bridgeVia(r.src, String((quote as unknown as { swap: { tradeParameters: { buyToken: string } } }).swap.tradeParameters.buyToken), r.dst, r.buy)
  return {
    ...r, quote, expected: likely > minOut ? likely : minOut, minOut, acrossFee: before - after, seconds: legs.bridge.expectedFillTimeSeconds, via,
    guard: (BigInt(legs.swap.amountsAndCosts.afterSlippage.buyAmount) * 9_990n) / 10_000n,
    // Once, with the checks built from this quote alone: what was shown is all the wallet can be asked to sign.
    arm: (wallet, opts) => {
      if (armed) throw new UserError('This bridge price was already used. Run the command again for a fresh one.')
      const viaMin = BigInt(legs.swap.amountsAndCosts.afterSlippage.buyAmount)
      const want = { owner: r.owner, shed, sellToken: r.pay.address, via: via.address, viaMin, amount: r.atoms, dstChainId: r.dst.id, dstToken: r.buy.address, minOut }
      armed = bridgeAccount(wallet, r.src.id, want, opts)
      return armed
    },
  }
}

// Robinhood Chain has no USDC: Across carries USDC into its USDG, the one pair of different assets a bridge may join.
// The frontend's USDG_ROBINHOOD, also pinned in across.ts (test/bridge.test.ts checks both against the frontend).
export const ROBINHOOD_USDG = { chainId: 4663, address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' } as const

/** A token as Ophis trusts it: the pinned wrapped gas token, else its Ophis list entry; null when neither. */
async function trustedToken(net: Network, address: string): Promise<{ address: string; symbol: string; decimals: number } | null> {
  if (WRAPPED[net.id] && same(address, WRAPPED[net.id]![0])) return wrappedNative(net)
  return findListedToken(net.id, address).catch(() => null)
}

/** The asset a symbol names: Tether's omnichain USDT0 (also written USD₮0) is USDT, and ETH is WETH. */
const assetOf = (symbol: string) => ({ USDT0: 'USDT', 'USD₮0': 'USDT', ETH: 'WETH' } as Record<string, string>)[symbol.toUpperCase()] ?? symbol.toUpperCase()

/**
 * The token the order buys and Across carries. The SDK takes it from Across's route list, so it must be one Ophis
 * trusts: the pinned wrapped gas token or a token on the Ophis list, and the same asset as the destination token (by
 * symbol and decimals as the trusted lists give them, not as Across does), or USDC into Robinhood's USDG and back.
 * Otherwise a spoofed route list could make the order buy a worthless token, or another asset no relayer would carry.
 * The shared provider (across.ts) applies the same rule first; this is the CLI's own second check, written apart.
 */
export async function bridgeVia(src: Network, address: string, dst: Network, buy: Pick<Token, 'address' | 'decimals'>): Promise<Token> {
  const [via, to] = await Promise.all([trustedToken(src, address), trustedToken(dst, buy.address)])
  if (!via) throw new UserError(`Across offered to bridge through ${clean(address)}, which is not on the Ophis token list for ${src.name}; refusing.`)
  if (!to || to.decimals !== buy.decimals) throw new UserError(`The token to receive (${clean(buy.address)}) does not match the Ophis token list for ${dst.name}, so its bridge route cannot be checked; refusing.`)
  const usdg = (net: Network, t: { address: string }) => net.id === ROBINHOOD_USDG.chainId && same(t.address, ROBINHOOD_USDG.address)
  const corridor = (usdg(dst, to) && assetOf(via.symbol) === 'USDC') || (usdg(src, via) && assetOf(to.symbol) === 'USDC')
  if (via.decimals !== to.decimals || (assetOf(via.symbol) !== assetOf(to.symbol) && !corridor)) {
    throw new UserError(`Across offered to bridge through ${clean(via.symbol)} (${getAddress(via.address)}), which is not the same asset as ${clean(to.symbol)} on ${dst.name}; refusing.`)
  }
  return { address: getAddress(via.address), symbol: clean(via.symbol), decimals: via.decimals, native: false, listed: true }
}

/**
 * The bridge step's guard holds the deposit back until the shed holds nearly the order's output. A leftover of the
 * same token from an earlier bridge would let anyone pass it early, bridge the leftover and spend the step, leaving
 * the new order's output stranded: so no bridge starts while the shed holds any.
 */
// Anyone can send dust to a user's (public) shed, so refusing any balance would let them block the user's bridges for
// that price. Below a tenth of the guard the leftover is bridged along and passing the guard early still costs a
// griefer at least 90% of the bridge (paid to the user); from a tenth on, the user recovers it first.
const LEFTOVER_SHARE = 10n

export async function checkLeftover(src: Network, owner: Address, via: Token, guard: bigint): Promise<void> {
  const held = await reader(src)
    .readContract({ address: via.address, abi: erc20Abi, functionName: 'balanceOf', args: [shedOf(owner)] })
    .catch(() => {
      throw new UserError('Could not read your CoW Shed balance. Try again in a moment, or use --rpc with another RPC.')
    })
  if (held * LEFTOVER_SHARE >= guard) throw new UserError(`Your CoW Shed still holds ${amount(held, via.decimals)} ${via.symbol} from an earlier bridge. Recover it first: ophis recover ${via.address} -c ${src.alias}`)
}

export const SHED_NONCES = parseAbi(['function nonces(bytes32 nonce) view returns (bool)'])

// The bridge hooks this CLI signed, per wallet: an earlier hook that can still run would carry a later bridge's output,
// to its own chain and at its own fee. The orderbook alone cannot show them all (anyone can push an order out of the
// newest ones with pre-sign orders "from" the wallet). A hook is recorded the moment it is signed (it is public from
// then on) and kept until its deadline passes: one whose nonce is used blocks nothing, but stays recorded, so a reorg
// that undoes that use still finds it.
type PlacedHook = { chainId: number; nonce: Hex; deadline: string }
const HOOKS_FILE = () => join(OPHIS_HOME, 'bridge-hooks.json')
const UNREADABLE = () => new UserError(`Your bridge records (${HOOKS_FILE()}) cannot be read, so no bridge is started. Remove the file only once no earlier bridge could still run (an hour after the last one).`)
// No hook signed now can run longer (bridgeAccount and recover bound it): a record past it is not one of this CLI's.
const MAX_HOOK_LIFE = 2n * 60n * 60n
function storedHooks(): Record<string, PlacedHook[] | undefined> {
  const text = (() => {
    try {
      return readFileSync(HOOKS_FILE(), 'utf8')
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return '{}'
      throw UNREADABLE()
    }
  })()
  try {
    const all: unknown = JSON.parse(text)
    // Every record exactly as written: one that reads as another chain or no deadline would be skipped, not checked.
    const valid = (hook: unknown) => {
      const { chainId, nonce, deadline } = (hook ?? {}) as Partial<PlacedHook>
      return Number.isSafeInteger(chainId) && typeof nonce === 'string' && /^0x[0-9a-fA-F]{64}$/.test(nonce) && typeof deadline === 'string' && /^\d+$/.test(deadline)
    }
    const wallets = all && typeof all === 'object' && !Array.isArray(all) ? Object.values(all) : null
    if (wallets?.every((hooks) => Array.isArray(hooks) && hooks.every(valid))) return all as Record<string, PlacedHook[] | undefined>
  } catch {
    // below
  }
  throw UNREADABLE()
}
/** Rewrites one wallet's records from the file as it is now, atomically (a crash leaves the old file or the new one). */
function updateHooks(owner: Address, change: (hooks: PlacedHook[]) => PlacedHook[]): void {
  mkdirSync(OPHIS_HOME, { recursive: true, mode: 0o700 })
  const all = storedHooks()
  const next = `${HOOKS_FILE()}.${process.pid}`
  writeFileSync(next, `${JSON.stringify({ ...all, [getAddress(owner)]: change(all[getAddress(owner)] ?? []) })}\n`, { mode: 0o600 })
  // On disk before the hook can be published: the new file flushed, then renamed, then the rename flushed.
  flush(next, 'r+')
  renameSync(next, HOOKS_FILE())
  try {
    flush(OPHIS_HOME, 'r')
  } catch (err) {
    // A platform that cannot flush a folder: the rename is still atomic. Any other failure (EIO) means the record may
    // not survive a power loss, so the hook is not exposed.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'EPERM', 'EACCES'].includes((err as { code?: string }).code ?? '')) throw err
  }
}
function flush(path: string, flags: 'r' | 'r+'): void {
  const fd = openSync(path, flags)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
/** Records a shed hook just signed for the owner (its shed factory call): a bridge's, or a recovery's. */
export function rememberHook(src: Network, owner: Address, callData: Hex): void {
  const [, nonce, deadline] = decodeFunctionData({ abi: SHED_FACTORY, data: callData }).args
  updateHooks(owner, (hooks) => [...hooks, { chainId: src.id, nonce, deadline: String(deadline) }])
}

/**
 * Refuses a bridge while an earlier hook on this chain could still run (unused, not expired): one this CLI signed, or
 * one the orderbook lists (listed, from openBridge). Only a run holding the bridge lock prunes the records (prune), so
 * no other run's new record is ever overwritten.
 */
export async function checkEarlierHooks(src: Network, owner: Address, prune = false, listed: ShedHook[] = []): Promise<void> {
  const owned = storedHooks()[getAddress(owner)] ?? []
  if (!listed.length && !owned.some((hook) => hook.chainId === src.id)) return
  const client = reader(src)
  // The nonces and the clock below must be this chain's: a wrong --rpc must not count as "expired" or "used".
  if ((await client.getChainId()) !== src.id) throw new UserError('The RPC answers for a different chain. Check --rpc.')
  const now = (await client.getBlock()).timestamp
  if (owned.some((hook) => hook.chainId === src.id && BigInt(hook.deadline) > now + MAX_HOOK_LIFE)) throw UNREADABLE()
  const here = owned.filter((hook) => hook.chainId === src.id && BigInt(hook.deadline) > now)
  const live = [...here.map(({ nonce, deadline }) => ({ nonce, deadline: BigInt(deadline) })), ...listed.filter((hook) => hook.deadline > now)]
  const used = await Promise.all(
    live.map(({ nonce }) =>
      client.call({ to: shedOf(owner), data: encodeFunctionData({ abi: SHED_NONCES, functionName: 'nonces', args: [nonce] }) }).then(
        ({ data }) => !!data && data !== '0x' && BigInt(data) !== 0n, // no code yet: the factory would create the shed and run it
        () => {
          throw new UserError('Could not check your earlier bridges. Try again in a moment, or use --rpc with another RPC.')
        },
      ),
    ),
  )
  // Only expired records go, and only those: another run may have recorded a hook meanwhile.
  if (prune && here.length < owned.filter((hook) => hook.chainId === src.id).length) {
    updateHooks(owner, (hooks) => hooks.filter((hook) => hook.chainId !== src.id || BigInt(hook.deadline) > now))
  }
  const running = live.filter((_, i) => !used[i])
  if (running.length) {
    const until = new Date(Number(running.reduce((last, hook) => (hook.deadline > last ? hook.deadline : last), 0n)) * 1000)
    throw new UserError(`An earlier bridge or recovery from this wallet could still run until ${until.toLocaleString()} and would carry this one. Try again after that.`)
  }
}

/**
 * One bridge placement at a time on this machine: two runs could both find no earlier bridge before either signs.
 * The lock is a hard link to a file already holding this process's id, so it never exists without it, and it is
 * never taken over automatically (two runs could both decide a lock is stale): one left by a run that died is
 * reported with the file to remove. Ctrl-C ends the run through process.exit, which releases it.
 */
export function lockBridges(): () => void {
  mkdirSync(OPHIS_HOME, { recursive: true, mode: 0o700 })
  const path = join(OPHIS_HOME, 'bridge.lock')
  const mine = `${path}.${process.pid}`
  writeFileSync(mine, String(process.pid), { mode: 0o600 })
  try {
    linkSync(mine, path)
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err
    const holder = (() => {
      try {
        return readFileSync(path, 'utf8').trim()
      } catch {
        return 'unknown'
      }
    })()
    throw new UserError(`Another ophis bridge is being placed (process ${clean(holder)}). If none is running, remove ${path} and try again.`)
  } finally {
    unlinkSync(mine)
  }
  const release = () => {
    try {
      unlinkSync(path)
    } catch {
      // already gone
    }
  }
  process.once('exit', release)
  return () => {
    process.off('exit', release)
    release()
  }
}

type ListedOrder = { uid?: string; status?: string; receiver?: string | null; signingScheme?: string; fullAppData?: string | null }

/**
 * An open bridge order from this wallet: two at once would share its CoW Shed, and the first would carry both. Also
 * the shed hooks of its earlier bridge orders, wherever they were placed (here, the website, another machine): a hook
 * stays valid until its own deadline even once its order is cancelled or filled (checkEarlierHooks reads their
 * nonces). Only orders the owner signed count: anyone can list a pre-sign order "from" a wallet and let it expire.
 * Every page is read (that same listing can push a real order down). Past 1,000 orders it lets the bridge go with a
 * note: refusing would let the listing block the wallet's bridges for good.
 */
export async function openBridge(src: Network, owner: Address): Promise<{ open?: string; hooks: ShedHook[] }> {
  const shed = shedOf(owner)
  const hooks: ShedHook[] = []
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await patient(`${getOphisOrderbookUrl(src.id)}/api/v1/account/${owner}/orders?offset=${offset}&limit=100`)
    const page = res.ok ? ((await res.json().catch(() => null)) as ListedOrder[] | null) : null
    if (!Array.isArray(page)) throw new UserError('Could not check your open orders on the orderbook. Try again in a moment.')
    const intoShed = page.filter((o) => same(o?.receiver, shed))
    // The orderbook's own text: shown to the user, so stripped of anything that could drive the terminal.
    const open = intoShed.find((o) => o.status === 'open')
    if (open) return { open: clean(String(open.uid ?? '')) || '(no id)', hooks }
    const signed = intoShed.filter((o) => o.status === 'cancelled' || o.status === 'fulfilled' || (o.status === 'expired' && o.signingScheme !== 'presign'))
    hooks.push(...signed.flatMap((o) => shedHooks(o.fullAppData)))
    if (page.length < 100) return { hooks }
  }
  note('This wallet has over 1,000 orders: only the newest 1,000 were checked for another bridge.')
  return { hooks }
}

type ShedHook = { nonce: Hex; deadline: bigint }

/** The shed hooks an order's appData carries (metadata.hooks.post). A post-hook that does not decode as one cannot run as one. */
function shedHooks(fullAppData: string | null | undefined): ShedHook[] {
  try {
    const post: { callData?: Hex }[] = JSON.parse(fullAppData ?? '')?.metadata?.hooks?.post ?? []
    return post.flatMap(({ callData }) => {
      try {
        const [, nonce, deadline] = decodeFunctionData({ abi: SHED_FACTORY, data: callData ?? '0x' }).args
        return [{ nonce, deadline }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/** The bridge, in plain words, with the exact token contracts on both chains. */
export function showBridge(b: BridgeQuote, extra: [string, string][] = [], ownerKnown = true): void {
  const minutes = b.seconds ? `about ${Math.max(1, Math.round(b.seconds / 60))} min` : 'a few minutes'
  // Across pays its wrapped gas token out as the native coin to a regular wallet (still wrapped to a smart account).
  const native = same(b.buy.address, wrappedNative(b.dst).address)
  const out = native ? b.dst.native : b.buy.symbol
  rows([
    ['From', `${amount(b.atoms, b.sell.decimals)} ${b.sell.symbol} on ${b.src.name}`],
    ['To', bold(saffron(`about ${amount(b.expected, b.buy.decimals)} ${out} on ${b.dst.name}`))],
    ['At least', `${amount(b.minOut, b.buy.decimals)} ${out}  ${dim(`(${b.slippage / 100}% slippage, and the Across fee may move ${Number(FEE_ROOM_BPS) / 100}%)`)}`],
    ['Bridge', `Across, ${minutes} after the order fills`],
    ['Fees', `Across about ${amount(b.acrossFee, b.buy.decimals)} ${out}, in the amounts above`],
    ['', feeText(b.src, buildOphisAppDataPartnerFee(b.src.id, false), false)],
    ['Recipient', ownerKnown ? `you, ${dim(b.owner)} on ${b.dst.name}` : `your connected wallet, on ${b.dst.name}`],
    ['Tokens', `${b.sell.symbol}  ${dim(b.sell.native ? `native coin, wrapped first into ${b.pay.symbol} ${b.pay.address}` : b.sell.address)}`],
    ...(same(b.via.address, b.pay.address) ? [] : ([['', `${b.via.symbol}  ${dim(`${b.via.address} on ${b.src.name}, bought first and carried by Across`)}`]] as [string, string][])),
    ['', native ? `${out}  ${dim(`native coin on ${b.dst.name} (${b.buy.symbol} ${b.buy.address} if your wallet is a smart account)`)}` : `${b.buy.symbol}  ${dim(`${b.buy.address} on ${b.dst.name}`)}`],
    ...extra,
  ])
}

/** Places the bridge order: the user's wallet signs the shed hook, then the order. Returns the order id and expiry. */
export async function placeBridge(b: BridgeQuote, wallet: Signer, onSigned?: (uid: string) => void): Promise<{ uid: string; validTo: number }> {
  if (getAddress(wallet.address) !== getAddress(b.owner)) throw new UserError('The connected wallet changed. Run ophis connect again.')
  const unlock = lockBridges()
  try {
    return await placeLocked(b, wallet, onSigned)
  } finally {
    unlock()
  }
}

async function placeLocked(b: BridgeQuote, wallet: Signer, onSigned?: (uid: string) => void): Promise<{ uid: string; validTo: number }> {
  const { open, hooks } = await openBridge(b.src, b.owner)
  if (open) throw new UserError(`A bridge from this wallet is still open: ophis status ${open} -c ${b.src.alias}`)
  await checkEarlierHooks(b.src, b.owner, true, hooks)
  await checkLeftover(b.src, b.owner, b.via, b.guard) // again: a refreshed price may bridge through another token
  let signed: string | undefined
  b.arm(wallet, {
    now: async () => (await reader(b.src).getBlock()).timestamp, // the source chain's clock, which the deposit runs on
    onOrderSigned: (uid) => {
      signed = uid
      onSigned?.(uid)
    },
    onHookSigned: (callData) => rememberHook(b.src, b.owner, callData),
  })
  const spin = spinner('Approve the bridge step, then the order, in your wallet')
  const sent = (uid: string) => {
    spin.stop(`${green('✓')} Bridge order signed in your wallet and sent`)
    return { uid, validTo: parseInt(uid.slice(-8), 16) } // an order id ends with its expiry
  }
  try {
    // One expiry for the order and its shed hook: the SDK otherwise dates the hook from the quote and the order
    // from now, so an order filled in its last moments would land in the shed after the hook expired.
    const posted = await (b.quote as unknown as { postSwapOrderFromQuote: (s: unknown) => Promise<{ orderId: string }> }).postSwapOrderFromQuote({
      appData: appDataDoc(b.src.id, b.ref),
      quoteRequest: { validTo: Math.floor(Date.now() / 1000) + ORDER_TTL },
    })
    // The id is computed here from what was signed; an orderbook answering with another one is not trusted.
    if (signed && same(posted.orderId, signed)) return sent(signed)
    spin.stop(`${saffron('!')} The orderbook answered with another order id`)
    throw Object.assign(new UserError(`Before trying again, check: ophis status ${signed ?? clean(String(posted.orderId))} -c ${b.src.alias}`), { maybeSent: true })
  } catch (err) {
    if ((err as { maybeSent?: boolean }).maybeSent) throw err
    if (process.env.OPHIS_DEBUG) console.error(err)
    const body = (err as { body?: { errorType?: string; description?: string } })?.body // the orderbook's answer
    // Once signed, the orderbook is asked before anything is concluded: a send that seemed to fail, or that the SDK
    // retried into DuplicatedOrder, may have arrived.
    if (signed && !(err instanceof UserError)) {
      if (await getOrder(b.src, signed).catch(() => null)) return sent(signed)
      if (!body?.errorType || body.errorType === 'DuplicatedOrder') {
        spin.stop(`${saffron('!')} Could not confirm the bridge order reached Ophis`)
        throw Object.assign(new UserError(`Before trying again, check: ophis status ${signed} -c ${b.src.alias}`), { maybeSent: true })
      }
    }
    spin.stop(`${red('✗')} Bridge order not sent`)
    if (err instanceof UserError) throw err
    throw new UserError(explain(body?.errorType, `The bridge order was not placed: ${clean(String(body?.description ?? (err as Error)?.message ?? err)).slice(0, 160)}`))
  }
}

/** After the source order fills: follows the Across transfer until it lands on the destination chain. */
export async function watchBridge(b: BridgeQuote, uid: string): Promise<'done' | 'failed' | 'unknown'> {
  const spin = spinner(`Bridging to ${b.dst.name}`)
  const deadline = Date.now() + Math.max(15 * 60_000, (b.seconds ?? 0) * 5000)
  while (Date.now() < deadline) {
    const leg = await bridgeStatus(b.src, uid).catch(() => undefined)
    const status = leg?.status
    if (status === 'executed') {
      spin.stop(`${green('✓')} Across reports it arrived on ${b.dst.name}`)
      return 'done'
    }
    if (status === 'expired' || status === 'refund' || status === 'not_deposited') {
      spin.stop(`${red('✗')} ${saidStatus(status, b.src, leg!.shed, leg!.token)}`)
      return 'failed'
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  spin.stop(`${saffron('!')} Still bridging. Check it later with: ${bold(`ophis status ${uid} -c ${b.src.alias}`)}`)
  return 'unknown'
}

/**
 * The Across leg of a bridge order made with this provider: executed, in_progress, expired, refund or unknown, or
 * not_deposited when the order filled but no deposit left its receiver (the user's shed); undefined when it is not
 * such an order or has not filled. The SDK pairs a deposit with an order by its position in the batch, which breaks
 * when the batch settles other trades too, so the deposit is found here by its depositor: the order's receiver.
 * token is what the order bought and Across carries: what a refund, or a deposit that did not run, leaves in the shed.
 */
export async function bridgeStatus(src: Network, uid: string): Promise<{ status: string; shed: Address; owner: Address; token: Address } | undefined> {
  const across = ACROSS[src.id]
  if (!across || !/^0x[0-9a-fA-F]{112}$/.test(uid)) return undefined
  const order = await getOrder(src, uid)
  if (!order?.receiver || !order.owner || !order.fullAppData || !same(order.receiver, shedOf(order.owner as Address))) return undefined
  const { provider } = sdks(src, toAccount({ address: order.receiver as Address, signTypedData: no, signMessage: no, signTransaction: no }))
  let bridging: { providerId?: unknown; destinationChainId?: unknown; destinationTokenAddress?: unknown } | undefined
  try {
    bridging = (JSON.parse(order.fullAppData) as { metadata?: { bridging?: typeof bridging } }).metadata?.bridging
  } catch {
    return undefined
  }
  const [dstChain, dstToken] = [String(bridging?.destinationChainId ?? ''), String(bridging?.destinationTokenAddress ?? '')]
  if (bridging?.providerId !== provider.info.dappId || !/^\d+$/.test(dstChain) || !/^0x[0-9a-fA-F]{40}$/.test(dstToken)) return undefined
  const [shed, owner, token] = [getAddress(order.receiver), getAddress(order.owner), getAddress(order.buyToken)]
  const res = await patient(`${getOphisOrderbookUrl(src.id)}/api/v1/trades?orderUid=${uid}`)
  const tx = res.ok ? ((await res.json()) as { txHash?: Hex | null }[]).find((t) => t.txHash)?.txHash : undefined
  if (!tx) return undefined
  const { logs, status } = await reader(src).getTransactionReceipt({ hash: tx })
  // The orderbook only names the transaction: the settlement in it must have traded this very order.
  const settlement = getOphisOrderDomain(src.id).verifyingContract
  const traded = status === 'success' ? logs.findIndex((log) => parseEventLogs({ abi: TRADE, logs: [log] }).some((l) => same(l.address, settlement) && l.args.orderUid.toLowerCase() === uid.toLowerCase())) : -1
  if (traded < 0) return undefined
  // Two bridges from one wallet in one batch share the shed, so the deposit must also carry this order's tokens and chain,
  // and pay the owner, as the signed hook does. Anyone can name the shed as depositor: depositV3 pulls its input from its
  // caller, then emits FundsDeposited, so each deposit's own pull is the last Transfer of the token into the SpokePool
  // before it, and it must come from the shed (only its signed hook moves a non-zero amount out of it).
  // The settlement pays the order's output into the shed after the order's Trade (pre-hooks run before any Trade), and
  // the order's hook runs after that payout: the first such deposit after it carries it. One before it is another signed
  // hook of this wallet that someone ran first. A zero transfer needs no allowance, so it is no payout.
  const payout = logs.findIndex(
    (log, i) =>
      i > traded &&
      parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: [log] }).some((t) => same(t.address, token) && same(t.args.from, settlement) && same(t.args.to, shed) && t.args.value > 0n),
  )
  if (payout < 0) return undefined
  let pull: { from: Address; value: bigint } | undefined
  const [own] = logs.slice(payout + 1).flatMap((log) => {
    const [moved] = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: [log] })
    if (moved) {
      if (same(moved.address, token) && same(moved.args.to, across.spokePool)) pull = moved.args
      return []
    }
    const [l] = parseEventLogs({ abi: FUNDS_DEPOSITED, logs: [log] })
    if (!l || !same(l.address, across.spokePool)) return []
    const paid = pull
    pull = undefined // one pull per deposit
    const ok =
      BigInt(l.args.depositor) === BigInt(shed) && BigInt(l.args.inputToken) === BigInt(token) && BigInt(l.args.outputToken) === BigInt(dstToken) &&
      l.args.destinationChainId === BigInt(dstChain) && BigInt(l.args.recipient) === BigInt(owner) &&
      l.args.inputAmount > 0n && same(paid?.from, shed) && paid?.value === l.args.inputAmount
    return ok ? [l] : []
  })
  if (!own) return { status: 'not_deposited', shed, owner, token }
  return { status: String((await provider.getStatus(String(own.args.depositId), src.id as never)).status), shed, owner, token }
}

/**
 * A bridge status in plain words. Across returns an unfilled deposit to its depositor: the owner's own CoW Shed. The
 * hint names the token the bridge carried, so recovering it never depends on finding the order again.
 */
export function saidStatus(status: string, src: Network, shed: Address, token: Address, yours = true): string {
  const whose = yours ? 'your CoW Shed' : "the owner's CoW Shed"
  const hint = (how: string) => (yours ? `. ${how} with: ophis recover ${token} -c ${src.alias}` : '')
  const said: Record<string, string> = {
    executed: 'Bridged: Across reports it arrived on the destination chain',
    in_progress: 'Bridging: on its way',
    expired: `No relayer filled it in time, so Across returns it to ${whose} ${shed} on ${src.name} (it stays the owner's)${hint('Once the refund arrives, recover it')}`,
    not_deposited: `The order filled but the Across deposit did not run, so the tokens are in ${whose} ${shed} on ${src.name} (they stay the owner's)${hint('Recover them')}`,
    refund: `Refunded by Across to ${whose} ${shed} on ${src.name} (it stays the owner's)${hint('Recover it')}`,
  }
  return said[status] ?? 'Bridge status not known yet'
}

async function no(): Promise<Hex> {
  throw new Error('bridging only signs typed data, through bridgeAccount')
}
