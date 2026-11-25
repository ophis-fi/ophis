import { walletConnectSvg } from '@cowprotocol/wallet'

import { solanaPairingChain, type SolanaWalletNetwork } from 'entities/solana'
import { verifySolanaMessage } from 'entities/solana/verifySolanaMessage'
import { utils } from 'ethers'

import type { OphisSolanaWallet, OphisSolanaWalletAccount } from '@ophis/solana-sdk'
import type SignClient from '@walletconnect/sign-client'

const method = 'solana_signAndSendTransaction'
const feature = 'solana:signAndSendTransaction'
const messageMethod = 'solana_signMessage'
const messageFeature = 'solana:signMessage'
type Session = ReturnType<SignClient['session']['get']>
let clientPromise: Promise<SignClient> | undefined

function getClient(projectId: string): Promise<SignClient> {
  clientPromise ??= import('@walletconnect/sign-client')
    .then(({ default: Client }) =>
      Client.init({
        projectId,
        customStoragePrefix: 'ophis-solana',
        metadata: {
          name: 'Ophis',
          description: 'Ophis Solana swaps',
          url: location.origin,
          icons: [location.origin + '/ophis-logo-alt.svg'],
        },
      }),
    )
    .catch((error: unknown) => {
      clientPromise = undefined
      throw error
    })
  return clientPromise
}

function sessionAccounts(
  session: Session,
  chainId: string,
  chain: SolanaWalletNetwork['chain'],
): OphisSolanaWalletAccount[] {
  if (session.expiry * 1000 <= Date.now()) return []
  const namespace = session.namespaces[chainId] ?? session.namespaces.solana
  if (!namespace?.methods.includes(method)) return []
  return namespace.accounts
    .filter((id) => id.startsWith(chainId + ':'))
    .map((id) => {
      const address = id.slice(chainId.length + 1)
      const publicKey = utils.base58.decode(address)
      if (publicKey.length !== 32) throw Error('WalletConnect returned an invalid Solana account.')
      return {
        address,
        publicKey,
        chains: [chain],
        features: namespace.methods.includes(messageMethod) ? [feature, messageFeature] : [feature],
      }
    })
}

async function approveSession(
  client: SignClient,
  chainId: string,
  onUri: (uri: string) => void,
  signal: AbortSignal,
): Promise<Session> {
  const { uri, approval } = await client.connect({
    requiredNamespaces: { solana: { chains: [chainId], methods: [method], events: [] } },
    optionalNamespaces: { solana: { chains: [chainId], methods: [messageMethod], events: [] } },
  })
  const pairingTopic = uri?.match(/^wc:([^@]+)@/)?.[1]
  const cancelPairing = (): void => {
    // A session already settling is disconnected separately below.
    if (pairingTopic) void client.core.pairing.disconnect({ topic: pairingTopic }).catch(() => undefined)
  }
  signal.addEventListener('abort', cancelPairing, { once: true })
  if (signal.aborted) cancelPairing()
  else if (pairingTopic && uri) onUri(uri)
  return approval().finally(() => signal.removeEventListener('abort', cancelPairing))
}

function messageSigning(
  client: SignClient,
  topic: string,
  chainId: string,
  accounts: () => OphisSolanaWalletAccount[],
): NonNullable<OphisSolanaWallet['features']['solana:signMessage']> {
  return {
    version: '1.0.0',
    signMessage: async (...inputs) => {
      const [input] = inputs
      if (
        inputs.length !== 1 ||
        !accounts().some(
          (account) => account.address === input.account.address && account.features.includes(messageFeature),
        )
      )
        throw Error('Reconnect a WalletConnect wallet that supports Solana message signing.')
      const result = await client.request<{ signature: string }>({
        topic,
        chainId,
        request: {
          method: messageMethod,
          params: { pubkey: input.account.address, message: utils.base58.encode(input.message) },
        },
      })
      const signature = utils.base58.decode(result.signature)
      if (signature.length !== 64) throw Error('WalletConnect returned an invalid message signature.')
      await verifySolanaMessage(input.account.address, signature, input.message)
      return [{ signature, signedMessage: input.message }]
    },
  }
}

export async function pairSolanaWallet(
  config: SolanaWalletNetwork,
  projectId: string,
  onUri: (uri: string) => void,
  signal: AbortSignal,
): Promise<OphisSolanaWallet> {
  const chainId = solanaPairingChain(config)
  if (!chainId || !projectId) throw Error('WalletConnect is unavailable on this network.')
  const client = await getClient(projectId)
  signal.throwIfAborted()
  const { topic } = await approveSession(client, chainId, onUri, signal)
  const disconnect = async (): Promise<void> => {
    await client.disconnect({ topic, reason: { code: 6000, message: 'Disconnected from Ophis' } })
  }
  const accounts = (): OphisSolanaWalletAccount[] => sessionAccounts(client.session.get(topic), chainId, config.chain)
  try {
    signal.throwIfAborted()
    if (!accounts().length) throw Error('The wallet must approve Solana transactions on the selected network.')
  } catch (error: unknown) {
    await disconnect()
    throw error
  }
  const signing = accounts().some((account) => account.features.includes(messageFeature))
    ? messageSigning(client, topic, chainId, accounts)
    : undefined
  return {
    version: '1.0.0',
    name: 'WalletConnect',
    icon: `data:image/svg+xml;base64,${btoa(walletConnectSvg)}`,
    chains: [config.chain],
    get accounts() {
      return accounts()
    },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: accounts() }) },
      'standard:disconnect': { version: '1.0.0', disconnect },
      'standard:events': {
        version: '1.0.0',
        on: (_event, listener) => {
          const changed = (event: { topic: string }): void => {
            if (topic === event.topic) listener({ accounts: [] })
          }
          const events = ['session_update', 'session_delete', 'session_expire', 'session_event'] as const
          events.forEach((name) => client.on(name, changed))
          return () => events.forEach((name) => client.off(name, changed))
        },
      },
      ...(signing ? { [messageFeature]: signing } : {}),
      [feature]: {
        version: '1.0.0',
        supportedTransactionVersions: [0],
        signAndSendTransaction: async (...inputs) => {
          const [input] = inputs
          if (
            inputs.length !== 1 ||
            input.chain !== config.chain ||
            !accounts().some((a) => a.address === input.account.address)
          )
            throw Error('Reconnect WalletConnect on the selected Solana network.')
          const result = await client.request<{ signature: string }>({
            topic,
            chainId,
            request: {
              method,
              params: { transaction: utils.base64.encode(input.transaction), options: input.options },
            },
          })
          const signature = utils.base58.decode(result.signature)
          if (signature.length !== 64) throw Error('WalletConnect returned an invalid transaction signature.')
          return [{ signature }]
        },
      },
    },
  }
}
