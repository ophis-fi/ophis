import { ACCOUNT_PROXY_LABEL } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { BadgeType, BadgeTypes, MenuItem, ProductVariant } from '@cowprotocol/ui'

import { i18n, MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import AppziButton from 'legacy/components/AppziButton'
import { Version } from 'legacy/components/Version'


import { Routes } from 'common/constants/routes'

import { getSolversExplorerUrl } from './menuConsts.utils'

export const PRODUCT_VARIANT = ProductVariant.CowSwap

type UntranslatedMenuItem = {
  label: MessageDescriptor
  children: Array<{
    href: string
    label: MessageDescriptor
    badge?: MessageDescriptor
    badgeType?: BadgeType
    external?: boolean
  }>
}

const ACCOUNT_ITEM = (chainId: SupportedChainId, isAffiliateProgramEnabled: boolean): UntranslatedMenuItem => ({
  label: msg`Account`,
  children: [
    {
      href: '/account',
      label: msg`Overview`,
    },
    ...(isAffiliateProgramEnabled
      ? [
          {
            href: Routes.ACCOUNT_AFFILIATE_TRADER,
            label: msg`My Rewards`,
            badge: msg`New`,
            badgeType: BadgeTypes.ALERT,
          },
        ]
      : []),
    {
      href: '/account/tokens',
      label: msg`Tokens`,
    },
    {
      href: `/${chainId}/account-proxy`,
      label: ACCOUNT_PROXY_LABEL,
    },
  ],
})

const LEARN_ITEM = {
  label: msg`Learn`,
  children: [
    {
      href: 'https://github.com/ophis-fi/ophis',
      label: msg`About Ophis`,
      external: true,
    },
    {
      href: 'https://github.com/ophis-fi/ophis#faq',
      label: msg`FAQs`,
      external: true,
    },
    {
      href: 'https://docs.ophis.fi/',
      label: msg`Docs`,
      external: true,
    },
  ],
}

const MORE_ITEM = (isSolversEnabled: boolean): UntranslatedMenuItem => ({
  label: msg`More`,
  children: [
    ...(isSolversEnabled
      ? [
          {
            href: getSolversExplorerUrl(),
            label: msg`Solvers`,
            external: true,
          },
        ]
      : []),
    {
      href: Routes.PLAY_MEVSLICER,
      label: msg`MEV Slicer`,
    },
  ],
})

export const NAV_ITEMS = (
  chainId: SupportedChainId,
  isAffiliateProgramEnabled: boolean,
  isSolversEnabled: boolean,
): MenuItem[] => {
  const _ACCOUNT_ITEM = ACCOUNT_ITEM(chainId, isAffiliateProgramEnabled)
  const accountItem: MenuItem = {
    label: i18n._(_ACCOUNT_ITEM.label),
    children: _ACCOUNT_ITEM.children.map(({ href, label, badge, badgeType }) => ({
      href,
      label: i18n._(label),
      badge: badge ? i18n._(badge) : undefined,
      badgeType,
    })),
  }

  const learnItem: MenuItem = {
    label: i18n._(LEARN_ITEM.label),
    children: LEARN_ITEM.children.map(({ href, label, external }) => ({
      href,
      label: i18n._(label),
      external,
    })),
  }

  const moreItemConfig = MORE_ITEM(isSolversEnabled)
  const moreItem: MenuItem = {
    label: i18n._(moreItemConfig.label),
    children: moreItemConfig.children.map(({ href, label, external }) => ({
      href,
      label: i18n._(label),
      external,
    })),
  }

  return [accountItem, learnItem, moreItem]
}

export const ADDITIONAL_FOOTER_CONTENT = (
  <>
    <Version />
    <AppziButton />
  </>
)
