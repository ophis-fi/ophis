import { TagInfo, TokenListTags } from '@cowprotocol/tokens'

import { STOCK_LABELS } from 'entities/verifiedAsset/verifiedAsset'

import { TokenizedAssetProviderTag } from '../../types'

const TOKENIZED_ASSET_PROVIDER_TAG_IDS = new Set<string>(['circle', ...Object.keys(STOCK_LABELS)])

export function getTrustedTokenTags(
  tags: readonly string[],
  tokenListTags: TokenListTags,
  tokenizedAssetProvider: TokenizedAssetProviderTag | undefined,
): TagInfo[] {
  const nonProviderTags = tags.filter((tag) => !TOKENIZED_ASSET_PROVIDER_TAG_IDS.has(tag))
  const tagsToResolve = tokenizedAssetProvider
    ? [...new Set([...nonProviderTags, tokenizedAssetProvider])]
    : nonProviderTags

  return tagsToResolve.filter((tag) => tag in tokenListTags).map((tag) => tokenListTags[tag])
}
