import { Wallet } from '@ethersproject/wallet'

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

export const bridgeQuoteWallet = new Wallet(loadOrCreateBridgeQuotePrivateKey())

/**
 * Placeholder owner/recipient for keyless bridge quotes; only ever signs QUOTES
 * (the SDK re-signs the hook with the user's wallet when the order is placed).
 */
export const BRIDGE_QUOTE_ACCOUNT = bridgeQuoteWallet.address
