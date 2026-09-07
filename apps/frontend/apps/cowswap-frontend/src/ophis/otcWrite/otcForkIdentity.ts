import { withTimeout } from '@cowprotocol/common-utils'
import type { Web3Provider } from '@ethersproject/providers'

import type { Hex, WalletClient, Transport, Chain, Account } from 'viem'

type WagmiWalletClient = WalletClient<Transport, Chain, Account>

const LOCAL_FORK_CLIENT = /anvil|hardhat/i
const OTC_FORK_ID_TIMEOUT_MS = 10_000

function parseForkId(metadata: unknown): Hex {
  if (!metadata || typeof metadata !== 'object') throw new Error('Ophis OTC fork identity unavailable')
  const { instanceId, chainId, clientVersion } = metadata as Record<string, unknown>
  if (
    chainId !== 1 ||
    typeof clientVersion !== 'string' ||
    !LOCAL_FORK_CLIENT.test(clientVersion) ||
    typeof instanceId !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(instanceId)
  ) {
    throw new Error('Ophis OTC fork identity unavailable')
  }
  return instanceId.toLowerCase() as Hex
}

export async function getOtcWalletForkId(walletClient: WagmiWalletClient): Promise<Hex> {
  const request = walletClient.request as unknown as (request: { method: 'hardhat_metadata' }) => Promise<unknown>
  return parseForkId(
    await withTimeout(
      request({ method: 'hardhat_metadata' }),
      OTC_FORK_ID_TIMEOUT_MS,
      'Ophis OTC fork identity timed out',
    ),
  )
}

export async function getOtcProviderForkId(provider: Web3Provider): Promise<Hex> {
  return parseForkId(
    await withTimeout(
      provider.send('hardhat_metadata', []),
      OTC_FORK_ID_TIMEOUT_MS,
      'Ophis OTC fork identity timed out',
    ),
  )
}

export async function assertForkIdentity(readId: () => Promise<Hex>, expectedId?: Hex): Promise<void> {
  if (expectedId && (await readId()) !== expectedId) throw new Error('Ophis OTC local fork changed')
}

export async function verifyOtcLocalForkWallet(walletClient: WagmiWalletClient): Promise<boolean> {
  const requestClientVersion = walletClient.request as unknown as (request: {
    method: 'web3_clientVersion'
  }) => Promise<unknown>
  const [chainId, clientVersion] = await Promise.all([
    walletClient.getChainId(),
    requestClientVersion({ method: 'web3_clientVersion' }),
  ])
  return chainId === 1 && typeof clientVersion === 'string' && LOCAL_FORK_CLIENT.test(clientVersion)
}

export async function verifyOtcLocalForkProvider(provider: Web3Provider): Promise<boolean> {
  const [network, clientVersion] = await Promise.all([provider.getNetwork(), provider.send('web3_clientVersion', [])])
  return network.chainId === 1 && typeof clientVersion === 'string' && LOCAL_FORK_CLIENT.test(clientVersion)
}
