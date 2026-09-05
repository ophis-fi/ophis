import { defaultAbiCoder, Interface } from '@ethersproject/abi'
import { hexlify, hexZeroPad } from '@ethersproject/bytes'
import { keccak256 } from '@ethersproject/keccak256'

import { sendSignedForkTransaction, TEST_ADDRESS_NEVER_USE } from './ethereum'

export type Address = `0x${string}`
type Hex = `0x${string}`

interface RpcResponse<T> {
  result?: T
  error?: { message?: string }
}

interface RpcBlock {
  number: Hex
  timestamp: Hex
}

export const OTC_ESCROW: Address = '0x000000fF3D7A2d373615141d7489Ca66683DbecF'
export const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const FORK_MAKER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
export const FORK_RACER: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
export const ONE_WETH = 1_000_000_000_000_000_000n
export const TWO_THOUSAND_USDC = 2_000_000_000n

const WETH_DEPOSIT = '0xd0e30db0'
const PINNED_READ_GAS = '0xea60'
const BALANCE_SLOT_CANDIDATES = 24
const MAX_PREWARMED_ORDERS = 1_000n
const FORK_RPC_URL = Cypress.env('OTC_FORK_RPC_URL') as string
const balanceSlots = new Map<Address, number>()
let rpcId = 0

const ERC20_INTERFACE = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

const OTC_INTERFACE = new Interface([
  'function weth() view returns (address)',
  'function nextOrderId() view returns (uint256)',
  'function getOrders(uint256[] orderIds) view returns (tuple(address maker, bool active, address tokenA, uint256 amountA, address tokenB, uint256 amountB)[] orders)',
  'function createOrder(address tokenA, uint256 amountA, address tokenB, uint256 amountB) returns (uint256 orderId)',
  'function fillOrder(uint256 orderId, uint256 deadline)',
  'function getOrder(uint256 orderId) view returns (tuple(address maker, bool active, address tokenA, uint256 amountA, address tokenB, uint256 amountB) order)',
])

async function rpc<T>(method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(FORK_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
  })
  if (!response.ok) throw new Error(`Fork RPC ${method} returned HTTP ${response.status}`)
  const payload = (await response.json()) as RpcResponse<T>
  if (payload.error || payload.result === undefined) {
    throw new Error(payload.error?.message || `Fork RPC ${method} returned no result`)
  }
  return payload.result
}

async function call(
  to: Address,
  contractInterface: Interface,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<Hex> {
  const data = contractInterface.encodeFunctionData(functionName, args)
  return rpc<Hex>('eth_call', [{ to, data }, 'latest'])
}

async function pinnedCall(
  to: Address,
  contractInterface: Interface,
  functionName: string,
  args: readonly unknown[],
  blockNumber: Hex,
): Promise<Hex> {
  const data = contractInterface.encodeFunctionData(functionName, args)
  return rpc<Hex>('eth_call', [{ to, data, gas: PINNED_READ_GAS }, blockNumber])
}

async function prewarmOtcIdentity(blockNumber: Hex): Promise<void> {
  await rpc<Hex>('eth_getCode', [OTC_ESCROW, blockNumber])
  await pinnedCall(OTC_ESCROW, OTC_INTERFACE, 'weth', [], blockNumber)
}

async function sendUnlocked(from: Address, to: Address, data: Hex, value?: bigint): Promise<void> {
  const transaction = { to, data, ...(value === undefined ? {} : { value }) }
  const hash =
    from === TEST_ADDRESS_NEVER_USE
      ? await sendSignedForkTransaction(transaction)
      : await rpc<Hex>('eth_sendTransaction', [
          { from, to, data, ...(value === undefined ? {} : { value: hexlify(value) }) },
        ])
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const receipt = await rpc<Record<string, unknown> | null>('eth_getTransactionReceipt', [hash])
    if (receipt) {
      if (typeof receipt.status === 'string' && BigInt(receipt.status) === 1n) return
      throw new Error(`Fork fixture transaction reverted: ${hash}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for fork fixture transaction ${hash}`)
}

function mappingStorageKey(account: Address, slot: number): Hex {
  return keccak256(defaultAbiCoder.encode(['address', 'uint256'], [account, slot])) as Hex
}

async function readBalance(token: Address, account: Address): Promise<bigint> {
  const data = await call(token, ERC20_INTERFACE, 'balanceOf', [account])
  return BigInt(ERC20_INTERFACE.decodeFunctionResult('balanceOf', data)[0].toString())
}

/** Locate the proxy's balance mapping on the disposable fork, then fund only the requested test account. */
export async function setForkTokenBalance(token: Address, account: Address, amount: bigint): Promise<void> {
  const cachedSlot = balanceSlots.get(token)
  if (cachedSlot !== undefined) {
    await rpc<null>('anvil_setStorageAt', [
      token,
      mappingStorageKey(account, cachedSlot),
      hexZeroPad(hexlify(amount), 32),
    ])
    if ((await readBalance(token, account)) !== amount)
      throw new Error(`Cached ERC-20 balance slot failed for ${token}`)
    return
  }
  for (let slot = 0; slot < BALANCE_SLOT_CANDIDATES; slot += 1) {
    const snapshot = await rpc<Hex>('evm_snapshot', [])
    await rpc<null>('anvil_setStorageAt', [token, mappingStorageKey(account, slot), hexZeroPad(hexlify(amount), 32)])
    if ((await readBalance(token, account)) === amount) {
      balanceSlots.set(token, slot)
      return
    }
    await rpc<boolean>('evm_revert', [snapshot])
  }
  throw new Error(`Unable to locate ERC-20 balance storage for ${token}`)
}

export async function getNextOtcOrderId(): Promise<bigint> {
  const data = await call(OTC_ESCROW, OTC_INTERFACE, 'nextOrderId')
  return BigInt(OTC_INTERFACE.decodeFunctionResult('nextOrderId', data)[0].toString())
}

export async function fundForkGas(account: Address): Promise<void> {
  await rpc<null>('anvil_setBalance', [account, hexlify(100n * 10n ** 18n)])
}

/** Warm Anvil's remote storage cache; the app still repeats every verified read itself. */
export async function prewarmOtcFork(account: Address): Promise<void> {
  const block = await rpc<RpcBlock>('eth_getBlockByNumber', ['latest', false])
  await prewarmOtcIdentity(block.number)
  const nextOrderId = await getNextOtcOrderId()
  const orderCount = nextOrderId < MAX_PREWARMED_ORDERS ? nextOrderId : MAX_PREWARMED_ORDERS
  const firstOrderId = nextOrderId - orderCount
  const orderIds = Array.from({ length: Number(orderCount) }, (_, offset) => firstOrderId + BigInt(offset))
  for (let offset = 0; offset < orderIds.length; offset += 64) {
    await call(OTC_ESCROW, OTC_INTERFACE, 'getOrders', [orderIds.slice(offset, offset + 64)])
  }
  await pinnedCall(WETH, ERC20_INTERFACE, 'allowance', [account, OTC_ESCROW], block.number)
  await pinnedCall(USDC, ERC20_INTERFACE, 'allowance', [account, OTC_ESCROW], block.number)
  await rpc<RpcBlock>('eth_getBlockByNumber', [block.number, false])
}

/** Prewarm the exact direct-read shape without substituting for the app's verification. */
export async function prewarmOtcForkOrder(account: Address, orderId: bigint): Promise<void> {
  const block = await rpc<RpcBlock>('eth_getBlockByNumber', ['latest', false])
  await prewarmOtcIdentity(block.number)
  await pinnedCall(OTC_ESCROW, OTC_INTERFACE, 'getOrder', [orderId], block.number)
  await pinnedCall(USDC, ERC20_INTERFACE, 'allowance', [account, OTC_ESCROW], block.number)
  await rpc<RpcBlock>('eth_getBlockByNumber', [block.number, false])
}

export async function depositForkWeth(account: Address): Promise<void> {
  await sendUnlocked(account, WETH, WETH_DEPOSIT, ONE_WETH)
}

export async function createWethForUsdcOrder(maker: Address): Promise<bigint> {
  await depositForkWeth(maker)
  await sendUnlocked(maker, WETH, ERC20_INTERFACE.encodeFunctionData('approve', [OTC_ESCROW, ONE_WETH]) as Hex)
  const orderId = await getNextOtcOrderId()
  await sendUnlocked(
    maker,
    OTC_ESCROW,
    OTC_INTERFACE.encodeFunctionData('createOrder', [WETH, ONE_WETH, USDC, TWO_THOUSAND_USDC]) as Hex,
  )
  return orderId
}

export async function fillOtcOrderDirectly(filler: Address, orderId: bigint): Promise<void> {
  await sendUnlocked(
    filler,
    USDC,
    ERC20_INTERFACE.encodeFunctionData('approve', [OTC_ESCROW, TWO_THOUSAND_USDC]) as Hex,
  )
  const block = await rpc<RpcBlock>('eth_getBlockByNumber', ['latest', false])
  await sendUnlocked(
    filler,
    OTC_ESCROW,
    OTC_INTERFACE.encodeFunctionData('fillOrder', [orderId, BigInt(block.timestamp) + 180n]) as Hex,
  )
}

export async function setOtcAllowance(owner: Address, amount: bigint): Promise<void> {
  await sendUnlocked(owner, USDC, ERC20_INTERFACE.encodeFunctionData('approve', [OTC_ESCROW, amount]) as Hex)
}

export async function readOtcAllowance(owner: Address): Promise<bigint> {
  const data = await call(USDC, ERC20_INTERFACE, 'allowance', [owner, OTC_ESCROW])
  return BigInt(ERC20_INTERFACE.decodeFunctionResult('allowance', data)[0].toString())
}

export async function isOtcOrderActive(orderId: bigint): Promise<boolean> {
  const data = await call(OTC_ESCROW, OTC_INTERFACE, 'getOrder', [orderId])
  return OTC_INTERFACE.decodeFunctionResult('getOrder', data).order.active as boolean
}
