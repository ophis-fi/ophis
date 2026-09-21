import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { DEFAULT_TOKENS_LISTS, OPHIS_TOKENS_LIST_SOURCE, UNISWAP_TOKENS_LIST } from '../../const/tokensLists'
import { ListState, TokenListsByChainState } from '../../types'
import { isExcludedListToken } from '../../utils/excludedListTokens'

const PREVIOUS_SOURCES: Record<number, string> = {
  10: 'https://static.optimism.io/optimism.tokenlist.json',
  130: UNISWAP_TOKENS_LIST,
  4663: 'https://swap.ophis.fi/token-lists/robinhood.json',
  [SupportedChainId.SEPOLIA]: 'https://files.cow.fi/token-lists/CowSwapSepolia.json',
}

// TODO: review removal after 2027-09-21, once pre-Ophis browser caches have aged out.
// Normalize the hydrated view before token consumers read it, including offline.
// Persist on successful upsert; avoid racing IndexedDB with a startup side effect.
export function migrateOphisTokenList(
  chainId: SupportedChainId,
  state: TokenListsByChainState[SupportedChainId],
  retainedSources: Set<unknown>,
): TokenListsByChainState[SupportedChainId] {
  const migrated = normalizeCachedLists(chainId, state)
  const source = PREVIOUS_SOURCES[chainId] || 'https://files.cow.fi/tokens/CowSwap.json'
  const previous = migrated[source]

  if (
    !previous ||
    (previous !== 'deleted' && (Object.getPrototypeOf(previous) !== Object.prototype || previous.widgetAppCode))
  ) {
    return migrated
  }
  if (!migrated[OPHIS_TOKENS_LIST_SOURCE]) {
    migrated[OPHIS_TOKENS_LIST_SOURCE] =
      previous === 'deleted' ? previous : { ...previous, source: OPHIS_TOKENS_LIST_SOURCE, priority: 1 }
  }
  // Keep intentionally imported lists and sources still used by curated/widget mode.
  const retained = [...retainedSources].some(
    (value) => typeof value === 'string' && value.toLowerCase() === source.toLowerCase(),
  )
  if (!retained) delete migrated[source]
  return migrated
}

function normalizeCachedLists(
  chainId: SupportedChainId,
  state: TokenListsByChainState[SupportedChainId],
): Record<string, ListState | 'deleted'> {
  return Object.fromEntries(
    Object.entries(state || {}).map(([key, value]) => {
      if (value === 'deleted' || !Array.isArray(value?.list?.tokens)) return [key, value]
      const config = DEFAULT_TOKENS_LISTS[chainId]?.find((item) => item.source === key && !value.widgetAppCode)
      const priority = config?.priority ?? value.priority
      const tokens = value.list.tokens.filter(
        (token) => typeof token?.address === 'string' && !isExcludedListToken(token.chainId, token.address),
      )
      return [key, { ...value, priority, list: { ...value.list, tokens } }]
    }),
  )
}
