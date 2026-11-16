/** @jest-environment node */
import { RELAY_DAPP_ID, RelayBridgeProvider } from '@cowprotocol/common-const'
import { OrderKind, setGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { CowShedHooks, CowShedSdk } from '@cowprotocol/sdk-cow-shed'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'
import { Interface } from '@ethersproject/abi'
import { keccak256 } from '@ethersproject/keccak256'
import { JsonRpcProvider } from '@ethersproject/providers'
import { toUtf8Bytes } from '@ethersproject/strings'
import { Wallet } from '@ethersproject/wallet'

import { readFileSync } from 'fs'
import { join } from 'path'

import { placeConfirmed } from './ophisAcrossPlacement'
import { signRelayHook } from './ophisRelayHooks.service'

const fixtureRoot = join(__dirname, '../../../../libs/common-const/src/relayBridge/fixtures')
const chains: unknown = JSON.parse(readFileSync(join(fixtureRoot, 'chains.json'), 'utf8'))
const sample = JSON.parse(readFileSync(join(fixtureRoot, 'weth-optimism-base.json'), 'utf8')) as {
  request: { recipient: string; user: string }
  response: unknown
}

const forkTest = process.env.OPHIS_RELAY_FORK_RPC ? it : it.skip
// shortcut: the signed quote expires 2026-11-20; refresh the fixture before a later fork rehearsal.
const TOKEN = '0x4200000000000000000000000000000000000006'
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
])

forkTest(
  'real OP fork: empty shed cannot burn nonce; exact deposit, surplus return and replay protection',
  async () => {
    const rpc = process.env.OPHIS_RELAY_FORK_RPC || ''
    expect(['localhost', '127.0.0.1']).toContain(new URL(rpc).hostname)
    const provider = new JsonRpcProvider(rpc)
    expect(String(await provider.send('web3_clientVersion', []))).toMatch(/anvil/i)
    expect((await provider.getNetwork()).chainId).toBe(10)
    await provider.send('evm_mine', [])
    const snapshot = await provider.send('evm_snapshot', [])
    // Deliberately public test-only key, derived at runtime; never use a funded account.
    const owner = new Wallet(keccak256(toUtf8Bytes('Ophis Relay isolated fork test account')), provider)
    expect(owner.address).toBe(sample.request.recipient)
    await provider.send('anvil_setBalance', [owner.address, '0x56bc75e2d63100000'])
    const adapter = new EthersV5Adapter({ provider, signer: owner })
    setGlobalAdapter(adapter)
    const shed = new CowShedSdk(adapter).getCowShedAccount(10 as SupportedChainId, owner.address)
    expect(shed).toBe(sample.request.user)
    for (const address of [
      TOKEN,
      DEPOSITORY,
      new CowShedHooks(10 as SupportedChainId).getFactoryAddress(),
      '0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963',
    ])
      expect(await provider.getCode(address)).not.toBe('0x')
    const originalFetch = global.fetch
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: { request: async (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) },
      },
    })
    global.fetch = jest.fn(async (input) => ({
      ok: true,
      json: async () => (String(input).endsWith('/chains') ? chains : sample.response),
    })) as jest.Mock
    try {
      const relay = new RelayBridgeProvider({
        enabled: true,
        sourceChainIds: new Set([10]),
        trustedTokens: async () => [],
        signHook: (terms, ...args) => signRelayHook(async () => [], terms, ...args),
      })
      const request: QuoteBridgeRequest = {
        kind: OrderKind.SELL,
        account: owner.address,
        amount: 10n ** 16n,
        sellTokenChainId: 10 as SupportedChainId,
        sellTokenAddress: TOKEN,
        sellTokenDecimals: 18,
        buyTokenChainId: SupportedChainId.BASE,
        buyTokenAddress: TOKEN,
        buyTokenDecimals: 18,
      }
      const quote = await relay.getQuote(request)
      const call = await relay.getUnsignedBridgeCall(request, quote)
      const nonce = keccak256(toUtf8Bytes(`relay-test-${Date.now()}`))
      const deadline = BigInt((await provider.getBlock('latest')).timestamp + 120)
      const shown = { ...quote, providerInfo: relay.info, tradeParameters: request }
      const hook = await placeConfirmed(shown, owner.address, () =>
        relay.getSignedHook(10 as SupportedChainId, call, nonce, deadline, 1_200_000),
      )
      expect(hook.postHook.dappId).toBe(RELAY_DAPP_ID)
      const tx = { to: hook.postHook.target, data: hook.postHook.callData, gasLimit: 1_200_000 }
      await expect((await owner.sendTransaction(tx)).wait()).rejects.toThrow()
      const surplus = 123_456n
      await (
        await owner.sendTransaction({ to: TOKEN, data: '0xd0e30db0', value: String(request.amount + surplus) })
      ).wait()
      await (
        await owner.sendTransaction({
          to: TOKEN,
          data: erc20.encodeFunctionData('transfer', [shed, String(request.amount + surplus)]),
        })
      ).wait()
      const balanceOf = async (address: string): Promise<bigint> =>
        BigInt(await provider.call({ to: TOKEN, data: erc20.encodeFunctionData('balanceOf', [address]) }))
      const before = await balanceOf(DEPOSITORY)
      const receipt = await (await owner.sendTransaction(tx)).wait()
      expect(receipt.status).toBe(1)
      expect(await balanceOf(DEPOSITORY)).toBe(before + request.amount)
      expect(await balanceOf(shed)).toBe(0n)
      expect(await balanceOf(owner.address)).toBe(surplus)
      expect(
        BigInt(await provider.call({ to: TOKEN, data: erc20.encodeFunctionData('allowance', [shed, DEPOSITORY]) })),
      ).toBe(0n)
      const depositLog = receipt.logs.find((log) => log.address.toLowerCase() === DEPOSITORY)
      expect(depositLog?.topics).toEqual([keccak256(toUtf8Bytes('RelayErc20Deposit(address,address,uint256,bytes32)'))])
      expect(depositLog?.data.endsWith(quote.relay.protocol.v2.orderId.slice(2))).toBe(true)
      expect(receipt.gasUsed.toNumber()).toBeLessThan(1_200_000)
      await expect((await owner.sendTransaction(tx)).wait()).rejects.toThrow()
    } finally {
      await provider.send('evm_revert', [snapshot])
      global.fetch = originalFetch
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    }
  },
  60_000,
)
