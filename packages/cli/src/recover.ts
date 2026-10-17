// Recovering what a bridge left in the user's own CoW Shed: an Across refund, or an order that filled without its
// deposit. The shed only runs calls its owner signed, so the user's wallet signs one list of calls, each paying the
// owner one of the shed's holdings, and sends it through the shed factory. Nothing else gets past checkRecovery.
import { isDeepStrictEqual } from 'node:util'
import { getOphisOrderbookUrl, NATIVE_TOKEN_SENTINEL } from '@ophis/sdk'
import { bytesToHex, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, getChainContractAddress, isAddress, multicall3Abi, parseEventLogs, type Address, type Hex } from 'viem'
import { lockBridges, rememberHook, same, SHED_FACTORY, SHED_FACTORY_ADDRESS, SHED_NONCES, SHED_TYPES, SHED_VERSION, shedOf, signedBy } from './bridge.ts'
import { reader, type Network } from './network.ts'
import type { Signer } from './phone.ts'
import { findToken, patient, priceTx, sendTx, WRAPPED, type Token } from './trade.ts'
import { amount, clean, dim, green, note, rows, saffron, step, UserError } from './ui.ts'

const TTL = 1800n // seconds the signed calls stay valid, by the chain's clock
// Sent with less time left, the recovery could mine after its deadline and revert, burning gas: the wallet has up to
// 5 minutes (phone.ts) to send it, plus a minute to mine.
const SEND_MARGIN = 360n

export interface Holding {
  token: Token
  balance: bigint // what the shed held when it was read, before signing
}

export interface ShedCall {
  target: Address
  value: bigint
  callData: Hex
  allowFailure: boolean
  isDelegateCall: boolean
}

/** The CoW Shed typed data the wallet is asked to sign. */
export interface Recovery {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: { calls: ShedCall[]; nonce: Hex; deadline: bigint }
}

/**
 * Balances held by one address, in the order of the tokens given, read in one multicall. When that call fails (a busy
 * or unreachable RPC) nothing is known, so this throws rather than guess; a token that reverts, or does not answer
 * with a balance, is null.
 */
async function balancesOf(net: Network, holder: Address, tokens: Pick<Token, 'address' | 'native'>[], blockNumber?: bigint): Promise<(bigint | null)[]> {
  const client = reader(net)
  const erc20 = tokens.filter((t) => !t.native)
  const calls = erc20.map((t) => ({ target: t.address, allowFailure: true, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [holder] }) }))
  const [native, results] = await Promise.all([
    client.getBalance({ address: holder, blockNumber }),
    client.readContract({ address: getChainContractAddress({ chain: net.chain, contract: 'multicall3' }), abi: multicall3Abi, functionName: 'aggregate3', args: [calls], blockNumber }),
  ]).catch(() => {
    throw new UserError('Could not read your CoW Shed balances. Try again in a moment, or use --rpc with another RPC.')
  })
  // A balance is exactly one word: anything else (a revert, no code, other data) is not an answer.
  const read = new Map(erc20.map((t, i) => [t.address, results[i]?.success && results[i].returnData.length === 66 ? BigInt(results[i].returnData) : null]))
  return tokens.map((t) => (t.native ? native : (read.get(t.address) ?? null)))
}

/**
 * What the owner's shed holds: its native coin, the pinned wrapped token, and every token the owner's filled orders
 * paid into the shed (the one a bridge carries, which Across refunds there); or only the token the user named. Empty
 * ones, and any whose transfer to the owner would fail, are left out.
 */
export async function shedHoldings(net: Network, owner: Address, named?: string): Promise<{ shed: Address; holdings: Holding[]; notes: string[] }> {
  const client = reader(net)
  // Every balance below is read through this RPC: first make sure it is the chain asked for.
  if ((await client.getChainId()) !== net.id) throw new UserError('The RPC answers for a different chain. Check --rpc.')
  if (((await client.getCode({ address: SHED_FACTORY_ADDRESS })) ?? '0x') === '0x') {
    throw new UserError(`CoW Shed is not deployed on ${net.name}, so no bridge can have left anything there.`)
  }
  const shed = shedOf(owner)
  const notes: string[] = []
  const candidates = new Set<Address>()
  const asked = named ? await findToken(net, named) : undefined
  // A named token is the only one recovered, so a holding that will not move can never block it.
  if (asked && !asked.native) candidates.add(getAddress(asked.address))
  if (!asked && WRAPPED[net.id]) candidates.add(getAddress(WRAPPED[net.id]![0]))
  // Newest first, 100 per page, as reservedByOpenOrders (trade.ts) reads them; ten pages reach 1,000 orders back.
  let orders: 'all' | 'unread' | 'capped' = asked ? 'all' : 'capped'
  for (let offset = 0; !asked && offset < 1000; offset += 100) {
    const res = await patient(`${getOphisOrderbookUrl(net.id)}/api/v1/account/${owner}/orders?offset=${offset}&limit=100`).catch(() => null)
    const page = res?.ok ? ((await res.json().catch(() => null)) as unknown) : null
    if (!Array.isArray(page)) {
      orders = 'unread'
      break
    }
    // Only orders that filled: anyone can list a pre-sign order "from" the user that will never fill.
    for (const o of page as { receiver?: unknown; buyToken?: unknown; executedBuyAmount?: unknown }[]) {
      const filled = /^[1-9]\d*$/.test(String(o?.executedBuyAmount))
      if (filled && same(o.receiver, shed) && typeof o.buyToken === 'string' && isAddress(o.buyToken) && !same(o.buyToken, NATIVE_TOKEN_SENTINEL)) candidates.add(getAddress(o.buyToken))
    }
    if (page.length < 100) {
      orders = 'all'
      break
    }
  }
  if (orders === 'unread') notes.push(`Could not read all your orders from Ophis, so only the tokens shown were checked. To check another: ophis recover <token> -c ${net.alias}`)
  if (orders === 'capped') notes.push(`Only your latest 1,000 orders were checked. For a token an older bridge carried: ophis recover <token> -c ${net.alias}`)
  const tokens = [...[...candidates].map((address) => ({ address, native: false })), ...(asked && !asked.native ? [] : [{ address: NATIVE_TOKEN_SENTINEL as Address, native: true }])]
  const balances = await balancesOf(net, shed, tokens)
  const found = tokens.flatMap((t, i) => {
    const balance = balances[i]
    if (balance === null) notes.push(`The token ${t.address} did not answer a balance check, so it was skipped.`)
    return balance ? [{ ...t, balance }] : [] // empty ones are left out
  })
  const holdings = await Promise.all(
    found.map(async ({ address, native, balance }) => {
      if (native) return { token: await findToken(net, address), balance }
      const unknown: Token = { address, symbol: '???', decimals: 0, native: false, listed: false } // amounts then show in base units
      return { token: await findToken(net, address).catch(() => unknown), balance }
    }),
  )
  // The recovery is one transaction that fails as a whole: each payout is first run alone from the shed, and one that
  // fails (a token that will not transfer, or a busy RPC) is left out, so it cannot hold back the others.
  const moves = await Promise.all(
    holdings.map(async (h) => {
      const [call] = recoveryCalls(owner, [h])
      return client.call({ account: shed, to: call!.target, data: call!.callData === '0x' ? undefined : call!.callData, value: call!.value }).then(() => true, () => false)
    }),
  )
  for (const [i, h] of holdings.entries()) {
    if (!moves[i]) notes.push(`${h.token.symbol} (${h.token.native ? 'native coin' : h.token.address}) would not transfer out of your CoW Shed right now, so it was left out. To try it alone: ophis recover ${h.token.native ? h.token.symbol : h.token.address} -c ${net.alias}`)
  }
  return { shed, holdings: holdings.filter((_, i) => moves[i]), notes }
}

/** One call per holding, paying the owner exactly the balance read: the token's own transfer, or the coin itself. */
export const recoveryCalls = (owner: Address, holdings: Holding[]): ShedCall[] =>
  holdings.map(({ token, balance }) =>
    token.native
      ? { target: owner, value: balance, callData: '0x', allowFailure: false, isDelegateCall: false }
      : { target: token.address, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner, balance] }), allowFailure: false, isDelegateCall: false },
  )

const refuse = (why: string) => new UserError(`Refusing to sign: ${why}. Nothing was sent.`)

/**
 * The only typed data recover lets the wallet sign: calls for the owner's own shed, in its exact signing domain and
 * types, each paying the owner one of the shed's holdings, at most the balance read: that token's transfer to the
 * owner, or the coin sent to the owner with no data. No delegatecall, no call allowed to fail, no holding twice.
 */
export function checkRecovery(td: Recovery, chainId: number, owner: Address, holdings: Holding[]): void {
  const domain = { name: 'COWShed', version: SHED_VERSION, chainId, verifyingContract: shedOf(owner) }
  if (td.primaryType !== 'ExecuteHooks' || !isDeepStrictEqual(td.domain, domain) || !isDeepStrictEqual(td.types, SHED_TYPES)) {
    throw refuse('this is not for your own CoW Shed')
  }
  const left = new Map(holdings.map((h) => [h.token.native ? 'native' : getAddress(h.token.address), h.balance]))
  for (const c of td.message.calls) {
    if (c.isDelegateCall !== false || c.allowFailure !== false) throw refuse('a call could run as the shed itself, or fail unnoticed')
    let [paid, value] = ['', 0n] // what the call pays the owner: nothing the shed holds, until shown otherwise
    if (c.callData === '0x') {
      if (same(c.target, owner)) [paid, value] = ['native', c.value]
    } else if (c.value === 0n) {
      const sent = (() => {
        try {
          return decodeFunctionData({ abi: erc20Abi, data: c.callData })
        } catch {
          return undefined
        }
      })()
      // exactly transfer(owner, amount), nothing appended
      if (sent?.functionName === 'transfer' && same(sent.args[0], owner) && same(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: sent.args }), c.callData)) {
        ;[paid, value] = [getAddress(c.target), sent.args[1]]
      }
    }
    const have = left.get(paid)
    if (have === undefined || value > have) throw refuse('a call does not pay you something your CoW Shed holds')
    left.delete(paid) // each holding once
  }
}

/** The wallet signs only what checkRecovery accepts, and the signature must come back from the wallet's own address. */
export async function signRecovery(wallet: Signer, chainId: number, td: Recovery, holdings: Holding[]): Promise<Hex> {
  checkRecovery(td, chainId, getAddress(wallet.address), holdings)
  return signedBy(wallet, chainId, td, wallet.address)
}

/**
 * `ophis recover`: everything the user's shed holds, back to the user's wallet in one transaction the wallet sends.
 * ask() puts the final question (none with --yes).
 */
export async function recover(net: Network, wallet: Signer, named: string | undefined, ask?: (question: string) => Promise<boolean>): Promise<'empty' | 'done' | 'left' | 'unknown' | 'cancelled'> {
  const owner = getAddress(wallet.address)
  const { shed, holdings, notes } = await step(`Looking in your CoW Shed on ${net.name}`, () => shedHoldings(net, owner, named))
  console.log()
  rows([
    ['CoW Shed', `${shed}  ${dim('your own proxy, which bridges pay into')}`],
    ...holdings.map((h, i): [string, string] => [i ? '' : 'Holds', `${amount(h.balance, h.token.decimals)} ${h.token.symbol}  ${dim(h.token.native ? 'native coin' : h.token.address)}`]),
  ])
  for (const line of notes) note(line)
  for (const h of holdings) if (!h.token.listed) note(`${h.token.symbol} is not on the Ophis token list. Its details come from your RPC: check the amounts.`)
  if (!holdings.length) {
    console.log(`\n  Nothing to recover on ${net.name}. ${dim(`To check another token: ophis recover <token> -c ${net.alias}`)}`)
    return 'empty'
  }
  const calls = recoveryCalls(owner, holdings)
  const td: Recovery = {
    domain: { name: 'COWShed', version: SHED_VERSION, chainId: net.id, verifyingContract: shed },
    types: SHED_TYPES,
    primaryType: 'ExecuteHooks',
    // Any unused nonce works (the shed keeps a bitmap); the deadline runs on the chain's clock.
    message: { calls, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), deadline: (await reader(net).getBlock()).timestamp + TTL },
  }

  let sending = false
  const interrupted = () => {
    const state = sending ? `The recovery may still go through from your wallet. To see what is left: ophis recover -c ${net.alias}` : 'Nothing was sent.'
    console.log(`\n  ${saffron('!')} Stopped. ${state}\n`)
    process.exit(130)
  }
  process.on('SIGINT', interrupted)
  // Recoveries and bridges record their signed hooks in one file, one run at a time.
  const unlock = lockBridges()
  try {
    console.log(`\n  ${dim('Your wallet will ask you to sign the recovery, then to send it. Check each one there.')}`)
    const signature = await step('Signing the recovery in your wallet', () => signRecovery(wallet, net.id, td, holdings))
    const { nonce, deadline } = td.message
    const data = encodeFunctionData({ abi: SHED_FACTORY, functionName: 'executeHooks', args: [calls, nonce, deadline, owner, signature] })
    // Public from the gas estimate below (the RPC sees it): until its deadline, anyone could run it, emptying the shed of
    // a later bridge's output before that bridge's hook runs. Recorded, so no bridge starts meanwhile.
    rememberHook(net, owner, data)
    const tx = { to: SHED_FACTORY_ADDRESS, data, value: 0n }
    const tokens = holdings.map((h) => h.token)
    const again = (t: Token) => `ophis recover ${t.native ? '' : `${t.address} `}-c ${net.alias}`
    const report = (left: (bigint | null)[], mine: (bigint | null)[]) => {
      for (const [i, h] of holdings.entries()) {
        const n = left[i]
        if (n === null) note(`Could not read back how much ${h.token.symbol} is still in your CoW Shed. To check: ${again(h.token)}`)
        else if (n > 0n) note(`${amount(n, h.token.decimals)} ${h.token.symbol} is still in your CoW Shed. To try again: ${again(h.token)}`)
      }
      if (left.some((n) => n !== null && n > 0n)) return 'left' as const
      return [...left, ...mine].includes(null) ? ('unknown' as const) : ('done' as const)
    }
    // Anyone who sees the signed calls (the RPC asked to price them, or the mempool) can send them, and they only pay
    // you: a check or a send that fails may have failed because they already ran in another transaction.
    const elsewhere = <T>(run: Promise<T>): Promise<T | null> =>
      run.catch(async (err) => {
        const used = await reader(net).readContract({ address: shed, abi: SHED_NONCES, functionName: 'nonces', args: [nonce] }).catch(() => false)
        if (used) return null
        throw err
      })
    const relayed = async () => {
      console.log(`\n  ${green('✓')} Your signed recovery went through in another transaction: anyone could send it, and it only pays you.`)
      const left = await balancesOf(net, shed, tokens).catch(() => null)
      return left ? report(left, []) : ('unknown' as const)
    }
    // The gas estimate runs the signed calls on the chain as it is now: if they would fail, nothing is sent.
    const priced = await elsewhere(step('Checking the recovery goes through', () => priceTx(net, owner, tx)))
    if (!priced) return relayed()
    console.log()
    rows([
      ['To', `your wallet ${dim(owner)}`],
      ['Network fee', priced.feeText],
    ])
    console.log()
    let pricing = priced
    if (ask) {
      if (!(await ask('Recover now?'))) return 'cancelled'
      // Answering may have taken a while: the deadline may be near, or the balances moved.
      const still = await elsewhere(
        step('Checking it still goes through', async () => {
          if (deadline - (await reader(net).getBlock()).timestamp < SEND_MARGIN) {
            throw new UserError('The signed recovery is too close to its deadline to be sent in time. Nothing was sent: run the command again.')
          }
          return priceTx(net, owner, tx)
        }),
      )
      if (!still) return relayed()
      pricing = still // the balances may have moved meanwhile: the gas the calls need now
    }
    sending = true
    const receipt = await elsewhere(sendTx(net, wallet, pricing.fees, 'Recovering to your wallet', { ...tx, gas: pricing.gas }))
    if (!receipt) return relayed()
    // Read back after the transaction's block: the shed and you.
    const read = await Promise.all([balancesOf(net, shed, tokens, receipt.blockNumber), balancesOf(net, owner, tokens, receipt.blockNumber)]).catch(() => null)
    if (!read) {
      note(`The recovery was sent (${clean(receipt.transactionHash)}), but the balances could not be read back. Check them in your wallet.`)
      return 'unknown'
    }
    const [left, mine] = read
    // What left the shed for you in this transaction: the token's own Transfer events from the shed (a token can move
    // less, or nothing, without failing), or for the coin, exactly what its call sent (the transaction succeeded, and no
    // call may fail; the shed's balance can also move with other transactions in the block).
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
    const moved = ({ token, balance }: Holding) =>
      token.native
        ? balance
        : transfers.filter((l) => same(l.address, token.address) && same(l.args.from, shed) && same(l.args.to, owner)).reduce((sum, l) => sum + l.args.value, 0n)
    const held = (n: bigint | null, t: Token) => (n === null ? 'could not read your balance back' : `you now hold ${amount(n, t.decimals)}`)
    console.log()
    rows(holdings.map((h, i): [string, string] => [i ? '' : 'Recovered', `${amount(moved(h), h.token.decimals)} ${h.token.symbol}  ${dim(held(mine[i], h.token))}`]))
    return report(left, mine)
  } finally {
    process.off('SIGINT', interrupted)
    unlock()
  }
}
