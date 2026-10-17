import { getAddressKey } from '@cowprotocol/cow-sdk'

import { HOOKS_UNSAVED } from './ophisAcrossConstants'

// The bridge hooks this browser placed, per wallet: an earlier hook that can
// still run would carry a later bridge's output, to its own recipient and at
// its own fee. The orderbook alone cannot show them all: a native ETH order is
// listed only once mined, and anyone can push an order out of the newest ones
// with pre-sign orders "from" the wallet. Each record is kept until its
// deadline passes: one whose nonce is used blocks nothing but stays, so a reorg
// that undoes that use still finds it. Kept per wallet (each wallet's
// placements run under its own lock); a browser that cannot keep them places
// no bridge. Read straight from localStorage on every check, not through an
// atomWithStorage value: the app's storage adapter does not sync tabs, and it
// reads unreadable storage as the initial value, while this check must see a
// hook another tab recorded a moment ago and must refuse what it cannot read.
type PlacedHook = { chainId: number; nonce: string; deadline: string }
const hooksKey = (owner: string): string => `ophisBridgeHooks:v0:${getAddressKey(owner)}`
// The shape rememberHook writes; any other entry is no hook this browser placed.
function isPlacedHook(entry: unknown): entry is PlacedHook {
  const { chainId, nonce, deadline } = (entry ?? {}) as Record<string, unknown>
  return (
    Number.isSafeInteger(chainId) &&
    Number(chainId) > 0 &&
    typeof nonce === 'string' &&
    /^0x[0-9a-f]{64}$/.test(nonce) &&
    typeof deadline === 'string' &&
    /^[0-9]{1,20}$/.test(deadline)
  )
}
export function loadHooks(owner: string): PlacedHook[] {
  try {
    const hooks: unknown = JSON.parse(localStorage.getItem(hooksKey(owner)) ?? '[]')
    if (Array.isArray(hooks)) return hooks.filter(isPlacedHook)
  } catch {
    // unreadable: refused below rather than taken for no hooks
  }
  throw new Error(HOOKS_UNSAVED)
}
export function saveHooks(owner: string, hooks: PlacedHook[]): void {
  try {
    localStorage.setItem(hooksKey(owner), JSON.stringify(hooks))
  } catch {
    throw new Error(HOOKS_UNSAVED)
  }
}
export function rememberHook(owner: string, hook: PlacedHook): void {
  const others = loadHooks(owner).filter((kept) => kept.chainId !== hook.chainId || kept.nonce !== hook.nonce)
  saveHooks(owner, [...others, hook])
}
