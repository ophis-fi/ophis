import { getRpcProvider } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Wallet } from '@ethersproject/wallet'

import { t } from '@lingui/core/macro'

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

// Same storage key as upstream cowswap (bridgeQuoteSignerAtom), same JSON shape.
export const BRIDGE_QUOTE_PRIVATE_KEY_STORAGE_KEY = 'bridgeQuotePrivateKeyAtom:v1'

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * A key generated in this browser and never published cannot be delegated by
 * anyone else. Persisted so the quote account (and its CoW Shed proxy) stays
 * stable across reloads; storage failures just cost a fresh key per load.
 */
function loadOrCreateBridgeQuotePrivateKey(): string {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(BRIDGE_QUOTE_PRIVATE_KEY_STORAGE_KEY) ?? 'null')
    if (typeof stored === 'string' && PRIVATE_KEY_RE.test(stored)) return stored
  } catch {
    // unreadable or malformed storage: generate below
  }

  const privateKey = Wallet.createRandom().privateKey

  try {
    localStorage.setItem(BRIDGE_QUOTE_PRIVATE_KEY_STORAGE_KEY, JSON.stringify(privateKey))
  } catch {
    // storage unavailable (private mode, quota): the key lives for this load only
  }

  return privateKey
}

const bridgeQuoteWallet = new Wallet(loadOrCreateBridgeQuotePrivateKey())

/**
 * Placeholder owner/recipient for keyless bridge quotes; only ever signs QUOTES
 * (the SDK re-signs the hook with the user's wallet when the order is placed).
 */
export const BRIDGE_QUOTE_ACCOUNT = bridgeQuoteWallet.address

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
