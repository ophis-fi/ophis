#!/usr/bin/env bun
// ophis: swap on Ophis from your terminal. Signing happens in your own wallet app, never here.
import { parseArgs } from 'node:util'
import { enrollOphisTrader } from '@ophis/sdk'
import { formatUnits } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import { checkHome } from './home.ts'
import { chainWords, dot, network, networks, tag } from './network.ts'
import { connected, disconnect, phoneSigner, savedWallet, showQrImage, startConnect } from './phone.ts'
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
import { amount, banner, bold, clean, confirm, dim, done, finish, note, red, rows, saffron, step, UserError } from './ui.ts'

const DEFAULT_CHAIN = 'base'

const HELP = `
  Swap and bridge on Ophis from your terminal. Your keys stay in your wallet app.

  ${bold('Start here')}
    ophis connect                      Link your wallet app (scan a QR code)

  ${bold('Trade')}
    ophis quote 5 USDC ETH             See the price. Nothing is signed.
    ophis swap 5 USDC ETH              Swap, then approve it in your wallet
    ophis bridge 25 USDC to arbitrum   Move 25 USDC from Base to Arbitrum

  ${bold('Choose the chain')}
    Everything happens on Base unless you name a chain:
    ophis swap 5 USDC ETH on arbitrum  Swap on Arbitrum
    ophis swap 5 USDC ETH to arbitrum  Swap on Base, get the ETH on Arbitrum
    ophis bridge 25 USDC from arbitrum to base
    ophis chains                       Every chain, and the name to type

  ${bold('Follow up')}
    ophis status <order id>            See where an order is
    ophis wallet                       Your wallet and the chains it shares
    ophis recover                      Get back tokens a bridge left behind
    ophis disconnect                   Unlink your wallet

  ${bold('Options')}
    -s, --slippage <percent>   How far the price may move, in % (default 0.5)
    -y, --yes                  Skip the question here (your wallet still asks)
        --to-token <token>     With bridge: get a different token on arrival
        --ref <code>           Referral code
        --rpc <url>            Your own RPC address
    -c <chain> and --to-chain <chain> work like "on" and "to".
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

/** The chains a wallet shares, five to a line, each with its colour dot and the name to type. */
const chainRows = (ids: number[]): [string, string][] => {
  const names = networks()
    .filter((n) => ids.includes(n.id))
    .map((n) => `${dot(n.id)} ${n.alias}`)
  const lines = Array.from({ length: Math.ceil(names.length / 5) }, (_, i) => names.slice(i * 5, i * 5 + 5).join('   '))
  return (lines.length ? lines : ['none']).map((line, i): [string, string] => [i ? '' : 'Chains', line])
}

async function quote(args: string[], flags: Flags) {
  const [amountText = '', from = '', to = ''] = need(args, 3, 'ophis quote <amount> <token> <token> [on <chain>]')
  const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
  const owner = savedWallet()?.address ?? someAddress() // a price check works without a wallet
  const request = { net, amount: amountText, from, to, owner, slippage: slippageBps(flags.slippage ?? '0.5'), ref: flags.ref ?? process.env.OPHIS_REFERRAL_CODE }
  const trade = await step(`Getting the best price on ${tag(net)}`, () => prepare(request))
  console.log()
  showTrade(trade)
  console.log(`\n  ${dim('Nothing was signed. To trade it:')} ophis swap ${args.map(shellArg).join(' ')}${flags.chain ? ` on ${net.alias}` : ''}${sameTerms(flags)}\n`)
}

/** A value as the shell would read it back: plain when safe, else single-quoted. */
const shellArg = (s: string): string => (/^[\w.,:/@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** The options a quote ran with, so the command it suggests trades on the same terms. */
const sameTerms = (flags: Flags): string =>
  [
    flags.slippage !== undefined ? `-s ${shellArg(flags.slippage)}` : '',
    flags.ref ? `--ref ${shellArg(flags.ref)}` : '',
    flags.rpc ? `--rpc ${shellArg(flags.rpc)}` : '',
  ]
    .filter(Boolean)
    .map((option) => ` ${option}`)
    .join('')

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
  const [amountText = '', from = '', to = ''] = need(args, 3, 'ophis swap <amount> <token> <token> [on <chain>]')
  const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
  await banner()
  const signer = await step('Reaching your wallet', () => phoneSigner(net.id))
  const owner = signer.address
  const request: TradeRequest = { net, amount: amountText, from, to, owner, slippage: slippageBps(flags.slippage ?? '0.5'), ref: flags.ref ?? process.env.OPHIS_REFERRAL_CODE }

  let trade = await step(`Getting the best price on ${tag(net)}`, () => prepare(request))
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
    prep.wrapDone || prep.wrapPending
      ? `${prep.wrapPending ? ' The wrap may still confirm. Check the transaction before trying again. If it confirms, you will hold' : ' You now hold'} ${amount(trade.atoms, 18)} ${trade.pay.symbol} instead of ${trade.sell.symbol}. To swap it: ophis swap ${formatUnits(trade.atoms, 18)} ${trade.pay.symbol} ${clean(shellArg(to))} on ${net.alias}${clean(sameTerms(flags))}`
      : ''
  let sending = ''
  const interrupted = () => {
    const live = sending ? ` The order may already be live: ophis status ${sending} on ${net.alias}` : ''
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
    if (!prep.wrapDone && !prep.wrapPending) throw err
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
  const again = (amt: string, token: string) =>
    `ophis bridge ${shellArg(amt)} ${shellArg(token)} from ${src.alias} to ${dst.alias}${token === to ? '' : ` --to-token ${shellArg(to)}`}${sameTerms(flags)}`
  const request: BridgeRequest = {
    src, dst, sell, pay, buy,
    atoms: toAtoms(amountText, sell.decimals),
    owner,
    slippage: slippageBps(flags.slippage ?? '0.5'),
    ref: flags.ref ?? process.env.OPHIS_REFERRAL_CODE,
  }
  let bridge: BridgeQuote = await step(`Getting the best bridge price, ${tag(src)} to ${tag(dst)}`, () => bridgeQuote(request))
  let quotedAt = Date.now()
  console.log()
  if (!wallet) {
    showBridge(bridge, [], savedWallet() !== null)
    return console.log(`\n  ${dim('Nothing was signed. To do it:')} ${again(amountText, from)}\n`)
  }
  const { open, hooks } = await openBridge(src, owner)
  if (open) throw new UserError(`An earlier transfer between networks is still using your CoW Shed, the small account bridges pay into. Check its status and wait for it to finish: ophis status ${open} on ${src.alias}`)
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
    prep.wrapDone || prep.wrapPending
      ? `${prep.wrapPending ? ' The wrap may still confirm. Check the transaction before trying again. If it confirms, you will hold' : ' You now hold'} ${amount(request.atoms, 18)} ${pay.symbol} instead of ${sell.symbol} on ${src.name}. To bridge it: ${again(formatUnits(request.atoms, 18), pay.symbol)}`
      : ''
  let signedUid: string | undefined // once the order is signed it may go live, so a stop must not suggest a retry
  const interrupted = () => {
    const after = signedUid ? ` The order may already be live. Check before trying again: ophis status ${signedUid} on ${src.alias}` : wrappedNote()
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
    enrollOphisTrader(owner).catch(() => {}) // best effort, as for swaps: lets the rebate indexer see this wallet
  } catch (err) {
    if ((!prep.wrapDone && !prep.wrapPending) || (err as { maybeSent?: boolean }).maybeSent) throw err
    const e = err as Error & { shortMessage?: string }
    const why = err instanceof UserError ? e.message : `Something went wrong: ${clean(String(e.shortMessage ?? e.message))}`
    throw new UserError(`${why}${wrappedNote()}`)
  } finally {
    process.off('SIGINT', interrupted)
  }
  console.log(`    ${dim(explorer(placed.uid))}`)
  const stopWatching = () => {
    console.log(`\n  ${saffron('!')} Stopped watching. The bridge carries on: ophis status ${placed.uid} on ${src.alias}\n`)
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
  console.log(`\n  ${dim('Pairing link, to paste into your wallet instead of scanning:')} ${pairing.uri}\n`)
  // The iPhone Camera app hands this code to no wallet (Rabby, Ledger Wallet) or to whichever one iOS picks: the
  // wallet's own scanner always works, and some are tucked away.
  const help = [
    bold('Connect your wallet'),
    '',
    '1. Open your wallet app on your phone.',
    `2. Open its WalletConnect scanner ${dim('(not the Camera app)')}:`,
    `   MetaMask       ${dim('Scan (account menu or top right)')}`,
    `   Rabby          ${dim('Settings > WalletConnect')}`,
    `   Trust Wallet   ${dim('Scan QR code, top right')}`,
    `   Rainbow        ${dim('scan icon, home screen')}`,
    `   Ledger Wallet  ${dim('an account > WalletConnect icon')}`,
    '3. Scan this code, then approve in the wallet.',
  ]
  const qr = pairing.qr.trimEnd().split('\n')
  const width = (line: string) => line.replace(/\x1b\[[\d;]*m/g, '').length
  const { columns = 80, rows: height = 0 } = process.stdout // no size when the output is not a terminal
  // Beside the code when the window is wide enough, so both stay on screen; below it otherwise.
  const lines =
    columns >= 2 + width(qr[0]!) + 4 + Math.max(...help.map(width))
      ? qr.map((line, i) => `  ${line}    ${help[i - 1] ?? ''}`)
      : [...qr, '', ...help].map((line) => `  ${line}`)
  // A code is only scannable whole: in a window too narrow (lines would wrap) or too short for it, it opens as an image.
  const fits = columns >= 2 + width(qr[0]!) && (!height || height >= lines.length + 1)
  // Ctrl-C, a closed terminal or a kill would end the process without its exit handlers: from before the image exists,
  // delete it (it holds the pairing key) on the way out, with the usual 128 + signal exit status.
  let image = { opened: false, remove: () => {} }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGHUP', 'SIGTERM']
  const interrupted = (signal: NodeJS.Signals) => {
    image.remove()
    if (signal !== 'SIGINT') process.exit(signal === 'SIGHUP' ? 129 : 143) // the terminal may be gone: print nothing
    console.log(`\n  ${saffron('!')} Stopped. No wallet was connected.\n`)
    finish(130)
  }
  for (const signal of signals) process.on(signal, interrupted)
  let wallet
  try {
    if (!fits) image = await showQrImage(pairing.uri)
    if (image.opened) console.log(`${help.map((line) => `  ${line}`).join('\n')}\n\n  ${dim('The code opened in a separate window: this one is too small to show it.')}`)
    else console.log(fits ? lines.join('\n') : `${lines.join('\n')}\n\n  ${dim('Make this window bigger to show the whole code.')}`)
    wallet = await step('Waiting for your wallet to connect', pairing.wait)
  } finally {
    image.remove()
    for (const signal of signals) process.off(signal, interrupted)
  }
  done(`Connected ${bold(wallet.address)}`)
  rows(chainRows(wallet.chains))
  if (wallet.otherChains.length) {
    const leftOut = wallet.otherChains.map((id) => networks().find((n) => n.id === id)?.name ?? String(id)).join(', ')
    note(`Left out ${leftOut}: your wallet picked another account there. Run ophis connect again and pick the same account on every network.`)
  }
  console.log(`\n  Next: ${bold('ophis quote 10 USDC ETH')}  ${dim('(on Base; for another chain add, say, "on arbitrum")')}\n`)
}

async function walletCommand() {
  const wallet = await step('Checking your wallet connection', () => connected())
  if (!wallet) return console.log(`\n  No wallet connected. Run: ${bold('ophis connect')}\n`)
  console.log()
  rows([['Address', bold(wallet.address)], ...chainRows(wallet.chains), ['Connected until', wallet.expires.toLocaleString()]])
  console.log(`\n  ${dim('A chain missing here? Add it in your wallet app, then run ophis connect again.')}\n`)
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
      const words = chainWords(args, flags, 3)
      // "swap 5 USDC to ETH": the tokens go one after the other ("to" before a chain means the chain to receive on).
      if (words.length === 4 && /^(to|for)$/i.test(words[2]!)) {
        // The corrected command keeps every chain and option given, so running it trades on the same terms.
        const [amt, sell, , buy] = words.map((w) => clean(shellArg(w)))
        const on = flags.chain !== undefined ? ` on ${network(flags.chain).alias}` : ''
        const to = flags['to-chain'] !== undefined ? ` to ${network(flags['to-chain']).alias}` : ''
        const terms = clean(sameTerms(flags))
        // A chain's own name there ("to arbitrum", not a symbol such as ETH or ARB) means moving the token to that chain.
        const dest = networks().find((n) => n.alias === words[3]!.toLowerCase())
        if (dest) {
          throw new UserError(`${dest.name} is a network, not a token. To move ${sell} there: ophis bridge ${amt} ${sell}${on.replace(' on ', ' from ')} to ${dest.alias}${terms}; to swap there (replace <token> with the token to receive): ophis swap ${amt} ${sell} <token>${on} to ${dest.alias}${terms}`)
        }
        throw new UserError(`There is an extra word between the two tokens. Use: ophis ${command} ${amt} ${sell} ${buy}${on}${to}${terms}`)
      }
      // Present, even if blank, means a destination was named: a blank one is refused, never read as "stay here".
      if (flags['to-chain'] === undefined) return command === 'quote' ? quote(words, flags) : swap(words, flags)
      const [amountText = '', from = '', to = ''] = need(words, 3, `ophis ${command} <amount> <token> <token> [on <chain>] to <chain>`)
      return crossChain(amountText, from, to, flags, command === 'quote')
    }
    case 'bridge': {
      const [amountText = '', token = ''] = need(chainWords(args, flags, 2), 2, 'ophis bridge <amount> <token> to <chain> [from <chain>]')
      if (flags['to-chain'] === undefined) {
        // The example keeps the chain and options given, and never names the source chain as the destination.
        const src = network(flags.chain ?? DEFAULT_CHAIN)
        const from = flags.chain !== undefined ? ` from ${src.alias}` : ''
        const other = flags['to-token'] !== undefined ? ` --to-token ${shellArg(flags['to-token'])}` : ''
        throw new UserError(`The network to receive your tokens on is missing. Choose a destination, for example: ophis bridge ${clean(`${shellArg(amountText)} ${shellArg(token)}${from} to ${src.alias === 'arbitrum' ? 'base' : 'arbitrum'}${other}${sameTerms(flags)}`)}`)
      }
      return crossChain(amountText, token, flags['to-token'] ?? token, flags, false)
    }
    case 'status': {
      const [uid = ''] = need(chainWords(args, flags, 1), 1, 'ophis status <order id> [on <chain>]')
      if (flags['to-chain'] !== undefined) throw new UserError('An order lives on one chain: name it with "on", for example: ophis status <order id> on arbitrum')
      const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
      // Not a bridge order: no bridge row. A bridge whose state could not be read says so, rather than look done.
      let unread = ''
      const leg = await bridgeStatus(net, uid).catch((err: unknown) => void (unread = clean(String((err as Error)?.message ?? err)).slice(0, 120)))
      const yours = !!leg && savedWallet()?.address?.toLowerCase() === leg.owner.toLowerCase()
      const bridgeRow: [string, string][] = leg
        ? [['Bridge', saidStatus(leg.status, net, leg.shed, leg.token, yours)]]
        : unread ? [['Bridge', `could not be checked (${unread}). Try again, or use --rpc.`]] : []
      console.log()
      await status(net, uid, bridgeRow)
      return console.log()
    }
    case 'recover': {
      // Chain words come in pairs after the optional token, so an odd count means a token leads (even one named ON).
      const words = chainWords(args, flags, args.length % 2)
      if (words.length > 1) throw new UserError('The recover command has extra words. Usage: ophis recover [token] [on <chain>]')
      if (flags['to-chain'] !== undefined) throw new UserError('Recovery happens on one chain: name it with "on", for example: ophis recover on arbitrum')
      const net = network(flags.chain ?? DEFAULT_CHAIN, flags.rpc)
      await banner()
      const wallet = await step('Reaching your wallet', () => phoneSigner(net.id))
      const outcome = await recover(net, wallet, words[0], flags.yes ? undefined : confirm)
      if (outcome === 'cancelled') return cancelled('Cancelled. Nothing was sent.')
      if (outcome === 'left' || outcome === 'unknown') process.exitCode = 1
      return console.log()
    }
    case 'chains': {
      // A to Z, the testnet last; the name to type is the one in bold.
      const all = networks().sort((a, b) => Number(a.id === 11155111) - Number(b.id === 11155111) || a.name.localeCompare(b.name))
      console.log(`\n  ${dim(`  ${'Chain'.padEnd(17)}${'Name to type'.padEnd(14)}Network fee in`)}`)
      for (const n of all) {
        const note = n.alias === DEFAULT_CHAIN ? 'used when you name no chain' : n.id === 11155111 ? 'testnet, free test tokens' : ''
        console.log(`  ${dot(n.id)} ${n.name.padEnd(17)}${bold(n.alias.padEnd(14))}${n.native.padEnd(15)}${dim(note)}`)
      }
      console.log(`\n  ${dim('Name a chain with "on", for example: ophis swap 5 USDC ETH on arbitrum')}`)
      console.log(`  ${dim('A network fee is only for a first approval of a token, or wrapping ETH: signing an order is free,')}`)
      return console.log(`  ${dim('and the Ophis fee comes out of the trade.')}\n`)
    }
    default:
      throw new UserError(`Unknown command "${command}". See: ophis help`)
  }
}

main(process.argv.slice(2))
  .then(() => finish(Number(process.exitCode ?? 0)))
  .catch((err: unknown) => {
    const e = err as Error & { code?: string; shortMessage?: string }
    const message =
      err instanceof UserError ? e.message
      : typeof e.code === 'string' && e.code.startsWith('ERR_PARSE_ARGS') ? `${e.message}. See: ophis help` // a library's code can be a number
      : `Something went wrong: ${clean(String(e.shortMessage ?? e.message))}`
    console.error(`\n  ${red('✗')} ${message}\n`)
    if (process.env.OPHIS_DEBUG) console.error(err)
    finish(1)
  })
