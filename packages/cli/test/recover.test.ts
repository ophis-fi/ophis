import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { getGlobalAdapter, setGlobalAdapter } from '@cowprotocol/cow-sdk'
import { CowShedHooks } from '@cowprotocol/sdk-cow-shed'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { getOphisOrderbookUrl, getOphisOrderDomain, NATIVE_TOKEN_SENTINEL } from '@ophis/sdk'
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, http, multicall3Abi, numberToHex, pad, parseAbi, recoverTypedDataAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { bridgeStatus, checkEarlierHooks, checkLeftover, openBridge, placeBridge, saidStatus, same, shedOf } from '../src/bridge.ts'
import { network } from '../src/network.ts'
import type { Signer, TypedDataJson } from '../src/phone.ts'
import { checkRecovery, recover, recoveryCalls, shedHoldings, signRecovery, type Holding, type Recovery, type ShedCall } from '../src/recover.ts'
import { findToken, priceTx, sendTx, status, type Token } from '../src/trade.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Runs with this SDK adapter (none: a fresh process), then puts the previous one back for the other tests. */
async function withAdapter(adapter: unknown, run: () => Promise<void> | void) {
  const before = (() => {
    try {
      return getGlobalAdapter()
    } catch {
      return undefined
    }
  })()
  setGlobalAdapter(adapter as never)
  try {
    await run()
  } finally {
    setGlobalAdapter(before as never)
  }
}

/** Answers HTTP paths (an answer can depend on the URL) and JSON-RPC methods from tables; anything else fails loudly. */
function serve(rpc: Record<string, (params: unknown[]) => unknown>, paths: Record<string, unknown> = {}) {
  const seen: string[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    seen.push(u)
    const path = Object.keys(paths).find((p) => u.includes(p))
    if (path) {
      const answer = paths[path]
      if (answer instanceof Response) return answer.clone() // a status other than 200
      return Response.json(typeof answer === 'function' ? answer(u) : answer)
    }
    const { id, method, params } = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string; params: unknown[] }
    seen.push(method)
    if (!rpc[method]) return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `not mocked: ${method}` } })
    try {
      return Response.json({ jsonrpc: '2.0', id, result: rpc[method]!(params) })
    } catch (error) {
      return Response.json({ jsonrpc: '2.0', id, error })
    }
  }) as typeof fetch
  return seen
}

// The token lists as swap.ophis.fi serves them, read from the repo: no network. The MCP module caches each list for
// the whole run, so every test file serves these same files.
const LISTS = {
  'https://swap.ophis.fi/token-lists/': (u: string) =>
    JSON.parse(readFileSync(new URL(`../../../apps/frontend/apps/cowswap-frontend/public/token-lists/${u.slice(u.lastIndexOf('/') + 1)}`, import.meta.url), 'utf8')),
}

const X: Address = '0x2222222222222222222222222222222222222222'
const USDC: Token = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, native: false, listed: true }
const WETH: Token = { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, native: false, listed: true }
const ETH: Token = { address: NATIVE_TOKEN_SENTINEL as Address, symbol: 'ETH', decimals: 18, native: true, listed: true }
const transfer = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })

describe('the CoW Shed address', () => {
  test('shedOf is the SDK proxyOf for any owner, on any chain', async () => {
    const owners = [...Array(5)].map(() => privateKeyToAccount(generatePrivateKey()).address)
    await withAdapter(new ViemAdapter({ provider: createPublicClient({ transport: http('http://127.0.0.1:1') }) as never }), () => {
      for (const owner of owners) {
        for (const chainId of [1, 8453, 42161]) expect(shedOf(owner)).toBe(getAddress(new CowShedHooks(chainId as never).proxyOf(owner)))
        expect(shedOf(owner.toLowerCase() as Address)).toBe(shedOf(owner))
      }
    })
  })
  test('ophis status and the open-bridge check find your shed in a fresh process (no SDK adapter set yet)', async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const shed = shedOf(owner).toLowerCase() // the orderbook answers in lowercase
    const uid = `0x${'ab'.repeat(56)}`
    const bridging = { providerId: 'cow-sdk://bridging/providers/across', destinationChainId: 42161, destinationTokenAddress: USDC.address }
    const seen = serve({}, {
      [`${getOphisOrderbookUrl(8453)}/api/v1/account/`]: [{ uid, status: 'open', receiver: shed }],
      [`/api/v1/orders/${uid}`]: { owner: owner.toLowerCase(), receiver: shed, buyToken: USDC.address, fullAppData: JSON.stringify({ metadata: { bridging } }) },
      '/api/v1/trades': [], // not settled yet
    })
    await withAdapter(undefined, async () => {
      expect((await openBridge(network('base'), owner)).open).toBe(uid)
      expect(await bridgeStatus(network('base'), uid)).toBeUndefined()
    })
    expect(seen.some((u) => u.includes(`/api/v1/trades?orderUid=${uid}`))).toBe(true) // it got past the shed check
  })
  test('the open-bridge check reads past the first page, and goes ahead with a note past 1,000 orders', async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const shed = shedOf(owner).toLowerCase()
    // Anyone can list pre-sign orders "from" a wallet: a page of them must not hide the open bridge behind it.
    const listed = [...Array(100)].map((_, i) => ({ uid: `0x${i}`, status: 'presignaturePending', receiver: shed }))
    const ORDERS = `${getOphisOrderbookUrl(8453)}/api/v1/account/`
    serve({}, { [ORDERS]: (u: string) => (u.includes('offset=0&') ? listed : [{ uid: '0xopen', status: 'open', receiver: shed }]) })
    expect((await openBridge(network('base'), owner)).open).toBe('0xopen')
    // The orderbook's text reaches the terminal stripped of control characters (no escape sequences).
    serve({}, { [ORDERS]: () => [{ uid: '0x\u001b[2J\u001b]0;owned\u0007open', status: 'open', receiver: shed }] })
    expect((await openBridge(network('base'), owner)).open).toBe('0x[2J]0;ownedopen')
    // Past 1,000 orders it goes ahead with a note: refusing would let that listing block the wallet's bridges for good.
    const seen = serve({}, { [ORDERS]: () => listed })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect((await openBridge(network('base'), owner)).open).toBeUndefined()
      expect(log.mock.calls.flat().join('\n')).toContain('only the newest 1,000 were checked')
    } finally {
      log.mockRestore()
    }
    expect(seen.filter((u) => u.includes('/orders?offset=')).length).toBe(10)
  })
  test('a bridge stuck in your shed says how to recover it, naming the token; someone else\'s does not', () => {
    const base = network('base')
    for (const status of ['expired', 'not_deposited', 'refund']) {
      expect(saidStatus(status, base, X, USDC.address)).toContain(`with: ophis recover ${USDC.address} on base`)
      expect(saidStatus(status, base, X, USDC.address, false)).not.toContain('recover')
    }
    expect(saidStatus('expired', base, X, USDC.address)).toContain('Once the refund arrives, recover it with')
    expect(saidStatus('executed', base, X, USDC.address)).not.toContain('recover')
  })
  test('ophis status names the token the bridge carried, so recovering it never depends on finding the order again', async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const shed = shedOf(owner).toLowerCase() // the orderbook answers in lowercase
    const [uid, tx] = [`0x${'cd'.repeat(56)}`, `0x${'ef'.repeat(32)}`]
    const bridging = { providerId: 'cow-sdk://bridging/providers/across', destinationChainId: 42161, destinationTokenAddress: USDC.address }
    const TRADE = parseAbi(['event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)'])
    const trade = (orderUid: string, address: Address = getOphisOrderDomain(8453).verifyingContract as Address) => ({
      address, topics: encodeEventTopics({ abi: TRADE, eventName: 'Trade', args: { owner } }),
      data: encodeAbiParameters(TRADE[0].inputs.slice(1), [X, USDC.address, 1n, 1n, 0n, orderUid as Hex]),
      blockNumber: '0x10', blockHash: `0x${'11'.repeat(32)}`, transactionHash: tx, transactionIndex: '0x0', logIndex: '0x0', removed: false,
    })
    // The settlement paying the order's output into the shed, before any post-hook runs.
    const paidOut = {
      address: USDC.address, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: getOphisOrderDomain(8453).verifyingContract as Address, to: getAddress(shed) } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [25_000_000n]),
      blockNumber: '0x10', blockHash: `0x${'11'.repeat(32)}`, transactionHash: tx, transactionIndex: '0x0', logIndex: '0x0', removed: false,
    }
    const settled = (logs: unknown[]) =>
      serve(
        { eth_getTransactionReceipt: () => ({ transactionHash: tx, blockNumber: '0x10', blockHash: `0x${'11'.repeat(32)}`, status: '0x1', logs }) }, // no deposit
        {
          [`/api/v1/orders/${uid}`]: { owner: owner.toLowerCase(), receiver: shed, buyToken: USDC.address.toLowerCase(), fullAppData: JSON.stringify({ metadata: { bridging } }) },
          '/api/v1/trades': [{ txHash: tx }],
        },
      )
    await withAdapter(undefined, async () => {
      settled([trade(uid), paidOut])
      const leg = await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid)
      expect(leg).toEqual({ status: 'not_deposited', shed: getAddress(shed), owner, token: USDC.address })
      expect(saidStatus(leg!.status, network('base'), leg!.shed, leg!.token)).toContain(`Recover them with: ophis recover ${USDC.address} on base`)
      // The orderbook names a transaction that did not settle this order (another order, or another contract): unknown.
      for (const logs of [[], [trade(`0x${'ab'.repeat(56)}`)], [trade(uid, X)]]) {
        settled(logs)
        expect(await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid)).toBeUndefined()
      }
      // A deposit counts only if it pulled its input out of the shed: anyone can name the shed as depositor.
      const SPOKE = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64' // Across SpokePool on Base
      const FUNDS = parseAbi(['event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)'])
      const meta = { blockNumber: '0x10', blockHash: `0x${'11'.repeat(32)}`, transactionHash: tx, transactionIndex: '0x0', logIndex: '0x1', removed: false }
      const deposit = (input: bigint) => ({
        address: SPOKE, ...meta,
        topics: encodeEventTopics({ abi: FUNDS, eventName: 'FundsDeposited', args: { destinationChainId: 42161n, depositId: 7n, depositor: pad(shed as Hex) } }),
        data: encodeAbiParameters(FUNDS[0].inputs.filter((i) => !('indexed' in i && i.indexed)), [pad(USDC.address), pad(USDC.address), input, input, 0, 0, 0, pad(owner), pad('0x0'), '0x']),
      })
      const pulled = (value: bigint, from: Address = getAddress(shed)) => ({
        address: USDC.address, ...meta,
        topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to: SPOKE } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [value]),
      })
      for (const logs of [[trade(uid), paidOut, deposit(1n)], [trade(uid), paidOut, pulled(25_000_000n), deposit(1n)], [trade(uid), paidOut, pulled(1n, X), deposit(1n)]]) {
        settled(logs)
        expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('not_deposited')
      }
      // The shed's own deposit: its status is Across's for that deposit id.
      const asked: string[] = []
      const settledAndFilled = (logs: unknown[]) =>
        serve(
          { eth_getTransactionReceipt: () => ({ transactionHash: tx, blockNumber: '0x10', blockHash: `0x${'11'.repeat(32)}`, status: '0x1', logs }) },
          {
            [`/api/v1/orders/${uid}`]: { owner: owner.toLowerCase(), receiver: shed, buyToken: USDC.address.toLowerCase(), fullAppData: JSON.stringify({ metadata: { bridging } }) },
            '/api/v1/trades': [{ txHash: tx }],
            '/deposit/status': (u: string) => (asked.push(u), { status: 'filled', depositTxHash: tx, fillTx: `0x${'fe'.repeat(32)}` }),
          },
        )
      settledAndFilled([trade(uid), paidOut, pulled(25_000_000n), deposit(25_000_000n)])
      expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('executed')
      expect(asked.length === 1 && asked[0]!.includes('depositId=7')).toBe(true)
      // A zero "transfer" out of the shed needs no allowance, so a zero deposit next to it cannot blur the real one.
      const zero = { ...deposit(0n), topics: encodeEventTopics({ abi: FUNDS, eventName: 'FundsDeposited', args: { destinationChainId: 42161n, depositId: 8n, depositor: pad(shed as Hex) } }) }
      settledAndFilled([trade(uid), paidOut, pulled(0n), zero, pulled(25_000_000n), deposit(25_000_000n)])
      expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('executed')
      expect(asked.at(-1)).toContain('depositId=7')
      // An equal deposit someone pays from their own funds, naming the shed (to them, or to the owner): not the shed's.
      const decoy = (to: Address) => ({
        ...deposit(25_000_000n),
        topics: encodeEventTopics({ abi: FUNDS, eventName: 'FundsDeposited', args: { destinationChainId: 42161n, depositId: 9n, depositor: pad(shed as Hex) } }),
        data: encodeAbiParameters(FUNDS[0].inputs.filter((i) => !('indexed' in i && i.indexed)), [pad(USDC.address), pad(USDC.address), 25_000_000n, 25_000_000n, 0, 0, 0, pad(to), pad('0x0'), '0x']),
      })
      // A token can log another transfer between a deposit's pull and its event (a fee): the pull is still found.
      const fee = { ...pulled(1n), topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: getAddress(shed), to: X } }) }
      settledAndFilled([trade(uid), paidOut, pulled(25_000_000n), fee, deposit(25_000_000n)])
      expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('executed')
      for (const extra of [[pulled(25_000_000n, X), decoy(X)], [pulled(25_000_000n, X), decoy(owner)], [decoy(owner)]]) {
        settledAndFilled([trade(uid), paidOut, pulled(25_000_000n), deposit(25_000_000n), ...extra])
        expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('executed')
        expect(asked.at(-1)).toContain('depositId=7')
      }
      // Another signed hook of this wallet someone ran before the payout (a pre-hook), or after this one: the order's
      // deposit is the first after the payout. With no payout to the shed, it is not this order's settlement.
      const funded = { ...paidOut, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: X, to: getAddress(shed) } }) } // them funding its guard
      const early = [funded, pulled(10n), { ...decoy(owner), data: encodeAbiParameters(FUNDS[0].inputs.filter((i) => !('indexed' in i && i.indexed)), [pad(USDC.address), pad(USDC.address), 10n, 10n, 0, 0, 0, pad(owner), pad('0x0'), '0x']) }]
      for (const logs of [[...early, trade(uid), paidOut, pulled(25_000_000n), deposit(25_000_000n)], [trade(uid), paidOut, pulled(25_000_000n), deposit(25_000_000n), ...early]]) {
        settledAndFilled(logs)
        expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('executed')
        expect(asked.at(-1)).toContain('depositId=7')
      }
      settled([trade(uid), pulled(25_000_000n), deposit(25_000_000n)])
      expect(await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid)).toBeUndefined()
      // A payout into the shed with no Trade for this order: another order's settlement.
      settled([trade(`0x${'ab'.repeat(56)}`), paidOut, pulled(25_000_000n), deposit(25_000_000n)])
      expect(await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid)).toBeUndefined()
      // The payout is the settlement's non-zero transfer after the order's Trade: a zero one (no allowance needed), or
      // one before the Trade (a pre-interaction), does not let an earlier deposit count.
      const paid = (value: bigint) => ({ ...paidOut, data: encodeAbiParameters([{ type: 'uint256' }], [value]) })
      for (const before of [[trade(uid), paid(0n)], [paid(5n), trade(uid)], [trade(uid), funded]]) {
        settledAndFilled([...before, ...early.slice(1), paidOut, pulled(25_000_000n), deposit(25_000_000n)])
        expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('executed')
        expect(asked.at(-1)).toContain('depositId=7')
      }
      // A signed hook that bridged the shed to another chain, then a deposit with no pull of its own (WETH paid in
      // native ETH logs none) naming the shed: it cannot borrow that hook's pull.
      const elsewhere = { ...deposit(25_000_000n), topics: encodeEventTopics({ abi: FUNDS, eventName: 'FundsDeposited', args: { destinationChainId: 10n, depositId: 30n, depositor: pad(shed as Hex) } }) }
      settled([trade(uid), paidOut, pulled(25_000_000n), elsewhere, decoy(owner)])
      expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('not_deposited')
      // Pulled out of the shed but paying someone else: not what the signed hook does.
      settled([trade(uid), paidOut, pulled(25_000_000n), decoy(X)])
      expect((await bridgeStatus(network('base', 'http://127.0.0.1:9'), uid))?.status).toBe('not_deposited')
    })
  })
  test('a bridge signed elsewhere (the website, another machine) blocks a new one while its hook could run, even once cancelled', async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const shed = shedOf(owner).toLowerCase()
    const base = network('base', 'http://127.0.0.1:9')
    const NOW = 1_000_000n
    const FACTORY = parseAbi(['function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature)'])
    const appData = (nonce: Hex, deadline: bigint) =>
      JSON.stringify({ metadata: { hooks: { post: [{ callData: encodeFunctionData({ abi: FACTORY, functionName: 'executeHooks', args: [[], nonce, deadline, owner, '0x'] }) }] } } })
    const [live, listedByAnyone, ran] = (['a1', 'a2', 'a3'] as const).map((b) => `0x${b.repeat(32)}` as Hex)
    let orders = [
      { uid: '0x1', status: 'expired', signingScheme: 'presign', receiver: shed, fullAppData: appData(listedByAnyone, NOW + 600n) },
      { uid: '0x2', status: 'fulfilled', signingScheme: 'eip712', receiver: shed, fullAppData: appData(ran, NOW + 600n) },
      { uid: '0x3', status: 'expired', signingScheme: 'eip712', receiver: shed, fullAppData: appData(live, NOW) },
      { uid: '0x4', status: 'cancelled', signingScheme: 'eip712', receiver: shed, fullAppData: '{ not json' },
    ]
    serve(
      {
        eth_chainId: () => numberToHex(8453),
        eth_getBlockByNumber: () => ({ number: '0x20', hash: `0x${'11'.repeat(32)}`, timestamp: numberToHex(NOW), transactions: [] }),
        eth_call: ([call]) => pad((call as { data: Hex }).data.includes(ran.slice(2)) ? '0x1' : '0x0'), // nonces(nonce): only that one ran
      },
      { [`${getOphisOrderbookUrl(8453)}/api/v1/account/`]: () => orders },
    )
    const check = async () => {
      const { open, hooks } = await openBridge(base, owner)
      expect(open).toBeUndefined()
      await checkEarlierHooks(base, owner, false, hooks)
    }
    // A pre-sign order anyone could list, a hook that ran, one that expired, appData that is no hook: none blocks.
    await check()
    // A cancelled bridge whose hook could still run does, though this CLI never signed it.
    orders = [...orders, { uid: '0x5', status: 'cancelled', signingScheme: 'eip712', receiver: shed, fullAppData: appData(live, NOW + 600n) }]
    await expect(check()).rejects.toThrow('could still run')
  })
  test('no bridge starts while a hook this CLI placed on that chain could still run, whatever the orderbook lists', async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const base = network('base', 'http://127.0.0.1:9')
    const NOW = 1_000_000n
    const FACTORY = parseAbi(['function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature)'])
    const nonce = `0x${'c1'.repeat(32)}` as Hex
    const callData = encodeFunctionData({ abi: FACTORY, functionName: 'executeHooks', args: [[], nonce, NOW + 1_800n, owner, '0x'] })
    const uid = `0x${'d1'.repeat(56)}`
    let used = false
    const asked: string[] = []
    let chain = 8453
    serve(
      {
        eth_chainId: () => numberToHex(chain),
        eth_getBlockByNumber: () => ({ number: '0x20', hash: `0x${'11'.repeat(32)}`, timestamp: numberToHex(NOW), transactions: [] }),
        eth_call: ([call]) => {
          const { to, data } = call as { to: Address; data: Hex }
          if (!same(to, shedOf(owner))) return pad('0x0') // the shed's balance: empty
          asked.push(data)
          return pad(used ? '0x1' : '0x0') // nonces(nonce)
        },
      },
      { [`${getOphisOrderbookUrl(8453)}/api/v1/account/`]: [] },
    )
    // A bridge: its hook is public from the moment it is signed (the SDK uploads it with the appData, before the order).
    type Opts = { onOrderSigned: (uid: string) => void; onHookSigned: (callData: Hex) => void }
    const quote = {
      src: base, owner, via: USDC, guard: 25_000_000n,
      arm: (_wallet: unknown, opts: Opts) => void (opts.onHookSigned(callData), opts.onOrderSigned(uid)),
      quote: { postSwapOrderFromQuote: async () => ({ orderId: uid }) },
    }
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const write = spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect((await placeBridge(quote as never, { address: owner } as never)).uid).toBe(uid)
    } finally {
      log.mockRestore()
      write.mockRestore()
    }
    await expect(checkEarlierHooks(base, owner)).rejects.toThrow('could still run')
    expect(asked.some((data) => data.includes(nonce.slice(2)))).toBe(true)
    // A second bridge is refused before anything is armed or signed.
    let armed = false
    await expect(placeBridge({ ...quote, arm: () => void (armed = true) } as never, { address: owner } as never)).rejects.toThrow('could still run')
    expect(armed).toBe(false)
    // Its nonce used (the hook ran): no longer a block, but kept until its deadline (a reorg could undo the use).
    used = true
    await checkEarlierHooks(base, owner)
    const stored = () => JSON.parse(readFileSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, 'utf8'))[getAddress(owner)]
    expect(stored()).toEqual([{ chainId: 8453, nonce, deadline: String(NOW + 1_800n) }])
    // An RPC for another chain is refused before it can count anything as used or expired.
    chain = 1
    await expect(checkEarlierHooks(base, owner)).rejects.toThrow('different chain')
    chain = 8453
    // An expired record, or one for another chain, is not read; only the latter is kept.
    const other = { chainId: 10, nonce, deadline: String(NOW + 999n) }
    writeFileSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, JSON.stringify({ [getAddress(owner)]: [{ chainId: 8453, nonce, deadline: String(NOW) }, other] }))
    asked.length = 0
    await checkEarlierHooks(base, owner)
    expect(asked).toEqual([])
    expect(stored()).toHaveLength(2) // only a run holding the bridge lock prunes
    await checkEarlierHooks(base, owner, true)
    expect(stored()).toEqual([other])
    // Only expired records go: a used one on the same chain stays until its deadline.
    const ran = { chainId: 8453, nonce, deadline: String(NOW + 600n) }
    writeFileSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, JSON.stringify({ [getAddress(owner)]: [{ chainId: 8453, nonce: `0x${'e2'.repeat(32)}`, deadline: String(NOW) }, ran] }))
    await checkEarlierHooks(base, owner, true)
    expect(stored()).toEqual([ran])
    // A deadline no hook signed now can have (past two hours) is not one of this CLI's records.
    writeFileSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, JSON.stringify({ [getAddress(owner)]: [{ ...ran, deadline: String(NOW + 365n * 86_400n) }] }))
    await expect(checkEarlierHooks(base, owner)).rejects.toThrow('cannot be read')
    // Records it cannot read (corrupt, malformed, or not readable) are not taken for none.
    writeFileSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, JSON.stringify({ [getAddress(owner)]: [{ ...ran, chainId: '8453' }] }))
    await expect(checkEarlierHooks(base, owner)).rejects.toThrow('cannot be read')
    writeFileSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, '{ not json')
    await expect(checkEarlierHooks(base, owner)).rejects.toThrow('cannot be read')
    chmodSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, 0o000)
    try {
      await expect(checkEarlierHooks(base, owner)).rejects.toThrow('cannot be read')
    } finally {
      chmodSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, 0o600)
    }
    writeFileSync(`${process.env.OPHIS_HOME}/bridge-hooks.json`, '{}')
    // One placement at a time: a lock that is there refuses (never taken over), naming the file to remove.
    const lock = `${process.env.OPHIS_HOME}/bridge.lock`
    writeFileSync(lock, '2147483646')
    await expect(placeBridge(quote as never, { address: owner } as never)).rejects.toThrow(`If none is running, remove ${lock}`)
    unlinkSync(lock)
    const quiet = [spyOn(console, 'log').mockImplementation(() => {}), spyOn(process.stdout, 'write').mockImplementation(() => true)]
    try {
      expect((await placeBridge(quote as never, { address: owner } as never)).uid).toBe(uid)
    } finally {
      for (const spy of quiet) spy.mockRestore()
    }
    expect(existsSync(lock)).toBe(false)
  })
  test('no bridge starts while your CoW Shed still holds a tenth of what the guard asks, but dust is no block', async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const base = network('base', 'http://127.0.0.1:9')
    const reads: { to?: string; data?: Hex }[] = []
    let held = 5_000_000n
    serve({ eth_call: ([call]) => (reads.push(call as never), pad(numberToHex(held))) }, { [`${getOphisOrderbookUrl(8453)}/api/v1/account/`]: [] })
    const leftover = `Your CoW Shed still holds 5 USDC from an earlier bridge. Recover it first: ophis recover ${USDC.address} on base`
    const GUARD = 25_000_000n // a 25 USDC bridge: a leftover of 2.5 USDC or more must be recovered first
    await expect(checkLeftover(base, owner, USDC, GUARD)).rejects.toThrow(leftover)
    expect([getAddress(reads[0]!.to!), decodeFunctionData({ abi: erc20Abi, data: reads[0]!.data! }).args]).toEqual([USDC.address, [shedOf(owner)]]) // the shed's, not yours
    // placeBridge checks again (a refreshed price may carry another token), before anything is armed or signed.
    let armed = false
    const quote = { src: base, owner, via: USDC, guard: GUARD, arm: () => void (armed = true) }
    await expect(placeBridge(quote as never, { address: owner } as never)).rejects.toThrow(leftover)
    expect(armed).toBe(false)
    held = 2_500_000n // exactly a tenth
    await expect(checkLeftover(base, owner, USDC, GUARD)).rejects.toThrow('still holds 2.5 USDC')
    held = 2_499_999n // dust anyone could send: bridged along, never a block
    expect(await checkLeftover(base, owner, USDC, GUARD)).toBeUndefined()
    held = 0n
    expect(await checkLeftover(base, owner, USDC, GUARD)).toBeUndefined()
    // And the bridge command checks before it pays for any wrap or approval (no wallet can be driven from here).
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const at = main.indexOf('await checkLeftover(src, owner, bridge.via, bridge.guard)')
    expect(at).toBeGreaterThan(main.indexOf('const open = await openBridge(src, owner)'))
    expect(at).toBeLessThan(main.indexOf('await checkFunds(funding)'))
  })
})

describe('recover: only payments of your own shed holdings to you reach the wallet', () => {
  const key = privateKeyToAccount(generatePrivateKey()) // the test plays the user's wallet app
  const ME = key.address
  const SHED = shedOf(ME)
  const HOLDINGS: Holding[] = [
    { token: USDC, balance: 25_000_000n },
    { token: ETH, balance: 10n ** 16n },
  ]
  // The CoW Shed 1.0.1 signing types, written out here rather than imported from what is being checked.
  const TYPES = {
    ExecuteHooks: [{ name: 'calls', type: 'Call[]' }, { name: 'nonce', type: 'bytes32' }, { name: 'deadline', type: 'uint256' }],
    Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }, { name: 'allowFailure', type: 'bool' }, { name: 'isDelegateCall', type: 'bool' }],
  }
  const recovery = (calls: ShedCall[], o: { domain?: object; types?: Recovery['types']; primaryType?: string } = {}): Recovery => ({
    domain: { name: 'COWShed', version: '1.0.1', chainId: 8453, verifyingContract: SHED, ...o.domain },
    types: o.types ?? TYPES,
    primaryType: o.primaryType ?? 'ExecuteHooks',
    message: { calls, nonce: `0x${'ab'.repeat(32)}`, deadline: 2_000_000_000n },
  })
  const [usdc, eth] = recoveryCalls(ME, HOLDINGS) as [ShedCall, ShedCall]
  const REFUSED = 'Refusing to sign'

  /** A wallet app: signs the eth_signTypedData_v4 JSON it is shown, answering with v = 0 or 1 as some wallets do. */
  const walletOf = (signer: PrivateKeyAccount, asked: TypedDataJson[] = []): Signer => ({
    address: ME,
    sendTransaction: async () => {
      throw new Error('not used')
    },
    signTypedData: async (_chain, shown) => {
      const json = JSON.parse(JSON.stringify(shown)) as TypedDataJson // what crosses WalletConnect: plain JSON
      asked.push(json)
      const { EIP712Domain: _domain, ...types } = json.types
      const typed = (type: string, value: unknown): unknown => {
        if (type.endsWith('[]')) return (value as unknown[]).map((v) => typed(type.slice(0, -2), v))
        if (types[type]) return Object.fromEntries(types[type]!.map((f) => [f.name, typed(f.type, (value as Record<string, unknown>)[f.name])]))
        return /^u?int\d*$/.test(type) ? BigInt(String(value)) : value
      }
      const signature = await signer.signTypedData({ domain: json.domain, types, primaryType: json.primaryType, message: typed(json.primaryType, json.message) } as never)
      return `${signature.slice(0, -2)}${signature.endsWith('1b') ? '00' : '01'}` as Hex
    },
  })

  test('one call per holding: the token pays you its balance, the coin comes to you with no data', () => {
    expect(usdc).toEqual({ target: USDC.address, value: 0n, callData: transfer(ME, 25_000_000n), allowFailure: false, isDelegateCall: false })
    expect(usdc.callData.slice(0, 10)).toBe('0xa9059cbb') // transfer(address,uint256)
    expect(eth).toEqual({ target: ME, value: 10n ** 16n, callData: '0x', allowFailure: false, isDelegateCall: false })
    expect(() => checkRecovery(recovery([usdc, eth]), 8453, ME, HOLDINGS)).not.toThrow()
    expect(() => checkRecovery(recovery([eth, usdc]), 8453, ME, HOLDINGS)).not.toThrow() // any order
  })
  test('refuses anything else, before the wallet sees it', () => {
    const cases: [string, Recovery][] = [
      ['another signing domain', recovery([usdc, eth], { domain: { name: 'COWShed2' } })],
      ['another shed version', recovery([usdc, eth], { domain: { version: '1.0.0' } })],
      ['another chain', recovery([usdc, eth], { domain: { chainId: 1 } })],
      ['a shed that is not yours', recovery([usdc, eth], { domain: { verifyingContract: X } })],
      ['other types', recovery([usdc, eth], { types: { ...TYPES, Call: [...TYPES.Call].reverse() } })],
      ['another primary type', recovery([usdc, eth], { primaryType: 'Call' })],
      ['a token paid to someone else', recovery([{ ...usdc, callData: transfer(X, 25_000_000n) }, eth])],
      ['the coin paid to someone else', recovery([usdc, { ...eth, target: X }])],
      ['more than the token balance', recovery([{ ...usdc, callData: transfer(ME, 25_000_001n) }, eth])],
      ['more than the coin balance', recovery([usdc, { ...eth, value: 10n ** 16n + 1n }])],
      ['a delegatecall', recovery([{ ...usdc, isDelegateCall: true }, eth])],
      ['a call allowed to fail', recovery([usdc, { ...eth, allowFailure: true }])],
      ['a token the shed does not hold', recovery([usdc, eth, { ...usdc, target: WETH.address, callData: transfer(ME, 1n) }])],
      ['the same holding twice', recovery([usdc, eth, { ...usdc, callData: transfer(ME, 1n) }])],
      ['a transfer that also sends the coin', recovery([{ ...usdc, value: 1n }, eth])],
      ['data appended to a transfer', recovery([{ ...usdc, callData: `${usdc.callData}00` }, eth])],
      ['another token function', recovery([{ ...usdc, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [ME, X, 1n] }) }, eth])],
    ]
    for (const [why, td] of cases) {
      let error: unknown
      try {
        checkRecovery(td, 8453, ME, HOLDINGS)
      } catch (err) {
        error = err
      }
      expect([why, String(error)]).toEqual([why, expect.stringContaining(REFUSED)])
    }
  })
  test('the wallet signs only a checked recovery, and the signature is normalized and must be yours', async () => {
    const asked: TypedDataJson[] = []
    const td = recovery([usdc, eth])
    const signature = await signRecovery(walletOf(key, asked), 8453, td, HOLDINGS)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.types.EIP712Domain).toBeDefined() // eth_signTypedData_v4 form
    expect(asked[0]!.message.calls).toEqual([
      { target: USDC.address, value: '0', callData: usdc.callData, allowFailure: false, isDelegateCall: false },
      { target: ME, value: String(10n ** 16n), callData: '0x', allowFailure: false, isDelegateCall: false },
    ] as never)
    expect(signature.slice(-2)).toMatch(/^1[bc]$/) // the wallet answered v = 0/1, which a shed rejects
    expect(getAddress(await recoverTypedDataAddress({ ...td, signature } as never))).toBe(ME)
    asked.length = 0
    await expect(signRecovery(walletOf(key, asked), 8453, recovery([usdc, { ...eth, target: X }]), HOLDINGS)).rejects.toThrow(REFUSED)
    expect(asked).toEqual([]) // never shown to the wallet
    await expect(signRecovery(walletOf(privateKeyToAccount(generatePrivateKey())), 8453, td, HOLDINGS)).rejects.toThrow('did not come from your connected address')
  })
})

describe('reading the chain before asking anything (RPC answered here)', () => {
  const RPC = 'http://127.0.0.1:9' // never reached: fetch is answered by serve()
  const OWNER = privateKeyToAccount(generatePrivateKey()).address
  const ORACLE = parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)'])
  const block = { number: '0x10', hash: `0x${'11'.repeat(32)}`, timestamp: '0x64', baseFeePerGas: numberToHex(10n ** 9n), transactions: [] }
  const chain = (id: number) => () => numberToHex(id)
  const answers = (o: Record<string, (params: unknown[]) => unknown> = {}) => ({
    eth_chainId: chain(8453),
    eth_getTransactionCount: () => '0x5',
    eth_estimateGas: () => numberToHex(100_000),
    eth_getBlockByNumber: () => block,
    eth_maxPriorityFeePerGas: () => '0x1',
    eth_call: () => pad(numberToHex(1000)), // the L1 gas oracle
    eth_getBalance: () => numberToHex(10n ** 18n),
    ...o,
  })
  const tx = { to: X, data: '0x12345678' as Hex, value: 0n }

  test('prices one transaction like checkFunds: gas plus 20%, pinned fees, the L1 fee on OP-stack chains', async () => {
    const calls: { to?: string; data?: Hex }[] = []
    serve(answers({ eth_call: ([call]) => (calls.push(call as never), pad(numberToHex(1000))) }))
    const priced = await priceTx(network('base', RPC), OWNER, tx)
    expect(priced.gas).toBe(120_000n)
    expect(priced.fees).toEqual({ maxFeePerGas: 2n * 10n ** 9n + 1n, maxPriorityFeePerGas: 1n }) // 2 x base fee + tip
    expect(priced.maxFee).toBe(120_000n * (2n * 10n ** 9n + 1n) + 1000n)
    expect(priced.feeText).toStartWith('about ')
    expect(getAddress(calls[0]!.to!)).toBe('0x420000000000000000000000000000000000000F')
    expect(decodeFunctionData({ abi: ORACLE, data: calls[0]!.data! }).args[0]).toBe(4n + 100n) // the calldata, plus room for the rest
    serve(answers({ eth_chainId: chain(1) }))
    expect((await priceTx(network('ethereum', RPC), OWNER, tx)).feeText).toStartWith('at most ')
  })
  test('refuses a transaction that would fail, a busy wallet, the wrong chain or too little gas money', async () => {
    const refusals: [Record<string, (params: unknown[]) => unknown>, string][] = [
      [{ eth_estimateGas: () => { throw { code: 3, message: 'execution reverted: custom error 0x6ae7524e', data: '0x6ae7524e' } } }, 'would fail on-chain'],
      [{ eth_estimateGas: () => { throw { code: -32000, message: 'header not found' } } }, 'Could not estimate'], // not a revert
      [{ eth_getTransactionCount: ([, tag]) => (tag === 'pending' ? '0x6' : '0x5') }, 'still waiting'],
      [{ eth_chainId: chain(1) }, 'different chain'],
      [{ eth_getBalance: () => numberToHex(120_000n * (2n * 10n ** 9n + 1n)) }, 'Not enough ETH'], // the L1 fee is not covered
    ]
    for (const [change, message] of refusals) {
      serve(answers(change))
      await expect(priceTx(network('base', RPC), OWNER, tx)).rejects.toThrow(message)
    }
  })
  test('looks for a shed only on the chain asked for, and only where CoW Shed exists', async () => {
    serve(answers({ eth_chainId: chain(1) }))
    await expect(shedHoldings(network('base', RPC), OWNER)).rejects.toThrow('different chain')
    serve(answers({ eth_getCode: () => '0x' }))
    await expect(shedHoldings(network('base', RPC), OWNER)).rejects.toThrow('CoW Shed is not deployed on Base')
  })
  test('a transaction your wallet cancels or replaces is not taken for the one sent; a sped-up one is', async () => {
    const [SENT, MINED] = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`] as Hex[]
    // A client whose receipt wait reports what the wallet did, the way viem's waitForTransactionReceipt reports it.
    const client = (reason?: 'cancelled' | 'replaced' | 'repriced') =>
      ({
        getTransactionCount: async () => 5,
        getBlock: async () => ({ baseFeePerGas: 10n ** 9n }),
        waitForTransactionReceipt: async ({ onReplaced }: { onReplaced?: (r: { reason: string }) => void }) => {
          if (reason) onReplaced?.({ reason })
          return { status: 'success', transactionHash: reason ? MINED : SENT, logs: [] }
        },
      }) as never
    const signer = { address: OWNER, sendTransaction: async () => SENT } as unknown as Signer
    const send = (reason?: 'cancelled' | 'replaced' | 'repriced') => sendTx(network('base', RPC), signer, { maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 1n }, 'Wrapping', tx, client(reason))
    await expect(send('cancelled')).rejects.toThrow(`Wrapping: your wallet cancelled it (${MINED}), so it did not happen.`)
    await expect(send('replaced')).rejects.toThrow('Wrapping: your wallet replaced it with another transaction')
    expect((await send('repriced')).transactionHash).toBe(MINED) // the same call at a higher fee
    expect((await send()).transactionHash).toBe(SENT)
    // The RPC's text reaches the terminal cleaned (here an escape sequence that would write the clipboard).
    const evil = `0x\u001b]52;c;aGk=\u0007${'cc'.repeat(30)}`
    const lying = { getTransactionCount: async () => 5, getBlock: async () => ({ baseFeePerGas: 10n ** 9n }), waitForTransactionReceipt: async () => ({ status: 'reverted', transactionHash: evil, logs: [] }) } as never
    const failed = await sendTx(network('base', RPC), signer, { maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 1n }, 'Wrapping', tx, lying).catch((e: Error) => e.message)
    expect(String(failed)).toContain('failed on-chain')
    expect(String(failed)).not.toContain('\u001b')
  })
  test('a transaction explorer link is printed while the transaction is still pending', async () => {
    const hash = `0x${'aa'.repeat(32)}` as Hex
    const net = network('base', RPC)
    net.chain.blockExplorers = { default: { name: 'Base', url: 'https://basescan.org' } }
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const pending: boolean[] = []
    const client = {
      getTransactionCount: async () => 5,
      waitForTransactionReceipt: async () => {
        expect(log.mock.calls.flat().join('\n')).toContain(`Transaction sent: https://basescan.org/tx/${hash}`)
        expect(pending).toEqual([true])
        return { status: 'success', transactionHash: hash }
      },
    } as never
    try {
      await sendTx(net, { address: OWNER, sendTransaction: async () => hash } as unknown as Signer, { gasPrice: 1n }, 'Wrapping', tx, client, (value) => { pending.push(value) })
      expect(pending).toEqual([true, false])
    } finally {
      log.mockRestore()
    }
  })
  test('ophis status looks up only token addresses from the orderbook, never text it could inject', async () => {
    const uid = `0x${'ab'.repeat(56)}`
    serve({}, { [`/api/v1/orders/${uid}`]: { status: 'open', sellToken: '\u001b[2J\u001b]52;c;aGk=\u0007USDC', buyToken: USDC.address, sellAmount: '1', buyAmount: '1' } })
    await expect(status(network('base'), uid)).rejects.toThrow('unreadable order')
  })
})

describe('ophis recover, end to end (chain, orderbook and wallet answered here)', () => {
  const base = network('base', 'http://127.0.0.1:9')
  const MULTICALL = base.chain.contracts!.multicall3!.address // network.ts
  const key = privateKeyToAccount(generatePrivateKey()) // the test plays the user's wallet app
  const ME = key.address
  const SHED = shedOf(ME)
  const SENT = `0x${'aa'.repeat(32)}` as Hex
  const ORDERS = `${getOphisOrderbookUrl(8453)}/api/v1/account/`
  const START = 1_000_000n // the chain's clock when the recovery is signed; its deadline is 30 minutes later
  const MINED_IN = 0x21n // the recovery's block; the shed is read back just before it and after it
  const BRIDGE = { receiver: SHED.toLowerCase(), buyToken: USDC.address.toLowerCase(), executedBuyAmount: '25000000' } // the order that paid USDC into the shed
  const HELD: Record<string, bigint> = { [USDC.address]: 25_000_000n, [ETH.address]: 10n ** 16n }
  type Chain = { now?: () => bigint; held?: (token: Address, block: string) => bigint | 'revert'; failAt?: string; logs?: unknown[]; stuck?: Address; reverted?: boolean; relayed?: boolean; gas?: () => unknown }

  /** The chain as recover reads it: the shed holds what held() says (the coin as the native sentinel), you hold 1 ETH. */
  const chainOf = (c: Chain = {}) => {
    const held = c.held ?? ((token: Address) => HELD[getAddress(token)] ?? 0n)
    return {
      eth_chainId: () => numberToHex(8453),
      eth_getCode: () => '0x6080', // the shed factory is deployed
      eth_getBlockByNumber: () => ({ number: '0x20', hash: `0x${'11'.repeat(32)}`, timestamp: numberToHex((c.now ?? (() => START))()), baseFeePerGas: numberToHex(10n ** 9n), transactions: [] }),
      eth_maxPriorityFeePerGas: () => '0x1',
      eth_getTransactionCount: () => '0x5',
      eth_estimateGas: () => (c.gas ? c.gas() : numberToHex(200_000)),
      eth_getBalance: ([holder, block]: unknown[]) => {
        const n = same(holder, SHED) ? held(ETH.address, String(block)) : 10n ** 18n
        return numberToHex(n === 'revert' ? 0n : n)
      },
      eth_call: ([call, block]: unknown[]) => {
        const { to, data, from } = call as { to: Address; data: Hex; from?: Address }
        if (from && same(from, SHED)) {
          if (c.stuck && same(to, c.stuck)) throw { code: 3, message: 'execution reverted' } // a payout that will not move
          return '0x'
        }
        if (same(to, SHED)) return pad(c.relayed ? '0x1' : '0x0') // nonces(nonce): whether the signed calls already ran
        if (!same(to, MULTICALL)) return pad(numberToHex(1000)) // the L1 gas oracle
        if (String(block) === c.failAt) throw { code: -32000, message: 'request timed out' }
        const [calls] = decodeFunctionData({ abi: multicall3Abi, data }).args as unknown as [{ target: Address; callData: Hex }[]]
        const result = calls.map(({ target, callData }) => {
          const n = same(decodeFunctionData({ abi: erc20Abi, data: callData }).args[0], SHED) ? held(target, String(block)) : 0n
          return n === 'revert' ? { success: false, returnData: '0x' as Hex } : { success: true, returnData: pad(numberToHex(n)) }
        })
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result })
      },
      eth_getTransactionReceipt: () => ({ transactionHash: SENT, blockNumber: numberToHex(MINED_IN), blockHash: `0x${'22'.repeat(32)}`, status: c.reverted ? '0x0' : '0x1', logs: c.logs ?? [] }),
    }
  }
  /** Your wallet app: signs what it is shown (numbers arrive as text), and sends what it is asked to. */
  const wallet = (sent: unknown[] = []): Signer => ({
    address: ME,
    sendTransaction: async (_chain, tx) => {
      sent.push(tx)
      return SENT
    },
    signTypedData: async (_chain, json) => {
      const m = json.message as unknown as { calls: { value: string }[]; deadline: string }
      const { EIP712Domain: _domain, ...types } = json.types
      const message = { ...m, deadline: BigInt(m.deadline), calls: m.calls.map((c) => ({ ...c, value: BigInt(c.value) })) }
      return key.signTypedData({ domain: json.domain, types, primaryType: json.primaryType, message } as never)
    },
  })
  /** recover() with its output captured. */
  const run = async (ask: () => Promise<boolean>, sent: unknown[] = [], named?: string) => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const outcome = await recover(base, wallet(sent), named, ask)
      return { outcome, printed: log.mock.calls.flat().join('\n') }
    } finally {
      log.mockRestore()
    }
  }
  const transferLog = (token: Address, value: bigint) => ({
    address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: SHED, to: ME } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: numberToHex(MINED_IN), blockHash: `0x${'22'.repeat(32)}`, transactionHash: SENT, transactionIndex: '0x0', logIndex: '0x0', removed: false,
  })

  test('ETH on a chain with its own coin: what the Ophis list names ETH, else its wrapped ether, said aloud', async () => {
    // Polygon: CoinGecko's "ETH" is Wormhole ether (it calls itself WETH); the WETH people mean is another contract.
    const polygon = network('polygon', 'http://127.0.0.1:9')
    const wormhole = '0x11cd37bb86f65419713f30673a480ea33c826872'
    serve({ eth_chainId: () => numberToHex(137) }, {
      ...LISTS,
      'files.cow.fi/token-lists/CoinGecko.137.json': { tokens: [{ chainId: 137, address: wormhole, symbol: 'ETH', decimals: 18 }] },
      'files.cow.fi/token-lists/Uniswap.137.json': { tokens: [] },
    })
    expect(await findToken(polygon, 'eth')).toEqual({
      address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // Polygon's WETH on the Ophis list, never the Wormhole lookalike
      symbol: 'WETH',
      decimals: 18,
      native: false,
      listed: true,
      note: 'Polygon has no ETH: using wrapped ether, WETH.',
    })
    expect((await findToken(polygon, 'WETH')).note).toBeUndefined() // asked for by name: nothing to say
    // Avalanche: no WETH on the Ophis list, only in a public list. That one is never put in for ETH: asked for by name only.
    const lookalike = `0x${'4e'.repeat(20)}`
    serve(
      {
        eth_chainId: () => numberToHex(43114),
        eth_call: ([call]: unknown[]) => ((call as { data: Hex }).data.startsWith('0x95d89b41') ? encodeAbiParameters([{ type: 'string' }], ['WETH']) : pad(numberToHex(18))),
      },
      {
        ...LISTS,
        'files.cow.fi/token-lists/CoinGecko.43114.json': { tokens: [{ chainId: 43114, address: lookalike, symbol: 'WETH', decimals: 18 }] },
        'files.cow.fi/token-lists/Uniswap.43114.json': { tokens: [] },
      },
    )
    const avalanche = network('avalanche', 'http://127.0.0.1:9')
    await expect(findToken(avalanche, 'ETH')).rejects.toThrow('Avalanche has no ETH: only wrapped ether is available, WETH.')
    expect(await findToken(avalanche, 'WETH')).toMatchObject({ address: getAddress(lookalike), listed: false }) // by name: warned as unlisted
    // BNB Chain: its ether is named ETH on the Ophis list itself, so ETH still finds it.
    serve({ eth_chainId: () => numberToHex(56) }, LISTS)
    expect(await findToken(network('bnb', 'http://127.0.0.1:9'), 'ETH')).toMatchObject({ address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', listed: true })
  })

  test('a name the Ophis list lacks is found in the public lists the website offers, then described like an address', async () => {
    const usdt = '0x5555555555555555555555555555555555555555' // a token on no real list: list updates cannot change this test
    const arbitrum = network('arbitrum', 'http://127.0.0.1:9')
    const lists = (uniswap: unknown[], coingecko: unknown[]) => ({
      'files.cow.fi/token-lists/Uniswap.42161.json': { tokens: uniswap },
      'files.cow.fi/token-lists/CoinGecko.42161.json': { tokens: coingecko },
    })
    const chain = {
      eth_chainId: () => numberToHex(42161),
      // The token describes itself: symbol() (0x95d89b41) as the chain answers it, then decimals().
      eth_call: ([call]: unknown[]) =>
        (call as { data: Hex }).data.startsWith('0x95d89b41') ? encodeAbiParameters([{ type: 'string' }], ['USD\u20ae0']) : pad(numberToHex(6)),
    }
    serve(chain, { ...LISTS, ...lists([{ chainId: 42161, address: usdt, symbol: 'USDT', decimals: 6 }], [{ chainId: 42161, address: usdt.toLowerCase(), symbol: 'USDT0', decimals: 6 }]) })
    expect(await findToken(arbitrum, 'usdt')).toMatchObject({ address: usdt, symbol: 'USD\u20ae0', decimals: 6, listed: false })
    // One name, two contracts across the lists: the user is asked for the address.
    const other = `0x${'7e'.repeat(20)}`
    serve(chain, { ...LISTS, ...lists([{ chainId: 42161, address: usdt, symbol: 'USDT', decimals: 6 }], [{ chainId: 42161, address: other, symbol: 'usdt', decimals: 6 }]) })
    await expect(findToken(arbitrum, 'USDT')).rejects.toThrow('could mean several tokens')
    // Another chain's entry, or a name no list has, stays unknown.
    serve(chain, { ...LISTS, ...lists([{ chainId: 1, address: usdt, symbol: 'USDT', decimals: 6 }], []) })
    await expect(findToken(arbitrum, 'USDT')).rejects.toThrow('No token called "USDT"')
    // A public list that cannot be read could hide a second USDT: nothing is chosen from the other one.
    serve(chain, { ...LISTS, ...lists([{ chainId: 42161, address: usdt, symbol: 'USDT', decimals: 6 }], []), 'files.cow.fi/token-lists/CoinGecko.42161.json': new Response('down', { status: 503 }) })
    await expect(findToken(arbitrum, 'USDT')).rejects.toThrow('Could not check the public token lists')
    // A placeholder the swap UI filters out (here on Ethereum) is never picked from a public list.
    const ethereum = network('ethereum', 'http://127.0.0.1:9')
    serve({ ...chain, eth_chainId: () => numberToHex(1) }, { ...LISTS, 'files.cow.fi/token-lists/CoinGecko.1.json': { tokens: [{ chainId: 1, address: '0x7751e2f4b8ae93ef6b79d86419d42fe3295a4559', symbol: 'WUSDL', decimals: 18 }] } })
    await expect(findToken(ethereum, 'wUSDL')).rejects.toThrow('No token called "wUSDL"')
    // Nor when the Ophis list itself cannot be read (past its cache): it may hold the name.
    const later = Date.now() + 7 * 86_400_000
    const clock = spyOn(Date, 'now').mockReturnValue(later)
    try {
      serve(chain, { ...lists([{ chainId: 42161, address: usdt, symbol: 'USDT', decimals: 6 }], []), 'swap.ophis.fi/token-lists/ophis.json': new Response('down', { status: 503 }) })
      await expect(findToken(arbitrum, 'USDT')).rejects.toThrow('Could not read the Ophis token list')
    } finally {
      clock.mockRestore()
    }
  })
  test('finds what a bridge left in any of your latest 1,000 orders, and says so when there are more', async () => {
    const page = (n: number) => [...Array(n)].map(() => ({ receiver: X, buyToken: WETH.address.toLowerCase() })) // orders paying elsewhere
    // The bridge that left USDC in the shed is the 101st order back.
    let seen = serve(chainOf(), { [ORDERS]: (u: string) => (u.includes('offset=0&') ? page(100) : u.includes('offset=100&') ? [BRIDGE] : []), ...LISTS })
    const found = await shedHoldings(base, ME)
    expect(found.holdings.map((h) => [h.token.symbol, h.balance])).toEqual([['USDC', 25_000_000n], ['ETH', 10n ** 16n]])
    expect(found.notes).toEqual([])
    expect(seen.filter((u) => u.includes('/orders?offset=')).length).toBe(2) // stops at the first short page
    // Ten full pages: the 1,000 newest are read, and the note says older ones were not.
    seen = serve(chainOf(), { [ORDERS]: () => page(100), ...LISTS })
    const capped = await shedHoldings(base, ME)
    expect(capped.notes).toEqual([`Only your latest 1,000 orders were checked. For a token an older bridge carried: ophis recover <token> on base`])
    expect(capped.holdings.map((h) => h.token.symbol)).toEqual(['ETH'])
    expect(seen.filter((u) => u.includes('/orders?offset=')).length).toBe(10)
  })
  test('a balance read that fails stops the recovery instead of reading as zero; a token that reverts is skipped', async () => {
    serve(chainOf({ failAt: 'latest' }), { [ORDERS]: [BRIDGE], ...LISTS })
    await expect(shedHoldings(base, ME)).rejects.toThrow('Could not read your CoW Shed balances')
    await expect(run(async () => true)).rejects.toThrow('Could not read your CoW Shed balances') // never "Nothing to recover"
    serve(chainOf({ held: (token) => (same(token, WETH.address) ? 'revert' : (HELD[getAddress(token)] ?? 0n)) }), { [ORDERS]: [BRIDGE], ...LISTS })
    const { holdings, notes } = await shedHoldings(base, ME)
    expect(holdings.map((h) => h.token.symbol)).toEqual(['USDC', 'ETH'])
    expect(notes).toEqual([`The token ${WETH.address} did not answer a balance check, so it was skipped.`])
  })
  test('orders you never signed, or a token that will not move, cannot block a recovery; a named token goes alone', async () => {
    // Anyone can list a pre-sign order "from" you that never fills, naming your shed and a token of theirs.
    const EVIL: Address = '0x3333333333333333333333333333333333333333'
    const unsigned = { receiver: SHED.toLowerCase(), buyToken: EVIL.toLowerCase(), executedBuyAmount: '0' }
    const held = (token: Address) => (same(token, EVIL) ? 1n : (HELD[getAddress(token)] ?? 0n))
    serve(chainOf({ held }), { [ORDERS]: [unsigned, BRIDGE], ...LISTS })
    expect((await shedHoldings(base, ME)).holdings.map((h) => h.token.symbol)).toEqual(['USDC', 'ETH'])
    // A holding whose transfer reverts is left out, with a note; the rest is recovered.
    serve(chainOf({ stuck: USDC.address }), { [ORDERS]: [BRIDGE], ...LISTS })
    const stuck = await shedHoldings(base, ME)
    expect(stuck.holdings.map((h) => h.token.symbol)).toEqual(['ETH'])
    expect(stuck.notes).toEqual([`USDC (${USDC.address}) would not transfer out of your CoW Shed right now, so it was left out. To try it alone: ophis recover ${USDC.address} on base`])
    // Naming a token recovers only it: not the coin, not what the orders paid in.
    serve(chainOf(), { [ORDERS]: [BRIDGE], ...LISTS })
    expect((await shedHoldings(base, ME, 'WETH')).holdings).toEqual([])
    expect((await shedHoldings(base, ME, USDC.address)).holdings.map((h) => h.token.symbol)).toEqual(['USDC'])
    expect((await shedHoldings(base, ME, 'ETH')).holdings.map((h) => h.token.symbol)).toEqual(['ETH'])
  })
  test('a recovery whose signed calls ran first in another transaction is reported as done, not failed', async () => {
    const after = (token: Address, block: string) => (block === 'latest' ? 0n : (HELD[getAddress(token)] ?? 0n))
    let empty = false
    serve(chainOf({ reverted: true, relayed: true, held: (t, b) => (empty ? after(t, b) : (HELD[getAddress(t)] ?? 0n)) }), { [ORDERS]: [BRIDGE], ...LISTS })
    const { outcome, printed } = await run(async () => ((empty = true), true))
    expect(outcome).toBe('done')
    expect(printed).toContain('went through in another transaction')
    // Not run elsewhere: the failure stands.
    serve(chainOf({ reverted: true }), { [ORDERS]: [BRIDGE], ...LISTS })
    await expect(run(async () => true)).rejects.toThrow('failed on-chain')
  })
  test('a recovery relayed while you confirm (the RPC saw it priced) is reported as done, not as failing', async () => {
    for (const failAt of [1, 2]) {
      // The estimate fails once the signed calls ran elsewhere: at the first check, or at the one after your answer.
      let n = 0
      const gas = () => {
        if (++n >= failAt) throw { code: 3, message: 'execution reverted: NonceAlreadyUsed' }
        return numberToHex(200_000)
      }
      const held = (t: Address) => (n >= failAt ? 0n : (HELD[getAddress(t)] ?? 0n))
      serve(chainOf({ relayed: true, gas, held }), { [ORDERS]: [BRIDGE], ...LISTS })
      const sent: unknown[] = []
      const { outcome, printed } = await run(async () => true, sent)
      expect([outcome, sent.length]).toEqual(['done', 0])
      expect(printed).toContain('went through in another transaction')
      // Not run elsewhere: the failed check stands, and nothing is sent.
      n = 0
      serve(chainOf({ gas, held }), { [ORDERS]: [BRIDGE], ...LISTS })
      await expect(run(async () => true, sent)).rejects.toThrow()
      expect(sent.length).toBe(0)
    }
  })
  test('a recovery relayed while you agree to a higher fee is reported as done, and not sent again', async () => {
    let estimates = 0
    const gas = () => {
      if (++estimates >= 3) throw { code: 3, message: 'execution reverted: NonceAlreadyUsed' } // it ran elsewhere meanwhile
      return numberToHex(estimates === 1 ? 200_000 : 300_000) // the fee rose after your first answer
    }
    const held = (t: Address) => (estimates >= 3 ? 0n : (HELD[getAddress(t)] ?? 0n))
    serve(chainOf({ relayed: true, gas, held }), { [ORDERS]: [BRIDGE], ...LISTS })
    const sent: unknown[] = []
    let asked = 0
    const { outcome, printed } = await run(async () => (asked++, true), sent)
    expect([outcome, sent.length, asked]).toEqual(['done', 0, 2])
    expect(printed).toContain('went through in another transaction')
  })
  test('a recovery waits for a bridge being placed, and sends with the gas its last check measured', async () => {
    serve(chainOf(), { [ORDERS]: [BRIDGE], ...LISTS })
    const lock = `${process.env.OPHIS_HOME}/bridge.lock`
    writeFileSync(lock, '2147483646')
    try {
      await expect(run(async () => true)).rejects.toThrow('Another ophis bridge is being placed')
    } finally {
      unlinkSync(lock)
    }
    // The balances move while you answer: the second estimate is the one sent, once you agree to its higher fee.
    let estimates = 0
    serve(chainOf({ gas: () => numberToHex(++estimates === 1 ? 200_000 : 300_000) }), { [ORDERS]: [BRIDGE], ...LISTS })
    const sent: { gas?: bigint }[] = []
    let asked = 0
    const { printed } = await run(async () => (asked++, true), sent)
    expect(asked).toBe(2)
    expect(printed).toContain('up since you answered')
    expect(sent[0]?.gas).toBe(360_000n) // 300,000 plus 20%
    expect(existsSync(lock)).toBe(false)
    // Declined at the higher fee: nothing is sent.
    estimates = 0
    const none: unknown[] = []
    let answers = 0
    expect((await run(async () => ++answers === 1, none)).outcome).toBe('cancelled')
    expect(none).toEqual([])
    // Agreed to the higher fee too late: the deadline is checked again after every answer.
    estimates = 0
    let now = START
    serve(chainOf({ now: () => now, gas: () => numberToHex(++estimates === 1 ? 200_000 : 300_000) }), { [ORDERS]: [BRIDGE], ...LISTS })
    let replies = 0
    await expect(run(async () => (++replies === 2 && (now = START + 1441n), true), none)).rejects.toThrow('too close to its deadline')
    expect(none).toEqual([])
  })
  test('a recovery declined after it was priced still blocks bridging until it expires: the RPC saw it signed', async () => {
    serve(chainOf(), { [ORDERS]: [BRIDGE], ...LISTS })
    expect((await run(async () => false)).outcome).toBe('cancelled')
    await expect(checkEarlierHooks(base, ME)).rejects.toThrow('could still run')
  })
  test('refuses to send a recovery that could reach its deadline while your wallet sends it', async () => {
    // You answer 24 minutes and 1 second after signing: 5 minutes and 59 seconds are left, under the 6 needed.
    let now = START
    const sent: unknown[] = []
    serve(chainOf({ now: () => now }), { [ORDERS]: [BRIDGE], ...LISTS })
    await expect(run(async () => ((now = START + 1441n), true), sent)).rejects.toThrow('too close to its deadline')
    expect(sent).toEqual([]) // nothing reached the wallet to send
    // One second sooner, 6 minutes are left: it is sent.
    now = START
    serve(chainOf({ now: () => now, logs: [transferLog(USDC.address, 25_000_000n)], held: (token, block) => (block === '0x21' ? 0n : (HELD[getAddress(token)] ?? 0n)) }), { [ORDERS]: [BRIDGE], ...LISTS })
    expect((await run(async () => ((now = START + 1440n), true), sent)).outcome).toBe('done')
    expect(sent).toHaveLength(1)
  })
  test('what reached you is read from the transaction and the shed, never assumed from what the shed held', async () => {
    const after = (token: Address, block: string) => (block === '0x21' ? 0n : (HELD[getAddress(token)] ?? 0n)) // all of it left the shed
    serve(chainOf({ held: after, logs: [transferLog(USDC.address, 25_000_000n)] }), { [ORDERS]: [BRIDGE], ...LISTS })
    const done = await run(async () => true)
    expect(done.outcome).toBe('done')
    expect(done.printed).toContain('Recovered   25 USDC')
    expect(done.printed).toContain('0.01 ETH  you now hold 1')
    // Mined, but no Transfer event and the shed holds the same: a token that moved nothing is reported as such. The
    // coin's call cannot fail and send less, so it sent what was signed; the shed holding it again means more came in.
    serve(chainOf({}), { [ORDERS]: [BRIDGE], ...LISTS })
    const none = await run(async () => true)
    expect(none.outcome).toBe('left')
    expect(none.printed).toContain('Recovered   0 USDC')
    expect(none.printed).toContain('0.01 ETH  you now hold 1')
    expect(none.printed).toContain(`25 USDC is still in your CoW Shed. To try again: ophis recover ${USDC.address} on base`)
    expect(none.printed).toContain('0.01 ETH is still in your CoW Shed. To try again: ophis recover on base')
  })
  test('after sending, a balance that cannot be read back is never shown as zero', async () => {
    serve(chainOf({ failAt: numberToHex(MINED_IN), logs: [transferLog(USDC.address, 25_000_000n)] }), { [ORDERS]: [BRIDGE], ...LISTS })
    const { outcome, printed } = await run(async () => true)
    expect(outcome).toBe('unknown') // the command exits non-zero
    expect(printed).toContain(`The recovery was sent (${SENT}), but the balances could not be read back.`)
    expect(printed).not.toContain('you now hold')
    // One token that no longer answers at that block: what it left in the shed is unknown, not zero.
    const gone = (token: Address, block: string) => (block !== '0x21' ? (HELD[getAddress(token)] ?? 0n) : same(token, USDC.address) ? 'revert' : 0n)
    serve(chainOf({ held: gone, logs: [transferLog(USDC.address, 25_000_000n)] }), { [ORDERS]: [BRIDGE], ...LISTS })
    const one = await run(async () => true)
    expect(one.outcome).toBe('unknown')
    expect(one.printed).toContain(`Could not read back how much USDC is still in your CoW Shed. To check: ophis recover ${USDC.address} on base`)
  })
})
