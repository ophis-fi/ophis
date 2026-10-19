// Preloaded only by command.test.ts in a child process: the wallet and RPC answer locally.
import { mock } from 'bun:test'
import type { Hex } from 'viem'
import * as networks from '../src/network.ts'
import * as phone from '../src/phone.ts'
import * as trade from '../src/trade.ts'
import * as bridge from '../src/bridge.ts'

const mode = process.env.OPHIS_TEST_SCENARIO
const owner = '0x1111111111111111111111111111111111111111'
const hash = `0x${'ab'.repeat(32)}` as Hex

if (mode?.startsWith('dollars')) {
  globalThis.fetch = (async () => Response.json({ tokens: [
    { chainId: mode === 'dollars' ? 4663 : 1, address: owner, symbol: 'USDG', decimals: 6 },
    { chainId: mode === 'dollars' ? 4663 : 1, address: '0x2222222222222222222222222222222222222222', symbol: 'usd\u001bx', decimals: 6 },
    { chainId: 1, address: owner, symbol: 'USDC', decimals: 6 },
    { chainId: 4663, address: '0x3333333333333333333333333333333333333333', symbol: 'OTHER', decimals: 6 },
  ] })) as unknown as typeof fetch
} else {
  const net = networks.network('base')
  const sell = await trade.findToken(net, 'ETH')
  const pay = trade.wrappedNative(net)
  const prep: Awaited<ReturnType<typeof trade.checkFunds>> = {
    wrap: true, approve: 10n ** 18n, resetFirst: false, gas: { wrap: 50_000n, approve: 50_000n },
    fees: { gasPrice: 1n }, maxFee: 100_000n, notes: [], wrapDone: false,
  }
  let sent = false
  mock.module('../src/network.ts', () => ({ ...networks, reader: () => ({
    getChainId: async () => 8453,
    getTransactionCount: async () => 0,
    waitForTransactionReceipt: async () => {
      console.log('Receipt wait started')
      if (mode === 'interrupt') {
        process.emit('SIGINT')
        return new Promise(() => {})
      }
      if (mode === 'error') throw new Error('Receipt unavailable')
      if (mode === 'timeout') throw Object.assign(new Error('Timed out'), { name: 'WaitForTransactionReceiptTimeoutError' })
      return { status: mode === 'reverted' ? 'reverted' : 'success', transactionHash: hash }
    },
  }) }))
  mock.module('../src/phone.ts', () => ({ ...phone,
    phoneSigner: async () => ({
      address: owner,
      sendTransaction: async () => {
        if (mode === 'declined' || sent) throw new Error('Wallet declined')
        sent = true
        return hash
      },
    }),
    startConnect: async () => ({ qr: 'QR', uri: 'wc:test', wait: async () => phone.accountsOf({ namespaces: { eip155: {
      accounts: [`eip155:8453:${owner}`, 'eip155:42161:0x2222222222222222222222222222222222222222'],
    } } } as never) }),
  }))
  mock.module('../src/trade.ts', () => ({ ...trade,
    checkFunds: async () => prep,
    prepare: async () => ({ net, sell, pay, atoms: 10n ** 18n, owner, quotedAt: Date.now(), built: { order: { validTo: Date.now() / 1000 + 1800 } } }),
    showTrade: () => {},
    sign: async () => ({ uid: '0xorder', signature: '0x' }),
  }))
  mock.module('../src/bridge.ts', () => ({ ...bridge,
    bridgeQuote: async (request: object) => ({ ...request, via: pay, guard: 0n }),
    openBridge: async () => ({ hooks: [] }),
    checkEarlierHooks: async () => {},
    checkLeftover: async () => {},
    showBridge: () => {},
  }))
}
