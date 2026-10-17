#!/usr/bin/env bun
// ophis: swap on Ophis from your terminal. Signing happens in your own wallet app, never here.
import { parseArgs } from 'node:util'
import { formatUnits } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import { checkHome } from './home.ts'
import { network, networks } from './network.ts'
import { connected, disconnect, phoneSigner, savedWallet, startConnect } from './phone.ts'
import { bridgeQuote, bridgeStatus, checkEarlierHooks, checkLeftover, openBridge, placeBridge, saidStatus, showBridge, watchBridge, type BridgeQuote, type BridgeRequest } from './bridge.ts'
import { recover } from './recover.ts'
import {
  checkFunds,
  explorer,
  findToken,
  fund,
  prepare,
  requote,
  send,
  showTrade,
  sign,
  slippageBps,
  someAddress,
  status,
  toAtoms,
  watch,
  wrappedNative,
  type Trade,
  type TradeRequest,
} from './trade.ts'
import { amount, banner, bold, clean, confirm, dim, done, note, red, rows, saffron, step, UserError } from './ui.ts'

const DEFAULT_CHAIN = 'base'

const HELP = `
  ${bold('Usage')}
    ophis connect                           Connect your wallet app with a QR code. Keys stay in your wallet.
    ophis quote  <amount> <token> <token>   See the price. Nothing is signed.
    ophis swap   <amount> <token> <token>   Swap: confirm here, then approve in your wallet.
    ophis bridge <amount> <token> --to-chain <chain>
                                            Move a token to another chain (Across).
    ophis status <order id>                 Check an order.
    ophis recover [token]                   Move what a bridge left in your CoW Shed back to your wallet (only [token], if named).
    ophis wallet                            Show the connected wallet.
    ophis disconnect                        Disconnect your wallet.
    ophis chains                            Chains you can trade on.

  ${bold('Options')}
    -c, --chain <name>      Chain to trade on (default: ${DEFAULT_CHAIN})
        --to-chain <name>   Deliver on another chain (swap or quote: swap and bridge in one go)
        --to-token <token>  With bridge: receive a different token on the other chain
    -s, --slippage <pct>    How far the price may move, in percent (default: 0.5)
    -y, --yes               Skip the confirmation here (your wallet still asks)
        --ref <code>        Referral code
        --rpc <url>         Your own RPC endpoint

  ${bold('Examples')}
    ophis connect
    ophis quote 100 USDC ETH
    ophis swap 0.05 ETH USDC -c arbitrum
    ophis bridge 25 USDC -c base --to-chain arbitrum
`

const OPTIONS = {
  chain: { type: 'string', short: 'c' },
  'to-chain': { type: 'string' },
  'to-token': { type: 'string' },
  slippage: { type: 'string', short: 's' },
  yes: { type: 'boolean', short: 'y' },
  ref: { type: 'string' },
  rpc: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values']

function need(args: string[], count: number, usage: string): string[] {
  if (args.length !== count) throw new UserError(`Usage: ${usage}`)
  return args
}

const chainNames = (ids: number[]) =>
  networks()
    .filter((n) => ids.includes(n.id))
    .map((n) => n.alias)
    .join(', ') || 'none'

async function quote(args: string[], flags: Flags) {
  const [amountText = '', from = '', to = ''] = need(args, 3, 'ophis quote <amount> <token> <token> [-c chain]')
  const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
  const owner = savedWallet()?.address ?? someAddress() // a price check works without a wallet
  const request = { net, amount: amountText, from, to, owner, slippage: slippageBps(flags.slippage ?? '0.5'), ref: flags.ref ?? process.env.OPHIS_REFERRAL_CODE }
  const trade = await step(`Getting the best price on ${net.name}`, () => prepare(request))
  console.log()
  showTrade(trade)
  console.log(`\n  ${dim('Nothing was signed. To trade it:')} ophis swap ${args.join(' ')}${flags.chain ? ` -c ${flags.chain}` : ''}\n`)
}

function cancelled(message: string): void {
  console.log(`  ${dim(message)}\n`)
  process.exitCode = 1
}

/**
 * A fresh price when the quote is over a minute old, for the same tokens and amount. A better
 * price is taken silently; a worse one is shown and asked again (with --yes: stop, never sign it).
 */
async function refreshed(trade: Trade, yes: boolean): Promise<Trade | null> {
  if (Date.now() - trade.quotedAt <= 60_000) return trade
  const fresh = await step('Refreshing the price', () => requote(trade))
  const [was, now] = [BigInt(trade.built.order.buyAmount), BigInt(fresh.built.order.buyAmount)]
  if (now >= was) return fresh
  if (yes) {
    const [d, sym] = [trade.buy.decimals, trade.buy.symbol]
    throw new UserError(`The price moved down since you confirmed (at least ${amount(now, d)} ${sym} instead of ${amount(was, d)}). Nothing was signed: run the command again to see the new price.`)
  }
  console.log()
  showTrade(fresh)
  console.log()
  return (await confirm('The price moved down. Swap at this price?')) ? fresh : null
}

async function swap(args: string[], flags: Flags) {
  const [amountText = '', from = '', to = ''] = need(args, 3, 'ophis swap <amount> <token> <token> [-c chain]')
  const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
  await banner()
  const signer = await step('Reaching your wallet', () => phoneSigner(net.id))
  const owner = signer.address
  const request: TradeRequest = { net, amount: amountText, from, to, owner, slippage: slippageBps(flags.slippage ?? '0.5'), ref: flags.ref ?? process.env.OPHIS_REFERRAL_CODE }

  let trade = await step(`Getting the best price on ${net.name}`, () => prepare(request))
  const prep = await checkFunds(trade)
  console.log()
  showTrade(trade, [
    ['Network fee', prep.feeText ?? 'none, signing the order is free'],
    ['Wallet', dim(owner)],
  ])
  for (const line of prep.notes) note(line)
  console.log()
  if (!flags.yes && !(await confirm('Swap now?'))) return cancelled('Cancelled. Nothing was signed.')
  const asks = 1 + (prep.wrap ? 1 : 0) + (prep.approve ? (prep.resetFirst ? 2 : 1) : 0)
  console.log(`  ${dim(`Your wallet will ask you to approve ${asks === 1 ? '1 step' : `${asks} steps`}. Check each one there.`)}`)

  // From here on, whatever stops the swap also says what state the wallet is in.
  const wrappedNote = () =>
    prep.wrapDone
      ? ` You now hold ${amount(trade.atoms, 18)} ${trade.pay.symbol} instead of ${trade.sell.symbol}. To swap it: ophis swap ${formatUnits(trade.atoms, 18)} ${trade.pay.symbol} ${to} -c ${net.alias}`
      : ''
  let sending = ''
  const interrupted = () => {
    const live = sending ? ` The order may already be live: ophis status ${sending} -c ${net.alias}` : ''
    console.log(`\n  ${saffron('!')} Stopped.${wrappedNote()}${live}\n`)
    finish(130)
  }
  process.on('SIGINT', interrupted)
  let uid: string
  try {
    // Refresh again whenever answering a question took long, so the price and expiry are always current.
    let ready: Trade | null = trade
    while (ready && Date.now() - ready.quotedAt > 60_000) ready = await refreshed(ready, flags.yes === true)
    if (!ready) return cancelled('Cancelled. Nothing was sent.')
    trade = ready
    if (trade.built.order.validTo - Date.now() / 1000 < 300) {
      throw new UserError('The order would expire before it could be placed. Nothing was sent: run the command again.')
    }
    // Sign at the price you accepted before any gas is spent. If the market drops while the wrap or
    // approval confirms, the order simply does not fill: it can never get worse than what you agreed to.
    const signed = await sign(trade, signer)
    await fund(trade, prep, signer)
    sending = signed.uid
    uid = await step('Sending the order', () => send(trade, signed))
  } catch (err) {
    if (!prep.wrapDone) throw err
    const e = err as Error & { shortMessage?: string }
    const why = err instanceof UserError ? e.message : `Something went wrong: ${clean(String(e.shortMessage ?? e.message))}`
    throw new UserError(`${why}${wrappedNote()}`)
  } finally {
    process.off('SIGINT', interrupted)
  }
  console.log(`    ${dim(explorer(uid))}`)
  const outcome = await watch(net, uid, trade.buy, trade.built.order.validTo, trade.sell.native ? trade.pay : undefined)
  if (outcome !== 'filled') process.exitCode = 1
  console.log()
}

/**
 * Swap and/or bridge to another chain through Across. Same safety steps as a swap: quote, confirm here,
 * then every signature in the user's wallet, checked before it is requested (bridge.ts).
 */
async function crossChain(amountText: string, from: string, to: string, flags: Flags, quoteOnly: boolean) {
  const src = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
  const dst = network(String(flags['to-chain']))
  if (!quoteOnly) await banner()
  const wallet = quoteOnly ? null : await step('Reaching your wallet', () => phoneSigner(src.id))
  const owner = wallet?.address ?? savedWallet()?.address ?? someAddress()
  const [sell, found] = await Promise.all([findToken(src, from), findToken(dst, to)])
  // Across carries the wrapped gas token and pays it out as the native coin to a regular wallet.
  const buy = found.native ? wrappedNative(dst) : found
  const pay = sell.native ? wrappedNative(src) : sell
  const again = (amt: string, token: string) => `ophis bridge ${amt} ${token} -c ${src.alias} --to-chain ${dst.alias}${token === to ? '' : ` --to-token ${to}`}`
  const request: BridgeRequest = {
    src, dst, sell, pay, buy,
    atoms: toAtoms(amountText, sell.decimals),
    owner,
    slippage: slippageBps(flags.slippage ?? '0.5'),
    ref: flags.ref ?? process.env.OPHIS_REFERRAL_CODE,
  }
  let bridge: BridgeQuote = await step(`Getting the best bridge price, ${src.name} to ${dst.name}`, () => bridgeQuote(request))
  let quotedAt = Date.now()
  console.log()
  if (!wallet) {
    showBridge(bridge, [], savedWallet() !== null)
    return console.log(`\n  ${dim('Nothing was signed. To do it:')} ${again(amountText, from)}\n`)
  }
  const { open, hooks } = await openBridge(src, owner)
  if (open) throw new UserError(`A bridge from this wallet is still open, and two at once would share your CoW Shed. Wait for it: ophis status ${open} -c ${src.alias}`)
  await checkEarlierHooks(src, owner, false, hooks)
  await checkLeftover(src, owner, bridge.via, bridge.guard) // before any wrap or approval is paid for
  const funding = { net: src, sell, pay, atoms: request.atoms, owner }
  const prep = await checkFunds(funding)
  showBridge(bridge, [
    ['Network fee', prep.feeText ?? 'none, signing the order is free'],
    ['Wallet', dim(owner)],
  ])
  for (const line of prep.notes) note(line)
  console.log()
  if (!flags.yes && !(await confirm(`Send to ${dst.name} now?`))) return cancelled('Cancelled. Nothing was signed.')
  const asks = 2 + (prep.wrap ? 1 : 0) + (prep.approve ? (prep.resetFirst ? 2 : 1) : 0)
  console.log(`  ${dim(`Your wallet will ask you to approve ${asks} steps. Check each one there.`)}`)

  const wrappedNote = () =>
    prep.wrapDone
      ? ` You now hold ${amount(request.atoms, 18)} ${pay.symbol} instead of ${sell.symbol} on ${src.name}. To bridge it: ${again(formatUnits(request.atoms, 18), pay.symbol)}`
      : ''
  let signedUid: string | undefined // once the order is signed it may go live, so a stop must not suggest a retry
  const interrupted = () => {
    const after = signedUid ? ` The order may already be live. Check before trying again: ophis status ${signedUid} -c ${src.alias}` : wrappedNote()
    console.log(`\n  ${saffron('!')} Stopped.${after}\n`)
    finish(130)
  }
  process.on('SIGINT', interrupted)
  let placed: { uid: string; validTo: number }
  try {
    // A quote over a minute old is refreshed for the same tokens and amount; a worse one is asked again.
    while (Date.now() - quotedAt > 60_000) {
      const fresh = await step('Refreshing the bridge price', () => bridgeQuote(request))
      quotedAt = Date.now()
      if (fresh.minOut < bridge.minOut) {
        if (flags.yes) throw new UserError('The bridge price moved down since you confirmed. Nothing was signed: run the command again.')
        console.log()
        showBridge(fresh)
        console.log()
        if (!(await confirm('The price moved down. Send at this price?'))) return cancelled('Cancelled. Nothing was sent.')
      }
      bridge = fresh
    }
    // Funds first (the orderbook checks the approval when the order arrives), then the two signatures.
    // The bridge step is re-checked against what you confirmed right before your wallet sees it.
    await fund(funding, prep, wallet)
    placed = await placeBridge(bridge, wallet, (uid) => {
      signedUid = uid
    })
  } catch (err) {
    if (!prep.wrapDone || (err as { maybeSent?: boolean }).maybeSent) throw err
    const e = err as Error & { shortMessage?: string }
    const why = err instanceof UserError ? e.message : `Something went wrong: ${clean(String(e.shortMessage ?? e.message))}`
    throw new UserError(`${why}${wrappedNote()}`)
  } finally {
    process.off('SIGINT', interrupted)
  }
  console.log(`    ${dim(explorer(placed.uid))}`)
  const stopWatching = () => {
    console.log(`\n  ${saffron('!')} Stopped watching. The bridge carries on: ophis status ${placed.uid} -c ${src.alias}\n`)
    finish(130)
  }
  process.on('SIGINT', stopWatching)
  const outcome = await watch(src, placed.uid, pay, placed.validTo, sell.native ? pay : undefined, `Order filled on ${src.name}. Bridging now.`)
  const landed = outcome === 'filled' ? await watchBridge(bridge, placed.uid) : 'failed'
  process.off('SIGINT', stopWatching)
  if (landed !== 'done') process.exitCode = 1
  console.log()
}

async function connectCommand() {
  await banner('Your keys stay in your wallet app. Ophis never sees them.')
  const pairing = await step('Preparing a secure pairing', () => startConnect(networks().map((n) => n.id)))
  console.log(`\n  Scan this with your wallet app (MetaMask, Rabby, Rainbow, Trust, Ledger Wallet...):\n`)
  console.log(pairing.qr.replace(/^/gm, '  '))
  console.log(`  ${dim('Or paste this link into your wallet:')} ${pairing.uri}\n`)
  const wallet = await step('Waiting for your wallet to connect', pairing.wait)
  done(`Connected ${bold(wallet.address)}`)
  rows([['Chains', chainNames(wallet.chains)]])
  console.log(`\n  Next: ${bold('ophis quote 10 USDC ETH')}\n`)
}

async function walletCommand() {
  const wallet = await step('Checking your wallet connection', () => connected())
  if (!wallet) return console.log(`\n  No wallet connected. Run: ${bold('ophis connect')}\n`)
  console.log()
  rows([
    ['Address', bold(wallet.address)],
    ['Chains', chainNames(wallet.chains)],
    ['Connected until', wallet.expires.toLocaleString()],
  ])
  console.log()
}

async function main(argv: string[]) {
  checkHome()
  const { values: flags, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  const [command, ...args] = positionals
  if (flags.version) return console.log(pkg.version)
  if (!command || command === 'help' || flags.help) {
    await banner()
    return console.log(HELP)
  }
  switch (command) {
    case 'connect':
      return connectCommand()
    case 'disconnect': {
      const had = await step('Disconnecting', () => disconnect())
      return done(had ? 'Wallet disconnected.' : 'No wallet was connected.')
    }
    case 'wallet':
      return walletCommand()
    case 'quote':
    case 'swap': {
      if (!flags['to-chain']) return command === 'quote' ? quote(args, flags) : swap(args, flags)
      const [amountText = '', from = '', to = ''] = need(args, 3, `ophis ${command} <amount> <token> <token> -c <chain> --to-chain <chain>`)
      return crossChain(amountText, from, to, flags, command === 'quote')
    }
    case 'bridge': {
      const [amountText = '', token = ''] = need(args, 2, 'ophis bridge <amount> <token> -c <chain> --to-chain <chain> [--to-token <token>]')
      if (!flags['to-chain']) throw new UserError('Where to? Add --to-chain <chain>, for example --to-chain arbitrum.')
      return crossChain(amountText, token, flags['to-token'] ?? token, flags, false)
    }
    case 'status': {
      const [uid = ''] = need(args, 1, 'ophis status <order id> [-c chain]')
      const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
      const leg = await bridgeStatus(net, uid).catch(() => undefined)
      const yours = !!leg && savedWallet()?.address?.toLowerCase() === leg.owner.toLowerCase()
      console.log()
      await status(net, uid, leg ? [['Bridge', saidStatus(leg.status, net, leg.shed, leg.token, yours)]] : [])
      return console.log()
    }
    case 'recover': {
      if (args.length > 1) throw new UserError('Usage: ophis recover [token] -c <chain>')
      const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
      await banner()
      const wallet = await step('Reaching your wallet', () => phoneSigner(net.id))
      const outcome = await recover(net, wallet, args[0], flags.yes ? undefined : confirm)
      if (outcome === 'cancelled') return cancelled('Cancelled. Nothing was sent.')
      if (outcome === 'left' || outcome === 'unknown') process.exitCode = 1
      return console.log()
    }
    case 'chains':
      console.log()
      rows(networks().map((n) => [n.alias, `${n.name.padEnd(16)} ${dim(n.native)}`]))
      return console.log()
    default:
      throw new UserError(`Unknown command "${command}". See: ophis help`)
  }
}

// The WalletConnect link keeps a socket open, so the process is ended by hand, but only once what was printed has
// reached the terminal, file or pipe (Node writes to pipes asynchronously and process.exit would cut it short).
const finish = (code: number) => process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))

main(process.argv.slice(2))
  .then(() => finish(Number(process.exitCode ?? 0)))
  .catch((err: unknown) => {
    const e = err as Error & { code?: string; shortMessage?: string }
    const message =
      err instanceof UserError ? e.message
      : e.code?.startsWith('ERR_PARSE_ARGS') ? `${e.message}. See: ophis help`
      : `Something went wrong: ${clean(String(e.shortMessage ?? e.message))}`
    console.error(`\n  ${red('✗')} ${message}\n`)
    if (process.env.OPHIS_DEBUG) console.error(err)
    finish(1)
  })
