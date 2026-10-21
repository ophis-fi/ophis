import {
  POI,
  POINodeInterface,
  type Chain,
  type TXIDVersion,
  type BlindedCommitmentData,
  type POIsPerList,
} from '@railgun-community/engine'
import { balanceForERC20Token, fullWalletForID, pausePPOIBatchingForChain } from '@railgun-community/wallet'
import type { SelectedBroadcaster } from '@railgun-community/shared-models'
import { JsonRpcProvider } from 'ethers'
import { CONFIG, FEE_SIGNER, NETWORK, TOKENS, VERSION, type TokenSymbol } from '../src/config'
import { openWallet, syncWallet, type WalletSession } from '../src/wallet'
import { executePrivateSwap, preparePrivateSwap } from '../src/private-swap'
import { quoteSwap } from '../src/recipe'
import { recoverToken, scanRecovery } from '../src/recovery'
import { prepareUnshield, executeUnshield } from '../src/unshield'
import { pendingSwap, reconcilePendingSwap } from '../src/journal'
import { unusedSwapAccount } from '../src/account'
import { broadcasterFee, type PrivateSubmitter } from '../src/broadcaster'

// Fork shields are absent from the live PPOI service. This fixture never enters the production bundle.
class ForkPOI extends POINodeInterface {
  isActive(): boolean {
    return false
  }
  async isRequired(): Promise<boolean> {
    return false
  }
  async getPOIsPerList(
    _v: TXIDVersion,
    _chain: Chain,
    _keys: string[],
    _notes: BlindedCommitmentData[],
  ): Promise<Record<string, POIsPerList>> {
    return {}
  }
  async getPOIMerkleProofs(): Promise<never> {
    throw new Error('Live PPOI is outside this fork test.')
  }
  async validatePOIMerkleroots(): Promise<boolean> {
    return false
  }
  async submitPOI(): Promise<void> {
    throw new Error('Live PPOI is outside this fork test.')
  }
  async submitLegacyTransactProofs(): Promise<void> {
    throw new Error('Live PPOI is outside this fork test.')
  }
}

const active: { session?: WalletSession } = {}

export async function loadForkSession(password: string): Promise<string> {
  const provider = new JsonRpcProvider(new URL('/rpc', location.origin).href)
  if (!(await provider.send('anvil_metadata', [])).forkedNetwork) throw new Error('A local Ethereum fork is required.')
  active.session = await openWallet(provider, password, undefined)
  pausePPOIBatchingForChain(CONFIG.chain)
  POI.init([], new ForkPOI())
  if (await pendingSwap(active.session)) await reconcilePendingSwap(active.session)
  return active.session.info.railgunAddress
}

function session(): WalletSession {
  if (!active.session) throw new Error('Load the test wallet first.')
  return active.session
}

export async function forkBalance(): Promise<string> {
  const current = session()
  await syncWallet(current)
  return String(
    await balanceForERC20Token(VERSION, fullWalletForID(current.info.id), NETWORK, TOKENS.USDC.address, true),
  )
}

export async function forkWethBalance(): Promise<string> {
  const current = session()
  await syncWallet(current)
  return String(
    await balanceForERC20Token(VERSION, fullWalletForID(current.info.id), NETWORK, TOKENS.WETH.address, true),
  )
}

const localSubmitter: PrivateSubmitter = {
  assertReady: async (current, selected, gas) => {
    if (!(await current.provider.send('anvil_metadata', [])).forkedNetwork)
      throw new Error('Local submission requires Anvil.')
    broadcasterFee(selected, gas)
  },
  send: async (current, populated, _selected, gas) => {
    if (!(await current.provider.send('anvil_metadata', [])).forkedNetwork)
      throw new Error('Local submission requires Anvil.')
    const signer = await current.provider.getSigner(0)
    const transaction = await signer.sendTransaction(populated.transaction)
    await transaction.wait()
    return transaction.hash
  },
}

export async function forkSwap(sell: TokenSymbol, value: string): Promise<string> {
  const current = session()
  const account = await unusedSwapAccount(current)
  const quote = await quoteSwap(current.provider, sell, value, account.address)
  const selected: SelectedBroadcaster = {
    railgunAddress: FEE_SIGNER,
    tokenAddress: TOKENS[sell].address,
    tokenFee: {
      feePerUnitGas: '1000000',
      expiration: Date.now() + 600_000,
      feesID: 'local-test-only',
      availableWallets: 1,
      relayAdapt: CONFIG.relayAdaptContract,
      relayAdapt7702: CONFIG.relayAdapt7702Contract,
      reliability: 1,
    },
  }
  const prepared = await preparePrivateSwap(current, quote, selected)
  return executePrivateSwap(current, prepared, (message) => console.info('[fork-proof]', message), localSubmitter)
}

export async function forkWithdrawal(recipient: string): Promise<string> {
  const current = session()
  const selected: SelectedBroadcaster = {
    railgunAddress: FEE_SIGNER,
    tokenAddress: TOKENS.USDC.address,
    tokenFee: {
      feePerUnitGas: '1000000',
      expiration: Date.now() + 600_000,
      feesID: 'local-test-only',
      availableWallets: 1,
      relayAdapt: CONFIG.relayAdaptContract,
      relayAdapt7702: CONFIG.relayAdapt7702Contract,
      reliability: 1,
    },
  }
  const prepared = await prepareUnshield(current, 'USDC', '1', recipient, selected)
  return executeUnshield(current, prepared, (message) => console.info('[fork-proof]', message), localSubmitter)
}

export async function forkRecovery(index: number): Promise<string> {
  return recoverToken(session(), index, 'USDC')
}

export async function forkAccount(index: number): Promise<string> {
  return (await session().accounts.getAccount(1n, index)).address
}

export async function recoveryStatus(index: number): Promise<string> {
  return scanRecovery(session(), index)
}
