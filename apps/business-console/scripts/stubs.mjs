// The local stand-ins, around one command ("pnpm dev": wrangler dev): the rebate indexer (scripts/indexer-stub.mjs,
// port 8793), the OFAC list file (scripts/list-stub.mjs, port 8794), the orderbooks of the desk
// (scripts/orderbook-stub.mjs, port 8795) and the bot check of /recover (scripts/turnstile-stub.mjs, port 8796).
//   node scripts/stubs.mjs <command> [args]     serve while that command runs
import { spawn } from 'node:child_process'
import { start as startIndexer } from './indexer-stub.mjs'
import { start as startLists } from './list-stub.mjs'
import { start as startTurnstile } from './turnstile-stub.mjs'
import { start as startOrderbook } from './orderbook-stub.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/stubs.mjs <command> [args]')
  process.exit(1)
}
const stops = [startIndexer(), startLists(), startOrderbook(), startTurnstile()]
spawn(command, args, { stdio: 'inherit' }).on('exit', (code) => {
  for (const stop of stops) stop()
  process.exitCode = code ?? 1
})
