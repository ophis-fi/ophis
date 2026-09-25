import { ARC_CHAIN_ID, ARC_CIRBTC, ARC_USYC } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'

// TODO: remove after 2027-09-25, once v4 browser favorites have aged out.
export function migrateArcFavorites(): void {
  try {
    if (localStorage.getItem('favoriteTokensAtom:v5') !== null) return
    const raw = localStorage.getItem('favoriteTokensAtom:v4')
    if (!raw) return
    const stored: unknown = JSON.parse(raw)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return
    const chain = Reflect.get(stored, ARC_CHAIN_ID)
    if (chain && typeof chain === 'object' && !Array.isArray(chain)) {
      Reflect.set(stored, ARC_CHAIN_ID, { ...Object.fromEntries([ARC_CIRBTC, ARC_USYC].map((token) => [getAddressKey(token.address), token])), ...chain })
    }
    localStorage.setItem('favoriteTokensAtom:v5', JSON.stringify(stored))
  } catch {
    // Storage can be disabled; normal in-memory defaults still work.
  }
}
