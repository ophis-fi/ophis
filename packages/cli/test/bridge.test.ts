import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { setGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider } from '@cowprotocol/sdk-bridging'
import { CowShedHooks } from '@cowprotocol/sdk-cow-shed'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { buildOphisAppDataPartnerFee, getOphisOrderDomain } from '@ophis/sdk'
import { concat, createPublicClient, decodeFunctionData, encodeFunctionData, getAddress, hashTypedData, http, keccak256, numberToHex, pad, parseAbi, recoverTypedDataAddress, toBytes, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ACROSS_EXECUTABLE_SOURCE_IDS, OphisAcrossBridgeProvider, tagAcrossIntegratorCalldata } from '../src/across.ts'
import { ACROSS, BridgeAdapter, bridgeAccount, bridgeQuote, bridgeVia, guardSendOrder, ROBINHOOD_USDG, weirollCalls, type BridgeSigned } from '../src/bridge.ts'
import { network } from '../src/network.ts'
import type { Signer, TypedDataJson } from '../src/phone.ts'
import { wrappedNative } from '../src/trade.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('the Across provider adapted from the frontend', () => {
  const OPTS = '../../../apps/frontend/libs/common-const/src/acrossApiOptions.ts'
  const CLI = '../src/across.ts'
  test('the tokens the CLI pins for the copied code are the frontend ones', () => {
    const TOKENS = read('../../../apps/frontend/libs/common-const/src/tokens.ts')
    // tokens.ts writes new TokenWithLogo(logo, chainId, address, decimals, symbol, name), one argument per line. A logo
    // can quote the address too (USDC_MAINNET's does), so the chain id and address are read from their own lines.
    const theirs = (source: string, name: string) => {
      const m = new RegExp(`export const ${name} = new TokenWithLogo\\(\\n[^\\n]*\\n\\s*([^\\n]+),\\n\\s*'(0x[0-9a-fA-F]{40})',\\n`).exec(source)
      const chain = m && (/^\d+/.exec(m[1]!)?.[0] ?? SupportedChainId[m[1]!.replace(/^SupportedChainId\./, '') as keyof typeof SupportedChainId])
      return m ? { chainId: Number(chain), address: m[2]!.toLowerCase() } : undefined
    }
    const ours = (name: string) => {
      const m = new RegExp(`const ${name} = token\\((\\d+), '(0x[0-9a-fA-F]{40})'`).exec(read(CLI))
      return m ? { chainId: Number(m[1]), address: m[2]!.toLowerCase() } : undefined
    }
    expect(ours('USDG_ROBINHOOD')).toBeDefined() // the one token the copied provider pins
    expect(ours('USDG_ROBINHOOD')).toEqual(theirs(TOKENS, 'USDG_ROBINHOOD'))
    expect(theirs(TOKENS, 'USDG_ROBINHOOD')).toEqual({ chainId: ROBINHOOD_USDG.chainId, address: ROBINHOOD_USDG.address.toLowerCase() }) // bridge.ts's own pin
    // The reading follows the arguments: a changed address or chain id is seen, though the logo still quotes the old one.
    const [address, chain] = ["'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',", "SupportedChainId.MAINNET,\n  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'"]
    expect(TOKENS.split(address).length).toBe(2) // the address argument, written once
    const other = "'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'," // USDC_BASE's address, put in USDC_MAINNET's place
    expect(theirs(TOKENS.replace(address, other), 'USDC_MAINNET')).toEqual({ chainId: 1, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' })
    expect(theirs(TOKENS.replace(chain, chain.replace('MAINNET', 'BASE')), 'USDC_MAINNET')?.chainId).toBe(8453)
  })
  test('integrator tag function and constants', () => {
    const fn = (s: string) => {
      const t = s.slice(s.indexOf('export function tagAcrossIntegratorCalldata'))
      return norm(t.slice(0, t.indexOf('\n}\n') + 2))
    }
    expect(fn(read(CLI))).toBe(fn(read(OPTS)))
    for (const literal of ["ACROSS_INTEGRATOR_ID = '0x0311'", "ACROSS_CALLDATA_DELIMITER = '0x1dc0de'"]) {
      expect(read(OPTS)).toContain(literal)
      expect(read(CLI)).toContain(literal)
    }
  })
  test('the tag ends the calldata on a 32-byte boundary', () => {
    const tagged = tagAcrossIntegratorCalldata('0x1234')
    expect(tagged.endsWith('1dc0de0311')).toBe(true)
    expect(((tagged.length - 2) / 2) % 32).toBe(0)
  })
})

describe('bridgeAccount: only the confirmed bridge reaches the wallet', () => {
  // Encoding only: this RPC is never called.
  const client = createPublicClient({ transport: http('http://127.0.0.1:1') }) as never
  // Answered locally: an ordinary wallet (no code), on Base, whose CoW Shed holds nothing yet.
  const adapter = () => Object.assign(new BridgeAdapter({ provider: client }), { getCode: async () => '0x', getChainId: async () => 8453, readContract: async () => 0n }) as never
  setGlobalAdapter(adapter())
  const phone = privateKeyToAccount(generatePrivateKey()) // the test plays the user's wallet app
  const ME = phone.address
  const X: Hex = '0x2222222222222222222222222222222222222222'
  const WETH: Hex = '0x4200000000000000000000000000000000000006'
  const USDC_BASE: Hex = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const USDC_OP: Hex = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
  const PCT = 10n ** 15n // a 0.1% Across relay fee
  const NOW = Math.floor(Date.now() / 1000)
  const DEADLINE = NOW + 3600 // Across fill deadline, also used as the shed hook deadline
  const MIN_IN = 1_000_000n // the order's minimum output, which the guard call requires in the shed
  const SHED = getAddress(new CowShedHooks(8453 as never).proxyOf(ME))
  const EXEC = parseAbi(['function execute(bytes32[] commands, bytes[] state)'])
  const TRANSFER = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])
  const WITHHELD: Hex = `0x${'00'.repeat(31)}01${'00'.repeat(31)}011b`
  const asked: string[] = []
  const seen: TypedDataJson[] = [] // everything the wallet was shown

  /** A wallet app that signs what it is shown (numbers arrive as text, as with a real wallet). */
  const walletOf = (key: ReturnType<typeof privateKeyToAccount>): Signer => ({
    address: ME,
    sendTransaction: async () => {
      throw new Error('not used')
    },
    signTypedData: async (_chain, json: TypedDataJson) => {
      asked.push(json.primaryType)
      seen.push(json)
      const { EIP712Domain: _domain, ...types } = json.types
      const typed = (type: string, value: unknown): unknown => {
        if (type.endsWith('[]')) return (value as unknown[]).map((v) => typed(type.slice(0, -2), v))
        if (types[type]) return Object.fromEntries(types[type]!.map((f) => [f.name, typed(f.type, (value as Record<string, unknown>)[f.name])]))
        return /^u?int\d*$/.test(type) ? BigInt(String(value)) : value
      }
      return key.signTypedData({ domain: json.domain, types, primaryType: json.primaryType, message: typed(json.primaryType, json.message) } as never)
    },
  })
  const wallet = walletOf(phone)
  // Confirmed floor for a 1 USDC intermediate at 0.1%: 1_000_000 * (1e18 - 1e15) / 1e18 = 999_000.
  const want = { owner: ME, shed: SHED, sellToken: WETH, via: USDC_BASE, viaMin: MIN_IN, amount: 10n ** 15n, dstChainId: 10, dstToken: USDC_OP, minOut: 999_000n }
  const account = (w = wallet, onOrderSigned?: (uid: Hex) => void) => bridgeAccount(w, 8453, want, { now: async () => BigInt(NOW), onOrderSigned })

  type Terms = { receiver?: string; pct?: bigint; shed?: string; timestamp?: number; fillDeadline?: number; exclusivity?: number; relayer?: string }
  const unsigned = (o: Terms = {}) =>
    new AcrossBridgeProvider().getUnsignedBridgeCall(
      { sellTokenChainId: 8453, sellTokenAddress: USDC_BASE, buyTokenChainId: 10, buyTokenAddress: USDC_OP, account: ME, receiver: o.receiver ?? ME } as never,
      {
        suggestedFees: {
          totalRelayFee: { pct: String(o.pct ?? PCT) }, timestamp: String(o.timestamp ?? NOW), fillDeadline: o.fillDeadline ?? DEADLINE,
          exclusivityDeadline: o.exclusivity ?? 0, exclusiveRelayer: o.relayer ?? '0x0000000000000000000000000000000000000000',
        },
      } as never,
    )
  /** The guard call the provider puts first: the shed transfers the order's minimum output to itself. */
  const guardCall = (o: { target?: string; to?: string; amount?: bigint } = {}) => ({
    target: o.target ?? USDC_BASE, value: 0n, callData: encodeFunctionData({ abi: TRANSFER, functionName: 'transfer', args: [(o.to ?? SHED) as Hex, o.amount ?? MIN_IN] }),
    allowFailure: false, isDelegateCall: false,
  })
  /** The hook as the CoW Shed typed data the user is asked to sign: the guard, then the real SDK program. */
  const hook = async (o: Terms & { version?: string; calls?: (program: Record<string, unknown>) => Record<string, unknown>[] } = {}) => {
    const call = await unsigned(o)
    const program = { target: call.to, value: BigInt(call.value), callData: call.data as Hex, allowFailure: false, isDelegateCall: true }
    return {
      domain: { name: 'COWShed', version: o.version ?? '1.0.1', chainId: 8453, verifyingContract: o.shed ?? SHED },
      types: {
        ExecuteHooks: [{ name: 'calls', type: 'Call[]' }, { name: 'nonce', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }],
        Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }, { name: 'allowFailure', type: 'bool' }, { name: 'isDelegateCall', type: 'bool' }],
      },
      primaryType: 'ExecuteHooks',
      message: { calls: o.calls ? o.calls(program) : [guardCall(), program], nonce: `0x${'0'.repeat(64)}`, deadline: BigInt(DEADLINE) },
    }
  }
  /** The same hook with its weiroll program edited: commands and state, as the VM reads them. */
  const edit = async (fn: (commands: Hex[], state: Hex[]) => void) => {
    const h = await hook()
    const [guard, call] = h.message.calls as { callData: Hex }[]
    const {
      args: [commands, state],
    } = decodeFunctionData({ abi: EXEC, data: call!.callData })
    const [c, s] = [[...commands], [...state]]
    fn(c, s)
    return { ...h, message: { ...h.message, calls: [guard, { ...call!, callData: encodeFunctionData({ abi: EXEC, functionName: 'execute', args: [c, s] }) }] } }
  }
  const setByte = (w: Hex, k: number, b: number) => `${w.slice(0, 2 + 2 * k)}${b.toString(16).padStart(2, '0')}${w.slice(4 + 2 * k)}` as Hex
  const byteOf = (w: Hex, k: number) => parseInt(w.slice(2 + 2 * k, 4 + 2 * k), 16)
  const depositArgs = (c: Hex[]) => {
    const i = c.findIndex((w) => w.startsWith('0x7b939232'))
    if (i < 0) throw new Error('no depositV3 in the program')
    return i + 1 // depositV3 keeps its arguments in the next word
  }
  const slotOf = (c: Hex[], k: number) => byteOf(c[depositArgs(c)]!, k) // the state slot of depositV3's k-th argument
  const order = (o: Record<string, unknown> = {}) => ({
    domain: getOphisOrderDomain(8453),
    types: {
      Order: [
        { name: 'sellToken', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'receiver', type: 'address' },
        { name: 'sellAmount', type: 'uint256' }, { name: 'buyAmount', type: 'uint256' }, { name: 'validTo', type: 'uint32' },
        { name: 'appData', type: 'bytes32' }, { name: 'feeAmount', type: 'uint256' }, { name: 'kind', type: 'string' },
        { name: 'partiallyFillable', type: 'bool' }, { name: 'sellTokenBalance', type: 'string' }, { name: 'buyTokenBalance', type: 'string' },
      ],
    },
    primaryType: 'Order',
    message: {
      sellToken: WETH, buyToken: USDC_BASE, receiver: SHED, sellAmount: 10n ** 15n, buyAmount: MIN_IN, validTo: DEADLINE - 1000,
      appData: `0x${'0'.repeat(64)}`, feeAmount: 0n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', ...o,
    },
  })
  const sign = (a: ReturnType<typeof account>, td: unknown) => a.signTypedData(td as never)
  const REFUSED = 'Refusing to sign'

  test('signs the guarded hook, then the order into your shed; the order signature is withheld from the SDK', async () => {
    let uid: Hex | undefined
    const a = account(wallet, (id) => {
      uid = id
    })
    expect(await sign(a, await hook())).toMatch(/^0x/)
    const o = order()
    expect(await sign(a, o)).toBe(WITHHELD) // the SDK only ever holds this placeholder
    expect(uid).toBe(concat([hashTypedData(o as never), ME, numberToHex(o.message.validTo, { size: 4 })]).toLowerCase() as Hex)
    const real = a.signed.order!.signature
    expect(real).not.toBe(WITHHELD)
    expect(getAddress(await recoverTypedDataAddress({ ...(o as object), signature: real } as never))).toBe(ME)
  })
  test('the real guarded provider builds exactly what bridgeAccount accepts', async () => {
    const provider = new OphisAcrossBridgeProvider()
    const call = await provider.getUnsignedBridgeCall(
      { sellTokenChainId: 8453, sellTokenAddress: USDC_BASE, buyTokenChainId: 10, buyTokenAddress: USDC_OP, account: ME, receiver: ME, amount: MIN_IN } as never,
      // Relayers get the hour after the order's deadline, as live Across quotes give (about 2 h after the quote).
      { suggestedFees: { totalRelayFee: { pct: String(PCT) }, timestamp: String(NOW), fillDeadline: DEADLINE + 3600, exclusivityDeadline: 0, exclusiveRelayer: '0x0000000000000000000000000000000000000000' } } as never,
    )
    // A floor with room for the Across fee to move, as bridgeQuote sets it (here 0.1%).
    const a = bridgeAccount(wallet, 8453, { ...want, minOut: 998_000n }, { now: async () => BigInt(NOW) })
    const signed = await provider.getSignedHook(8453 as never, call, `0x${'0'.repeat(64)}`, BigInt(DEADLINE), 290_000n as never, a as never)
    expect(signed.postHook.callData.toLowerCase().startsWith(a.signed.hook!.callData.toLowerCase())).toBe(true) // plus the integrator tag
    expect(signed.postHook.callData.endsWith('1dc0de0311')).toBe(true)
    expect(Number(signed.postHook.gasLimit)).toBe(290_000)
    // The SDK takes the 0.01% Ophis fee off the order when it posts it; the guard (0.1% under) still fits.
    expect(await sign(a, order({ buyAmount: MIN_IN - MIN_IN / 10_000n }))).toBe(WITHHELD)
  })
  test('quotes no Across route from a source chain it cannot execute on, however getQuote is reached', async () => {
    const provider = new OphisAcrossBridgeProvider()
    const request = { sellTokenChainId: 100, sellTokenAddress: USDC_BASE, buyTokenChainId: 10, buyTokenAddress: USDC_OP, sellTokenDecimals: 6, buyTokenDecimals: 6, account: ME, amount: MIN_IN }
    await expect(provider.getQuote(request as never)).rejects.toMatchObject({ context: { reason: 'Across is not executable from this source chain' } })
  })
  test('the shed balance is read on the bridge source chain, never on another one', async () => {
    const provider = new OphisAcrossBridgeProvider()
    const call = await provider.getUnsignedBridgeCall(
      { sellTokenChainId: 8453, sellTokenAddress: USDC_BASE, buyTokenChainId: 10, buyTokenAddress: USDC_OP, account: ME, receiver: ME, amount: MIN_IN } as never,
      { suggestedFees: { totalRelayFee: { pct: String(PCT) }, timestamp: String(NOW), fillDeadline: DEADLINE + 3600, exclusivityDeadline: 0, exclusiveRelayer: '0x0000000000000000000000000000000000000000' } } as never,
    )
    setGlobalAdapter(Object.assign(new BridgeAdapter({ provider: client }), { getCode: async () => '0x', getChainId: async () => 1, readContract: async () => 0n }) as never)
    const a = bridgeAccount(wallet, 8453, { ...want, minOut: 998_000n }, { now: async () => BigInt(NOW) })
    await expect(provider.getSignedHook(8453 as never, call, `0x${'0'.repeat(64)}`, BigInt(DEADLINE), 290_000n as never, a as never)).rejects.toThrow('not the one being read')
    setGlobalAdapter(adapter())
  })
  test('the deposit message is a dynamic argument, so the hook can run (the stock Viem adapter breaks it)', async () => {
    const [deposit] = weirollCalls((await hook()).message.calls[1]!.callData as Hex).filter((c) => c.selector === '0x7b939232')
    expect(deposit?.args[11]?.dynamic).toBe(true)
    setGlobalAdapter(new ViemAdapter({ provider: client }) as never)
    const broken = await hook()
    setGlobalAdapter(adapter())
    expect(() => weirollCalls(broken.message.calls[1]!.callData as Hex)).toThrow('the VM would not pass')
    await expect(sign(account(), broken)).rejects.toThrow(REFUSED)
  })
  test('refuses anything that is not the bridge step or its order', async () => {
    await expect(sign(account(), { domain: {}, types: {}, primaryType: 'Permit', message: {} })).rejects.toThrow(REFUSED)
  })
  test('refuses a deposit paying someone else, or a shed that is not yours', async () => {
    asked.length = 0
    await expect(sign(account(), await hook({ receiver: X }))).rejects.toThrow(REFUSED)
    await expect(sign(account(), await hook({ shed: X }))).rejects.toThrow(REFUSED)
    expect(asked).toEqual([]) // the wallet was never asked
  })
  test('refuses a hook the shed would not verify, or without its guard', async () => {
    const changes = [
      await hook({ version: '1.0.0' }), // another signing domain: the signature would not verify on-chain
      { ...(await hook()), types: { ...(await hook()).types, Call: [...(await hook()).types.Call].reverse() } },
      await hook({ calls: (program) => [program] }), // no guard: an early run would burn the nonce
      await hook({ calls: (program) => [guardCall({ amount: 0n }), program] }),
      await hook({ calls: (program) => [guardCall({ to: X }), program] }), // the guard would send the tokens away
      await hook({ calls: (program) => [guardCall({ target: WETH }), program] }),
      await hook({ calls: (program) => [{ ...guardCall(), isDelegateCall: true }, program] }),
      await hook({ calls: (program) => [{ ...guardCall(), allowFailure: true }, program] }),
      await hook({ calls: (program) => [guardCall(), { ...program, allowFailure: true }] }), // a failed deposit would pass silently
      await hook({ calls: (program) => [guardCall(), program, guardCall()] }),
    ]
    for (const td of changes) await expect(sign(account(), td)).rejects.toThrow(REFUSED)
  })
  test('refuses a bridge through another token than the one checked at quote time', async () => {
    const a = bridgeAccount(wallet, 8453, { ...want, via: WETH }, { now: async () => BigInt(NOW) })
    await expect(sign(a, await hook({ calls: (program) => [guardCall({ target: WETH }), program] }))).rejects.toThrow(REFUSED)
  })
  test('reads the program the way the VM runs it', async () => {
    expect(await sign(account(), await edit(() => {}))).toMatch(/^0x/) // the editing itself changes nothing
    const tampered = [
      // the recipient read as dynamic bytes: the VM would pass an offset, not your address
      (c: Hex[]) => {
        const i = depositArgs(c)
        c[i] = setByte(c[i]!, 1, byteOf(c[i]!, 1) | 0x80)
      },
      // the fee math writing its result over the recipient slot
      (c: Hex[]) => {
        const m = c.findIndex((w) => w.startsWith('0x029beb8e'))
        c[m] = setByte(c[m]!, 11, byteOf(c[depositArgs(c)]!, 1))
      },
      // an end marker slipped in after two arguments: the VM stops reading there
      (c: Hex[]) => {
        const i = depositArgs(c)
        c[i] = `${c[i]!.slice(0, 6)}ff${c[i]!.slice(6, 64)}` as Hex
      },
      // the deposit asking for one atom instead of the balance less the fee
      (c: Hex[], s: Hex[]) => {
        s.push(pad('0x01'))
        const i = depositArgs(c)
        c[i] = setByte(c[i]!, 5, s.length - 1)
      },
      // depositV3 storing its (empty) return value: the VM reverts after the deposit
      (c: Hex[]) => {
        const i = depositArgs(c) - 1
        c[i] = setByte(c[i]!, 11, 0)
      },
      // a relayer that is not an address: the SpokePool cannot decode it
      (c: Hex[], s: Hex[]) => {
        s.push(pad(toHex(2n ** 160n)))
        const i = depositArgs(c)
        c[i] = setByte(c[i]!, 7, s.length - 1)
      },
      // a named relayer with an exclusivity that is not a uint32
      (c: Hex[], s: Hex[]) => {
        s.push(pad(X), pad(toHex(2n ** 32n)))
        const i = depositArgs(c)
        c[i] = setByte(setByte(c[i]!, 7, s.length - 2), 10, s.length - 1)
      },
    ]
    const original = (await hook()).message.calls[1]!.callData
    for (const change of tampered) {
      const td = await edit(change)
      expect(td.message.calls[1]!.callData).not.toBe(original) // the tampering applied
      await expect(sign(account(), td)).rejects.toThrow(REFUSED)
    }
  })
  test('refuses Across terms the SpokePool would reject or relayers could not fill', async () => {
    for (const terms of [
      { timestamp: NOW - 3601 }, // already stale
      { timestamp: NOW + 61 }, // over 60 s ahead of the chain's latest block
      { fillDeadline: NOW - 10 },
      { fillDeadline: NOW + 21_601 }, // beyond the SpokePool's 6 h buffer
      { exclusivity: 60 }, // exclusivity without a relayer
      { exclusivity: 301, relayer: X }, // one relayer alone for more than 5 minutes
      { exclusivity: NOW + 301, relayer: X }, // the same, as a timestamp
    ]) {
      await expect(sign(account(), await hook(terms))).rejects.toThrow(REFUSED)
    }
    expect(await sign(account(), await hook({ exclusivity: 300, relayer: X }))).toMatch(/^0x/)
    expect(await sign(account(), await hook({ timestamp: NOW + 60 }))).toMatch(/^0x/) // an RPC may trail the Across API
    expect(await sign(account(), await hook({ exclusivity: NOW + 30, relayer: X }))).toMatch(/^0x/) // as Ethereum quotes send it
  })
  test('refuses an order that could fill after the Across quote went stale, or too late to be filled', async () => {
    const late = account()
    await sign(late, await hook({ timestamp: NOW - 1000 }))
    await expect(sign(late, order({ validTo: NOW + 2601 }))).rejects.toThrow(REFUSED) // 3601 s after the quote
    const inTime = account()
    await sign(inTime, await hook({ timestamp: NOW - 1000 }))
    expect(await sign(inTime, order({ validTo: NOW + 2600 }))).toBe(WITHHELD)
    const tight = account()
    await sign(tight, await hook())
    await expect(sign(tight, order({ validTo: DEADLINE - 899 }))).rejects.toThrow(REFUSED) // relayers need 15 minutes
  })
  test('refuses an order before the hook, paying elsewhere, selling more, buying another token, or loosened', async () => {
    await expect(sign(account(), order())).rejects.toThrow(REFUSED)
    const a = account()
    await sign(a, await hook())
    for (const change of [
      { receiver: ME }, { sellAmount: 10n ** 15n + 1n }, { buyToken: WETH }, { feeAmount: 1n }, { partiallyFillable: true },
      { sellTokenBalance: 'external' }, { validTo: DEADLINE + 1 }, { buyAmount: MIN_IN - 1n }, // the guard would never pass
    ]) {
      await expect(sign(a, order(change))).rejects.toThrow(REFUSED)
    }
    // A guard for a few atoms: a griefer could pass it for nothing and burn the hook's nonce.
    const weak = account()
    await sign(weak, await hook({ calls: (program) => [guardCall({ amount: 1n }), program] }))
    await expect(sign(weak, order())).rejects.toThrow(REFUSED)
  })
  test('signs one order only', async () => {
    const a = account()
    await sign(a, await hook())
    await sign(a, order())
    await expect(sign(a, order())).rejects.toThrow('already signed')
  })
  test('one request at a time: a second order while the wallet is busy is refused', async () => {
    const a = account()
    await sign(a, await hook())
    const results = await Promise.allSettled([sign(a, order()), sign(a, order())])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  })
  test('signs exactly what it checked, even if the request changes while it is read', async () => {
    const a = account()
    await sign(a, await hook())
    const o = order()
    let reads = 0
    Object.defineProperty(o.message, 'receiver', { enumerable: true, get: () => (reads++ === 0 ? SHED : X) })
    seen.length = 0
    await sign(a, o).catch(() => {})
    expect(seen.map((json) => json.message.receiver)).not.toContain(X) // the wallet never saw another receiver
  })
  test('a hook signed by another key is refused and not remembered', async () => {
    const a = account(walletOf(privateKeyToAccount(generatePrivateKey())))
    asked.length = 0
    await expect(sign(a, await hook())).rejects.toThrow('did not come from your connected address')
    await expect(sign(a, order())).rejects.toThrow('unexpected Order')
    expect(asked).toEqual(['ExecuteHooks']) // the wallet never saw the order
  })
  test('posts only the signed order, carrying exactly the signed bridge step and the Ophis fee, with the real signature', async () => {
    const a = account()
    await sign(a, await hook())
    const step = a.signed.hook!.callData
    const REAL = `0x${'ab'.repeat(65)}` as Hex
    const FACTORY = new CowShedHooks(8453 as never).getFactoryAddress()
    const FEE = buildOphisAppDataPartnerFee(8453, false)
    const good = { partnerFee: FEE, hooks: { post: [{ target: FACTORY, callData: tagAcrossIntegratorCalldata(step), gasLimit: '600000', dappId: 'cow-sdk://bridging/providers/across' }] } }
    const posted: { signature?: string }[] = []
    const post = (meta: object, record?: (hash: Hex) => BridgeSigned, from: string = ME, needs = 290_000n, body: object = {}) => {
      const appData = JSON.stringify({ appCode: 'ophis', metadata: meta })
      const appDataHash = keccak256(toBytes(appData))
      const api = {
        sendOrder: async (b: { signature?: string }) => {
          posted.push(b)
          return 'posted'
        },
      }
      const signedRecord = () => (record ? record(appDataHash) : { hook: { callData: step }, order: { appData: appDataHash, uid: '0x' as Hex, signature: REAL } })
      guardSendOrder(api as never, 8453, ME, signedRecord, async () => needs)
      return (api.sendOrder as (b: unknown) => Promise<string>)({ appData, appDataHash, from, signature: WITHHELD, signingScheme: 'eip712', ...body })
    }
    expect(await post(good)).toBe('posted')
    expect(posted.at(-1)?.signature).toBe(REAL) // only the guard puts the real signature in
    const other = `${step.slice(0, 100)}${step.slice(100, 102) === 'ff' ? '00' : 'ff'}${step.slice(102)}` as Hex // another bridge step
    expect(other).not.toBe(step)
    const refusals: [object, ((hash: Hex) => BridgeSigned)?, string?][] = [
      [{ partnerFee: FEE }], // no bridge step: the order would fill into the shed and bridge nothing
      [{ ...good, hooks: { ...good.hooks, pre: [good.hooks.post[0]] } }],
      [{ ...good, hooks: { post: [...good.hooks.post, ...good.hooks.post] } }],
      [{ ...good, hooks: { post: [{ ...good.hooks.post[0], target: X }] } }],
      [{ ...good, hooks: { post: [{ ...good.hooks.post[0], callData: tagAcrossIntegratorCalldata(other) }] } }],
      [{ ...good, hooks: { post: [{ ...good.hooks.post[0], callData: step }] } }], // untagged: not what the provider sends
      [{ ...good, hooks: { post: [{ ...good.hooks.post[0], callData: `${tagAcrossIntegratorCalldata(step)}${'ab'.repeat(32)}` }] } }], // extra data
      [{ ...good, partnerFee: buildOphisAppDataPartnerFee(8453, true) }],
      [good, () => ({ hook: { callData: step }, order: { appData: `0x${'11'.repeat(32)}`, uid: '0x', signature: REAL } })], // not the order that was signed
      [good, () => ({})], // nothing signed yet
      [good, undefined, X], // not from you
    ]
    for (const [meta, record, from] of refusals) await expect(post(meta, record, from)).rejects.toThrow('refusing to post')
    // Only an order carrying the withheld placeholder, signed the EIP-712 way, gets the real signature.
    await expect(post(good, undefined, ME, 290_000n, { signature: REAL })).rejects.toThrow('refusing to post')
    await expect(post(good, undefined, ME, 290_000n, { signingScheme: 'ethsign' })).rejects.toThrow('refusing to post')
    // Gas: the settlement forwards exactly this to the hook and ignores a hook that fails.
    const gas = (gasLimit: string) => ({ ...good, hooks: { post: [{ ...good.hooks.post[0], gasLimit }] } })
    for (const g of ['0', '289999', 'lots']) await expect(post(gas(g))).rejects.toThrow('refusing to post')
    expect(await post(gas('290000'))).toBe('posted')
    await expect(post(gas('649999'), undefined, ME, 650_000n)).rejects.toThrow('refusing to post') // the shed must be created first
    expect(await post(gas('650000'), undefined, ME, 650_000n)).toBe('posted')
  })
  test('reports the hook the moment it is signed, and signs nothing if it cannot be remembered', async () => {
    const seen: Hex[] = []
    const a = bridgeAccount(wallet, 8453, want, { now: async () => BigInt(NOW), onHookSigned: (callData) => void seen.push(callData) })
    await sign(a, await hook())
    expect(seen).toEqual([a.signed.hook!.callData])
    const full = bridgeAccount(wallet, 8453, want, { now: async () => BigInt(NOW), onHookSigned: () => { throw new Error('disk full') } })
    await expect(sign(full, await hook())).rejects.toThrow('disk full')
  })
  test('refuses a domain with any field beyond the four the contracts sign over: a salted signature fails on-chain', async () => {
    const salted = <T extends { domain: object }>(td: T) => ({ ...td, domain: { ...td.domain, salt: `0x${'01'.repeat(32)}` } })
    await expect(sign(account(), salted(await hook()))).rejects.toThrow(REFUSED)
    const a = account()
    await sign(a, await hook())
    await expect(sign(a, salted(order()))).rejects.toThrow(REFUSED)
  })
  test('refuses when the bridge fee rose after you confirmed', async () => {
    // Already too high when the hook is asked for: nothing is signed, so the SDK has nothing to post.
    await expect(sign(account(), await hook({ pct: 2n * PCT }))).rejects.toThrow('fee rose')
    // Fine on the confirmed minimum, too high on the smaller order the wallet is then asked for: refused at the order.
    const a = bridgeAccount(wallet, 8453, { ...want, viaMin: MIN_IN + 10n, minOut: 999_005n }, { now: async () => BigInt(NOW) })
    await sign(a, await hook())
    await expect(sign(a, order())).rejects.toThrow('fee rose')
  })
})

describe('bridge routes', () => {
  // The token lists as swap.ophis.fi serves them, read from the repo: no network. The MCP module caches each list for
  // the whole run, so every test file serves these same files.
  const realFetch = globalThis.fetch
  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (!u.startsWith('https://swap.ophis.fi/token-lists/')) return new Response('not mocked', { status: 500 })
      return new Response(read(`../../../apps/frontend/apps/cowswap-frontend/public/token-lists/${u.slice(u.lastIndexOf('/') + 1)}`))
    }) as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
  })
  const RPC = 'http://127.0.0.1:9' // never called: the routes are checked against the lists alone
  const [ethereum, arbitrum, base, unichain, robinhood, bnb] = ['ethereum', 'arbitrum', 'base', 'unichain', 'robinhood', 'bnb'].map((c) => network(c, RPC))
  // From apps/frontend/apps/cowswap-frontend/public/token-lists/ophis.json (the Ophis list).
  const LISTED = {
    ethereumUsdt: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 }, // USDT
    arbitrumUsdc: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }, // USDC
    baseUsdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }, // USDC
    baseUsdt: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 }, // USDT
    bnbUsdc: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }, // USDC, with 18 decimals
    unichainUsdt0: { address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6 }, // USDT0
    unichainUsdg: { address: '0x2A22868610610199D43fE93A16661473A9f86f1E', decimals: 6 }, // USDG
    robinhoodUsdg: { address: ROBINHOOD_USDG.address, decimals: 6 }, // USDG
  } as const

  test('every source chain the website enables has pinned Across contracts', () => {
    for (const id of ACROSS_EXECUTABLE_SOURCE_IDS) expect(ACROSS[id]).toBeDefined()
  })
  test('bridges through the same asset as the destination token, as the trusted lists name it', async () => {
    expect((await bridgeVia(base, wrappedNative(base).address, arbitrum, wrappedNative(arbitrum))).symbol).toBe('WETH')
    expect((await bridgeVia(base, LISTED.baseUsdc.address, arbitrum, LISTED.arbitrumUsdc)).symbol).toBe('USDC')
    // Tether's USDT0 on Unichain is USDT, and Robinhood Chain's USDG is reached from USDC: routes Across serves live.
    expect((await bridgeVia(ethereum, LISTED.ethereumUsdt.address, unichain, LISTED.unichainUsdt0)).symbol).toBe('USDT')
    expect((await bridgeVia(base, LISTED.baseUsdc.address, robinhood, LISTED.robinhoodUsdg)).address).toBe(getAddress(LISTED.baseUsdc.address))
    expect((await bridgeVia(robinhood, LISTED.robinhoodUsdg.address, base, LISTED.baseUsdc)).symbol).toBe('USDG') // and back, by the rule
  })
  test('refuses a bridged token Ophis does not trust, or that is another asset than the destination token', async () => {
    const refusals: [() => Promise<unknown>, string][] = [
      [() => bridgeVia(base, '0x1111111111111111111111111111111111111111', arbitrum, LISTED.arbitrumUsdc), 'not on the Ophis token list for Base'],
      [() => bridgeVia(base, LISTED.baseUsdc.address, arbitrum, { address: '0x1111111111111111111111111111111111111111', decimals: 6 }), 'does not match the Ophis token list'],
      [() => bridgeVia(base, LISTED.baseUsdc.address, arbitrum, { ...LISTED.arbitrumUsdc, decimals: 18 }), 'does not match the Ophis token list'], // decimals from the list
      [() => bridgeVia(base, LISTED.baseUsdc.address, unichain, LISTED.unichainUsdt0), 'USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), which is not the same asset as USDT0 on Unichain'],
      [() => bridgeVia(base, LISTED.baseUsdc.address, bnb, LISTED.bnbUsdc), 'not the same asset as USDC on BNB'], // same symbol, other decimals
      [() => bridgeVia(base, LISTED.baseUsdt.address, robinhood, LISTED.robinhoodUsdg), 'not the same asset as USDG'], // the corridor is USDC only
      [() => bridgeVia(base, LISTED.baseUsdc.address, unichain, LISTED.unichainUsdg), 'not the same asset as USDG'], // and Robinhood's USDG only
      [() => bridgeVia(base, wrappedNative(base).address, robinhood, LISTED.robinhoodUsdg), 'not the same asset as USDG'],
    ]
    for (const [check, message] of refusals) await expect(check()).rejects.toThrow(message)
  })
  test('Robinhood Chain is no source the CLI bridges from', async () => {
    const request = { src: robinhood, dst: base, sell: wrappedNative(robinhood), pay: wrappedNative(robinhood), buy: wrappedNative(base), atoms: 1n, owner: '0x2222222222222222222222222222222222222222', slippage: 50 }
    await expect(bridgeQuote(request as never)).rejects.toThrow('Bridging can start from Ethereum, Arbitrum or Base for now (not Robinhood')
  })
})
