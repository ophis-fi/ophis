import { useMemo } from 'react'

import { UNSUPPORTED_TOKENS_FAQ_URL } from '@cowprotocol/common-const'
import { useExtractText } from '@cowprotocol/common-utils'
import { TagInfo, TokenListTags } from '@cowprotocol/tokens'
import { getStatusColorEnums, HoverTooltip, StatusColorVariant } from '@cowprotocol/ui'

import { msg } from '@lingui/core/macro'
import ICON_GAS_FREE from 'assets/icon/gas-free.svg'
import SVG from 'react-inlinesvg'
import { NavLink } from 'react-router'

import * as styledEl from './styled'

import { TokenizedAssetProviderTag } from '../../types'

// Programmatic tags that don't come from tokenlists
const APP_TOKEN_TAGS: TokenListTags = {
  unsupported: {
    name: msg`Unsupported`,
    description: msg`This token is unsupported and may not settle reliably. See the FAQ for details.`,
    id: '0',
    color: StatusColorVariant.Warning,
  },
  'gas-free': {
    name: msg`Gas-free`,
    icon: ICON_GAS_FREE,
    description: msg`This token supports a wallet signature instead of a separate gas-paid approval transaction.`,
    id: '1',
    color: StatusColorVariant.Success,
  },
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function TokenTags({
  isUnsupported,
  isPermitCompatible,
  tags = [],
  tokenListTags,
  tokenizedAssetProvider,
}: {
  isUnsupported: boolean
  isPermitCompatible?: boolean
  tags?: string[]
  tokenListTags: TokenListTags
  tokenizedAssetProvider?: TokenizedAssetProviderTag
}) {
  const tagsToShow = useMemo(() => {
    const tokenTags = tokenizedAssetProvider ? [...new Set([...tags, tokenizedAssetProvider])] : tags

    return isUnsupported
      ? [APP_TOKEN_TAGS.unsupported]
      : [
          // Include valid tags from token.tags
          ...tokenTags.filter((tag) => tag in tokenListTags).map((tag) => tokenListTags[tag]),
          // Add gas-free tag if applicable
          ...(isPermitCompatible ? [APP_TOKEN_TAGS['gas-free']] : []),
        ]
  }, [isUnsupported, tags, tokenListTags, isPermitCompatible, tokenizedAssetProvider])

  if (tagsToShow.length === 0) return null

  return (
    <TagDescriptor tags={tagsToShow}>
      {isUnsupported && (
        <styledEl.TagLink colorEnums={getStatusColorEnums(StatusColorVariant.Default)}>
          <NavLink to={UNSUPPORTED_TOKENS_FAQ_URL} target="_blank">
            FAQ
          </NavLink>
        </styledEl.TagLink>
      )}
    </TagDescriptor>
  )
}

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function TagDescriptor({ tags, children }: { children?: React.ReactNode; tags: TagInfo[] }) {
  const { extractTextFromStringOrI18nDescriptor } = useExtractText()

  return (
    <styledEl.TagContainer>
      {tags.map((tag) => {
        const colorEnums = getStatusColorEnums(tag.color || StatusColorVariant.Default)
        return (
          <HoverTooltip wrapInContainer key={tag.id} content={extractTextFromStringOrI18nDescriptor(tag.description)}>
            <styledEl.Tag tag={tag} colorEnums={colorEnums}>
              {tag.icon ? <SVG src={tag.icon} title={extractTextFromStringOrI18nDescriptor(tag.name)} /> : null}
              {extractTextFromStringOrI18nDescriptor(tag.name)}
            </styledEl.Tag>
          </HoverTooltip>
        )
      })}
      {children}
    </styledEl.TagContainer>
  )
}
