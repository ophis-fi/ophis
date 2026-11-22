/** @jest-environment node */
import { RELAY_DAPP_ID, RelayBridgeProvider, USDC_BASE, USDT_PLASMA, WETH_PLASMA } from '@cowprotocol/common-const'
import { OrderKind, setGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import { CoWSwapEthFlow__factory } from '@cowprotocol/cowswap-abis'
import { BridgeHook, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { ContractsSigningScheme, InteractionStage, SettlementEncoder } from '@cowprotocol/sdk-contracts-ts'
import { CowShedHooks, CowShedSdk } from '@cowprotocol/sdk-cow-shed'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'
import { Interface } from '@ethersproject/abi'
import { keccak256 } from '@ethersproject/keccak256'
import { JsonRpcProvider } from '@ethersproject/providers'
import { toUtf8Bytes } from '@ethersproject/strings'
import { Wallet } from '@ethersproject/wallet'

import { Contract, utils } from 'ethers'

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
const WETH = '0x4200000000000000000000000000000000000006'
const USDT0 = utils.getAddress(USDT_PLASMA.address)
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const PLASMA_ETH_FLOW = '0x04501b9b1d52e67f6862d157e00d13419d2d6e95'
const PLASMA_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const HOOKS_TRAMPOLINE = '0x60Bf78233f48eC42eE3F101b9a05eC7878728006'
const GAS_LIMIT = 1_200_000
const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
])

async function settlePlasma(
  provider: JsonRpcProvider,
  owner: Wallet,
  adapter: EthersV5Adapter,
  hook: BridgeHook,
  amount: bigint,
  settledBuyAmount: bigint,
  validTo: number,
): Promise<Awaited<ReturnType<JsonRpcProvider['getTransactionReceipt']>>> {
  const settlement = new Contract(
    PLASMA_SETTLEMENT,
    [
      'function authenticator() view returns (address)',
      'function settle(address[],uint256[],(uint256 sellTokenIndex,uint256 buyTokenIndex,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,uint256 flags,uint256 executedAmount,bytes signature)[],(address target,uint256 value,bytes callData)[][3])',
    ],
    owner,
  )
  const authenticator = new Contract(
    await settlement.authenticator(),
    ['function manager() view returns (address)', 'function addSolver(address)'],
    provider,
  )
  const manager: string = await authenticator.manager()
  for (const address of [manager, DEPOSITORY]) {
    await provider.send('anvil_impersonateAccount', [address])
    await provider.send('anvil_setBalance', [address, '0x56bc75e2d63100000'])
  }
  await (await authenticator.connect(provider.getUncheckedSigner(manager)).addSolver(owner.address)).wait()
  const token = new Contract(USDT0, erc20, provider.getUncheckedSigner(DEPOSITORY))
  await (await token.transfer(PLASMA_SETTLEMENT, settledBuyAmount)).wait()
  const ethFlow = CoWSwapEthFlow__factory.connect(PLASMA_ETH_FLOW, owner)
  const wrappedXpl = utils.getAddress(WETH_PLASMA.address)
  const sellAmount = 50n * 10n ** 18n
  const order = {
    buyToken: USDT0,
    receiver: hook.recipient,
    sellAmount,
    buyAmount: amount,
    validTo,
    appData: `0x${'00'.repeat(32)}`,
    feeAmount: 0,
    partiallyFillable: false,
    quoteId: 0,
  }
  await (await ethFlow.createOrder(order, { value: sellAmount })).wait()
  const encoder = new SettlementEncoder(
    { name: 'Gnosis Protocol', version: 'v2', chainId: SupportedChainId.PLASMA, verifyingContract: PLASMA_SETTLEMENT },
    adapter,
  )
  encoder.encodeTrade(
    {
      ...order,
      sellToken: wrappedXpl,
      validTo: 2 ** 32 - 1,
      kind: OrderKind.SELL,
    },
    { scheme: ContractsSigningScheme.EIP1271, data: { verifier: ethFlow.address, signature: '0x' } },
  )
  encoder.encodeInteraction(
    { target: ethFlow.address, callData: utils.id('wrapAll()').slice(0, 10), value: 0 },
    InteractionStage.PRE,
  )
  const trampoline = new Interface(['function execute((address,bytes,uint256)[])'])
  const { target, callData, gasLimit } = hook.postHook
  encoder.encodeInteraction(
    {
      target: HOOKS_TRAMPOLINE,
      callData: trampoline.encodeFunctionData('execute', [[[target, callData, gasLimit]]]),
      value: 0,
    },
    InteractionStage.POST,
  )
  const settlementData = encoder.encodedSettlement({ [wrappedXpl]: settledBuyAmount, [USDT0]: sellAmount })
  return (await settlement.settle(...settlementData, { gasLimit: 2_000_000 })).wait()
}

forkTest(
  'real fork: empty shed cannot burn nonce; exact deposit, surplus return and replay protection',
  async () => {
    const rpc = process.env.OPHIS_RELAY_FORK_RPC || ''
    expect(['localhost', '127.0.0.1']).toContain(new URL(rpc).hostname)
    const provider = new JsonRpcProvider(rpc)
    expect(String(await provider.send('web3_clientVersion', []))).toMatch(/anvil/i)
    const { chainId } = await provider.getNetwork()
    expect([10, SupportedChainId.PLASMA]).toContain(chainId)
    const plasma = chainId === SupportedChainId.PLASMA
    const source = plasma ? SupportedChainId.PLASMA : SupportedChainId.OPTIMISM
    const token = plasma ? USDT0 : WETH
    await provider.send('evm_mine', [])
    const snapshot = await provider.send('evm_snapshot', [])
    // Deliberately public test-only key, derived at runtime; never use a funded account.
    const owner = new Wallet(keccak256(toUtf8Bytes('Ophis Relay isolated fork test account')), provider)
    if (!plasma) expect(owner.address).toBe(sample.request.recipient)
    await provider.send('anvil_setBalance', [owner.address, '0x56bc75e2d63100000'])
    const adapter = new EthersV5Adapter({ provider, signer: owner })
    setGlobalAdapter(adapter)
    const shed = new CowShedSdk(adapter).getCowShedAccount(source, owner.address)
    if (!plasma) expect(shed).toBe(sample.request.user)
    for (const address of [
      token,
      DEPOSITORY,
      new CowShedHooks(source).getFactoryAddress(),
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
    if (!plasma) {
      global.fetch = jest.fn(async (input) => ({
        ok: true,
        json: async () => (String(input).endsWith('/chains') ? chains : sample.response),
      })) as jest.Mock
    }
    try {
      const relay = new RelayBridgeProvider({
        enabled: true,
        apiUrl: plasma ? 'https://swap.ophis.fi/api/relay' : undefined,
        isSourceRouteEnabled: (origin, destination) => origin === source && destination === SupportedChainId.BASE,
        trustedTokens: async () => (plasma ? [USDT_PLASMA, USDC_BASE] : []),
        signHook: (terms, ...args) => signRelayHook(async () => [], terms, ...args),
      })
      const request: QuoteBridgeRequest = {
        kind: OrderKind.SELL,
        account: owner.address,
        amount: plasma ? 2_100_000n : 10n ** 16n,
        sellTokenChainId: source,
        sellTokenAddress: token,
        sellTokenDecimals: plasma ? 6 : 18,
        buyTokenChainId: SupportedChainId.BASE,
        buyTokenAddress: plasma ? USDC_BASE.address : token,
        buyTokenDecimals: plasma ? 6 : 18,
      }
      const quote = await relay.getQuote(request)
      const call = await relay.getUnsignedBridgeCall(request, quote)
      const nonce = keccak256(toUtf8Bytes(`relay-test-${Date.now()}`))
      const deadline = BigInt((await provider.getBlock('latest')).timestamp + 120)
      const shown = { ...quote, providerInfo: relay.info, tradeParameters: request }
      const hook = await placeConfirmed(shown, owner.address, () =>
        relay.getSignedHook(source, call, nonce, deadline, GAS_LIMIT),
      )
      expect(hook.postHook.dappId).toBe(RELAY_DAPP_ID)
      const tx = { to: hook.postHook.target, data: hook.postHook.callData, gasLimit: GAS_LIMIT }
      await expect((await owner.sendTransaction(tx)).wait()).rejects.toThrow()
      const surplus = 123_456n
      const balanceOf = async (address: string): Promise<bigint> =>
        BigInt(await provider.call({ to: token, data: erc20.encodeFunctionData('balanceOf', [address]) }))
      const before = await balanceOf(DEPOSITORY)
      let receipt
      if (plasma) {
        receipt = await settlePlasma(
          provider,
          owner,
          adapter,
          hook,
          request.amount,
          request.amount + surplus,
          Number(deadline),
        )
      } else {
        await (
          await owner.sendTransaction({ to: token, data: '0xd0e30db0', value: String(request.amount + surplus) })
        ).wait()
        await (
          await owner.sendTransaction({
            to: token,
            data: erc20.encodeFunctionData('transfer', [shed, String(request.amount + surplus)]),
          })
        ).wait()
        receipt = await (await owner.sendTransaction(tx)).wait()
      }
      expect(receipt.status).toBe(1)
      expect(await balanceOf(DEPOSITORY)).toBe(plasma ? before - surplus : before + request.amount)
      expect(await balanceOf(shed)).toBe(0n)
      expect(await balanceOf(owner.address)).toBe(surplus)
      expect(
        BigInt(await provider.call({ to: token, data: erc20.encodeFunctionData('allowance', [shed, DEPOSITORY]) })),
      ).toBe(0n)
      const depositLog = receipt.logs.find((log) => log.address.toLowerCase() === DEPOSITORY)
      expect(depositLog?.topics).toEqual([keccak256(toUtf8Bytes('RelayErc20Deposit(address,address,uint256,bytes32)'))])
      expect(depositLog?.data.endsWith(quote.relay.protocol.v2.orderId.slice(2))).toBe(true)
      expect(receipt.gasUsed.toNumber()).toBeLessThan(GAS_LIMIT)
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
