import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { OPHIS_TOKENS_LIST_SOURCE, UNISWAP_TOKENS_LIST } from '../../const/tokensLists'
import { TokenListsByChainState } from '../../types'

const PREVIOUS_SOURCES: Record<number, string> = {
  10: 'https://static.optimism.io/optimism.tokenlist.json',
  130: UNISWAP_TOKENS_LIST,
  4663: 'https://swap.ophis.fi/token-lists/robinhood.json',
  [SupportedChainId.SEPOLIA]: 'https://files.cow.fi/token-lists/CowSwapSepolia.json',
}

// TODO: review removal after 2027-09-21, once pre-Ophis browser caches have aged out.
// Run inside the successful Ophis-list upsert, so an unavailable new list never
// destroys the old cache. The fetched Ophis metadata replaces the seed immediately.
export function migrateOphisTokenList(
  chainId: SupportedChainId,
  state: TokenListsByChainState[SupportedChainId],
  retainedSources: Set<string>,
): TokenListsByChainState[SupportedChainId] {
  const source = PREVIOUS_SOURCES[chainId] || 'https://files.cow.fi/tokens/CowSwap.json'
  const previous = state?.[source]

  if (
    !previous ||
    (previous !== 'deleted' && (Object.getPrototypeOf(previous) !== Object.prototype || previous.widgetAppCode))
  ) {
    return state
  }

  const migrated = { ...state }
  if (!migrated[OPHIS_TOKENS_LIST_SOURCE]) {
    migrated[OPHIS_TOKENS_LIST_SOURCE] =
      previous === 'deleted' ? previous : { ...previous, source: OPHIS_TOKENS_LIST_SOURCE }
  }
  // Keep intentionally imported lists and sources still used by curated/widget mode.
  if (!retainedSources.has(source)) delete migrated[source]
  return migrated
}
