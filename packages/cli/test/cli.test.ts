import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, mock, test } from 'bun:test'
import { getAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { findListedToken } from '@ophis/mcp-server/src/ophis.ts'
import { network, networks } from '../src/network.ts'
import type { Signer, TypedDataJson } from '../src/phone.ts'
import { minOut, prepare, requote, sign, slippageBps, toAtoms, WRAPPED } from '../src/trade.ts'
import { clean } from '../src/ui.ts'

describe('amounts and slippage', () => {
  test('token units to atoms', () => {
    expect(toAtoms('1.5', 6)).toBe(1_500_000n)
    expect(toAtoms('100', 18)).toBe(10n ** 20n)
    expect(toAtoms('0.1000000', 6)).toBe(100_000n) // trailing zeros are not extra precision
    expect(toAtoms('1.0', 6)).toBe(1_000_000n)
  })
  test('refuses unclear amounts', () => {
    for (const bad of ['0', '1.1234567', 'abc', '-1', '1e3', '.5', '1,5']) expect(() => toAtoms(bad, 6)).toThrow()
  })
  test('percent to basis points, floor rounds down', () => {
    expect(slippageBps('0.5')).toBe(50)
    expect(() => slippageBps('51')).toThrow()
    expect(() => slippageBps('-1')).toThrow()
    expect(minOut(1_000_000n, 50)).toBe(995_000n)
    expect(minOut(999n, 50)).toBe(994n)
  })
})

describe('chains', () => {
  test('short names, full names and ids', () => {
    expect(network('arb').id).toBe(42161)
    expect(network('Base').id).toBe(8453)
    expect(network('10').alias).toBe('optimism')
  })
  test('refuses unknown chains and plain-http RPCs', () => {
    expect(() => network('scroll')).toThrow('Unknown chain')
    expect(() => network('base', 'http://rpc.example.com')).toThrow('https')
  })
  test('RPC addresses: no user-info trick, and environment variables are checked too', () => {
    expect(() => network('base', 'http://localhost:8545@attacker.example/')).toThrow('https')
    expect(network('base', 'http://127.0.0.1:8545').rpc).toEqual(['http://127.0.0.1:8545'])
    process.env.OPHIS_RPC_URL_8453 = 'http://evil.example'
    try {
      expect(() => network('base')).toThrow('https')
    } finally {
      delete process.env.OPHIS_RPC_URL_8453
    }
  })
  test('Plasma and Sepolia have an RPC', () => {
    expect(network('plasma').rpc.length).toBeGreaterThan(0)
    expect(network('sepolia').rpc.length).toBeGreaterThan(0)
  })
})

describe('order building (orderbook mocked)', () => {
  const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' // resolved from the (mocked) token list, no RPC
  const OWNER = '0x1111111111111111111111111111111111111111'
  const orderbook = (quote: Record<string, string>) => {
    const calls: { url: string; body?: Record<string, unknown> }[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      // The lists as swap.ophis.fi serves them, from the repo: the MCP module caches each list for the whole run, so
      // every test file serves these same files.
      if (u.startsWith('https://swap.ophis.fi/token-lists/')) {
        return new Response(readFileSync(new URL(`../../../apps/frontend/apps/cowswap-frontend/public/token-lists/${u.slice(u.lastIndexOf('/') + 1)}`, import.meta.url)))
      }
      if (u.endsWith('/api/v1/quote')) {
        const asked = JSON.parse(String(init?.body))
        return Response.json({ quote: { sellToken: asked.sellToken, buyToken: asked.buyToken, ...quote } })
      }
      return new Response('not mocked', { status: 500 }) // any RPC call lands here and fails the test
    }) as unknown as typeof fetch
    return calls
  }
  const request = { net: network('base'), amount: '100', from: 'USDC', to: 'cbBTC', owner: OWNER, slippage: 50 } as const

  test('quotes and signs the same appData, with one Ophis fee entry and the owner as receiver', async () => {
    const calls = orderbook({ sellAmount: '99000000', feeAmount: '1000000', buyAmount: '100000' })
    const t = await prepare({ ...request })
    expect(calls.find((c) => c.url.endsWith('/api/v1/quote'))?.body?.appDataHash).toBe(t.built.appDataHash)
    expect(t.built.order.sellAmount).toBe('100000000')
    expect(t.built.order.buyAmount).toBe('99490') // quote minus the 0.01% Ophis fee, then minus 0.5%
    expect(t.built.order.receiver).toBe(OWNER)
    const metadata = JSON.parse(t.built.fullAppData).metadata
    const fees = Array.isArray(metadata.partnerFee) ? metadata.partnerFee : [metadata.partnerFee]
    expect(fees.filter((f: object) => 'volumeBps' in f)).toHaveLength(1) // the #1236 duplication guard
    expect(metadata.ophisSource).toEqual({ app: 'cli' })
  })

  test('refuses a quote for a different amount than asked', async () => {
    orderbook({ sellAmount: '98000000', feeAmount: '1000000', buyAmount: '100000' })
    await expect(prepare({ ...request })).rejects.toThrow('does not match your amount')
  })

  test('selling ETH wraps into the pinned WETH, with no RPC involved', async () => {
    orderbook({ sellAmount: '990000000000000000', feeAmount: '10000000000000000', buyAmount: '2400000000' })
    const t = await prepare({ ...request, amount: '1', from: 'ETH', to: 'USDC' })
    expect(t.sell.native).toBe(true)
    expect(t.pay.address).toBe('0x4200000000000000000000000000000000000006')
    expect(t.built.order.sellToken).toBe('0x4200000000000000000000000000000000000006')
  })

  test('a refreshed price keeps exactly the tokens and amount that were confirmed', async () => {
    orderbook({ sellAmount: '99000000', feeAmount: '1000000', buyAmount: '100000' })
    const t = await prepare({ ...request })
    orderbook({ sellAmount: '99000000', feeAmount: '1000000', buyAmount: '90000' })
    const fresh = await requote(t)
    expect([fresh.sell, fresh.pay, fresh.buy, fresh.atoms]).toEqual([t.sell, t.pay, t.buy, t.atoms])
    expect(BigInt(fresh.built.order.buyAmount)).toBeLessThan(BigInt(t.built.order.buyAmount))
  })

  test('refuses native to native, and native to its own wrapped token', async () => {
    orderbook({ sellAmount: '1', feeAmount: '0', buyAmount: '1' })
    await expect(prepare({ ...request, from: 'ETH', to: 'ETH' })).rejects.toThrow('two different tokens')
    await expect(prepare({ ...request, from: 'ETH', to: 'WETH' })).rejects.toThrow('is a wrap')
  })

  test('a token given by address is looked up in the list by its address, not by a name', async () => {
    orderbook({ sellAmount: '1', feeAmount: '0', buyAmount: '1' })
    expect(await findListedToken(8453, CBBTC.toLowerCase())).toMatchObject({ symbol: 'cbBTC', decimals: 8 })
    expect(await findListedToken(8453, '0x000000000000000000000000000000000000dEaD')).toBeNull()
  })

  // The tests play the wallet app here; the CLI itself never holds a key.
  const walletApp = (address: string, keyThatSigns: PrivateKeyAccount, seen: TypedDataJson[] = []): Signer => ({
    address: getAddress(address),
    sendTransaction: async () => {
      throw new Error('not used')
    },
    signTypedData: async (_chain, json) => {
      seen.push(json)
      const { EIP712Domain: _domain, ...types } = json.types
      const m = json.message
      const message = { ...m, sellAmount: BigInt(String(m.sellAmount)), buyAmount: BigInt(String(m.buyAmount)), feeAmount: BigInt(String(m.feeAmount)) }
      return keyThatSigns.signTypedData({ domain: json.domain, types, primaryType: json.primaryType, message } as never) as Promise<Hex>
    },
  })

  test('the order is signed by the wallet app, and the signature is checked against the connected address', async () => {
    const phone = privateKeyToAccount(generatePrivateKey())
    orderbook({ sellAmount: '99000000', feeAmount: '1000000', buyAmount: '100000' })
    const t = await prepare({ ...request, owner: phone.address })
    const seen: TypedDataJson[] = []
    const signed = await sign(t, walletApp(phone.address, phone, seen))
    expect(signed.uid).toMatch(/^0x[0-9a-f]{112}$/)
    expect(seen[0]?.types.EIP712Domain).toBeDefined() // eth_signTypedData_v4 format
    expect(seen[0]?.message.sellAmount).toBe('100000000') // numbers as text for the wallet
    expect(seen[0]?.domain.verifyingContract).toBe(t.built.signing.domain.verifyingContract)
  })

  test('a signature from any other key is refused before anything is sent', async () => {
    const phone = privateKeyToAccount(generatePrivateKey())
    const impostor = privateKeyToAccount(generatePrivateKey())
    orderbook({ sellAmount: '99000000', feeAmount: '1000000', buyAmount: '100000' })
    const t = await prepare({ ...request, owner: phone.address })
    await expect(sign(t, walletApp(phone.address, impostor))).rejects.toThrow('did not come from the connected address')
  })
})

describe('safety', () => {
  test('pinned wrapped tokens are valid EIP-55 and cover every tradeable chain but Arc', () => {
    for (const [address] of Object.values(WRAPPED)) expect(getAddress(address)).toBe(address)
    expect(networks().filter((n) => n.id !== 5042 && !WRAPPED[n.id]).map((n) => n.name)).toEqual([])
  })
  test('foreign text cannot carry terminal control codes or invisible characters', () => {
    const hidden = [0x1b, 0x0d, 0x202e, 0x2066, 0x2060, 0xfeff, 0x00ad, 0x200b, 0xe0041, 0xe0100, 0x1d173, 0xfff9, 0x1bca0, 0x3164]
      .map((c) => String.fromCodePoint(c))
      .join('')
    expect(clean(`US${hidden}DC`)).toBe('USDC')
    expect(clean('Café USDC.e 日本')).toBe('Café USDC.e 日本') // ordinary text is untouched
  })
  test('a relative OPHIS_HOME is refused instead of writing into the current folder', () => {
    const run = Bun.spawnSync(['bun', 'src/main.ts', 'wallet'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, OPHIS_HOME: 'relative/dir' } })
    expect(run.exitCode).toBe(1)
    expect(run.stderr.toString()).toContain('OPHIS_HOME must be a full path')
  })
  test('no code path can read or store a private key', async () => {
    const dir = new URL('../src/', import.meta.url)
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    expect(files).toContain('bridge.ts') // every source file, including any added later
    const sources = await Promise.all(files.map((f) => Bun.file(new URL(f, dir)).text()))
    for (const forbidden of ['privateKeyToAccount', 'generatePrivateKey', 'mnemonicToAccount', 'keystore', 'decryptKey', 'scryptSync']) {
      expect(sources.some((s) => s.includes(forbidden))).toBe(false)
    }
  })
})
