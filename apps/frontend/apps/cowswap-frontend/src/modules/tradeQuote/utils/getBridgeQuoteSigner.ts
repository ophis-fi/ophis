import { getRpcProvider } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Wallet } from '@ethersproject/wallet'

import { t } from '@lingui/core/macro'

import { bridgeQuoteWallet } from 'common/constants/bridgeQuoteAccount'

export { BRIDGE_QUOTE_ACCOUNT, BRIDGE_QUOTE_PRIVATE_KEY_STORAGE_KEY } from 'common/constants/bridgeQuoteAccount'

/**
 * Upstream's constant bridge-quote account. Its private key is published in the
 * cowswap repo, and sweeper bots EIP-7702-delegated the account on mainnet
 * (2026-05-25) and Base (2026-07-03). The account therefore has code, so
 * sdk-cow-shed's signCalls runs its EIP-1271 pre-check against a delegate that
 * does not implement isValidSignature and rejects EVERY keyless hook quote from
 * those chains: the trade form showed "Error loading price" for each Across
 * (and Bungee) bridge, whatever the destination. Kept only so tests can assert
 * we never fall back to it.
 */
export const LEGACY_BRIDGE_QUOTE_ACCOUNT = '0xD711bD26Bf5B153001a7C0ACcb289782b6f775e9'

const cache = new Map<SupportedChainId, Wallet>()

/**
 * Since bridge quote requires hooks signing, we need a signer that does not ask the user for signing.
 */
export function getBridgeQuoteSigner(chainId: SupportedChainId): Wallet {
  const cached = cache.get(chainId)

  if (cached) return cached

  const provider = getRpcProvider(chainId)

  if (!provider) {
    throw new Error(t`No RPC provider available for chain ID: ${chainId}`)
  }

  const quoteSigner = bridgeQuoteWallet.connect(provider)

  cache.set(chainId, quoteSigner)

  return quoteSigner
}
