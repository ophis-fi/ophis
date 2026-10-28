import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Contract, JsonRpcProvider, Wallet } from 'ethers'
import { RelayAdapt7702ExecutionType, RelayAdapt7702Helper } from '@railgun-community/engine'
import { ADAPT, encodeRequest } from './execution'
import { CHAIN, CHAIN_ID, CONFIG, WRAPPED_SYMBOL } from './config'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ remove: vi.fn(), ratchet: vi.fn(), pending: undefined as unknown }))
vi.mock('./storage', () => ({ readPrivateState: async () => state.pending, deletePrivateState: state.remove }))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...(await original<typeof import('@railgun-community/wallet')>()),
  fullWalletForID: () => ({ setEphemeralKeyIndexIfGreater: state.ratchet }),
}))
import { cancelPendingSwap } from './cancel'

const url = new URL(process.env.RAILGUN_FORK_RPC_URL || 'http://127.0.0.1:8549')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Fork tests require loopback RPC.')
const provider = new JsonRpcProvider(url.href, CHAIN_ID, { cacheTimeout: -1 })
// Anvil can forward a not-yet-indexed local receipt upstream; free archive RPCs reject unknown hashes.
const localTransactions = new Set<string>()
const originalSend = provider.send.bind(provider)
vi.spyOn(provider, 'send').mockImplementation(async (method, params) => {
  try {
    const result: unknown = await originalSend(method, params)
    if (['eth_sendRawTransaction', 'eth_sendTransaction'].includes(method) && typeof result === 'string') localTransactions.add(result)
    return result
  } catch (error) {
    if (method === 'eth_getTransactionReceipt' && Array.isArray(params) && localTransactions.has(String(params[0])) && String(error).includes('Archive requests require a personal token')) return null
    throw error
  }
})
let snapshot: string | undefined
beforeAll(async () => {
  if (process.env.RAILGUN_FORK_TEST !== '1') return
  if (!(await provider.send('anvil_metadata', [])).forkedNetwork) throw new Error('Anvil fork required')
  snapshot = await provider.send('evm_snapshot', [])
})
afterAll(async () => {
  if (snapshot) {
    await provider.send('evm_setIntervalMining', [0])
    await provider.send('evm_setAutomine', [true])
    await provider.send('evm_revert', [snapshot])
  }
  provider.destroy()
})

it.skipIf(process.env.RAILGUN_FORK_TEST !== '1')(
  'invalidates a previously signed execution before clearing an unknown swap',
  async () => {
    const owner = Wallet.createRandom()
    const account = owner.address
    state.pending = {
      index: 0,
      account,
      chainId: CHAIN_ID,
      token: WRAPPED_SYMBOL,
      minimum: '1',
      npk: `0x${'11'.repeat(32)}`,
      executeNonce: '0',
      fromBlock: await provider.getBlockNumber(),
    }
    const session = {
      info: { id: 'test' },
      provider,
      accounts: { getAccount: async () => ({ address: account, signer: owner }) },
    } as unknown as WalletSession
    const actionData = RelayAdapt7702Helper.getActionData(
      true,
      [{ to: account, data: ADAPT.encodeFunctionData('nonce'), value: 0n }],
      0n,
    )
    const details = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
    const authorization = await RelayAdapt7702Helper.signEIP7702Authorization(
      owner,
      CONFIG.relayAdapt7702Contract,
      CHAIN,
      0,
    )
    const executionSignature = await RelayAdapt7702Helper.signExecutionAuthorization(owner, [], actionData, CHAIN, details)
    const old = encodeRequest({
      ...details,
      authorization,
      executionSignature,
      actionData,
      transactions: [],
      ephemeralAddress: account,
    })
    const sponsor = await provider.getSigner(0)
    await expect(cancelPendingSwap(session, false)).rejects.toThrow(/Acknowledge/)
    await expect(cancelPendingSwap(session, true)).rejects.toThrow(/Fund recovery account/)
    await provider.send('anvil_setBalance', [account, '0xde0b6b3a7640000'])
    // Auto-mine the receipt locally; an extra block satisfies the two-confirmation guard.
    const mining = setInterval(() => { void provider.send('evm_mine', []).catch(() => {}) }, 100)
    try {
      await expect(cancelPendingSwap(session, true)).resolves.toMatch(/invalidated/)
    } finally { clearInterval(mining) }
    expect(await new Contract(account, ADAPT, provider).getFunction('nonce')()).toBe(1n)
    const replay = await sponsor.sendTransaction({ ...old, gasLimit: 300_000n })
    await expect(replay.wait()).rejects.toThrow()
    expect(state.remove).toHaveBeenCalledOnce()
    expect(state.ratchet).toHaveBeenCalledWith(CHAIN, 1)
  },
  45_000,
)
