import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { NAV_ITEMS } from './menuConsts'

jest.mock('@lingui/core', () => ({
  i18n: {
    _: (message: { id?: string; message?: string }) => message.id || message.message || '',
  },
}))

jest.mock('@cowprotocol/common-const', () => ({
  ACCOUNT_PROXY_LABEL: 'Account Proxy',
}))

jest.mock('@cowprotocol/ui', () => ({
  BadgeTypes: {
    ALERT: 'ALERT',
  },
  ProductVariant: {
    CowSwap: 'CowSwap',
  },
}))

jest.mock('legacy/components/AppziButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('legacy/components/Version', () => ({
  Version: () => null,
}))

jest.mock('./menuConsts.utils', () => ({
  getSolversExplorerUrl: () => 'https://explorer.cow.fi/solvers',
}))

jest.mock('common/constants/routes', () => ({
  Routes: {
    OTC: '/otc',
    PLAY_COWRUNNER: '/play/cowrunner',
    PLAY_MEVSLICER: '/play/mevslicer',
  },
}))

function getMoreItemHrefs(isSolversEnabled: boolean): string[] {
  const navItems = NAV_ITEMS(SupportedChainId.MAINNET, isSolversEnabled, false)
  const moreItem = navItems[navItems.length - 1]

  if (!moreItem?.children) {
    throw new Error('Missing More menu item')
  }

  return moreItem.children.map((child) => child.href).filter((href): href is string => href !== undefined)
}

describe('NAV_ITEMS', () => {
  it('shows OTC as a direct navigation entry when enabled', () => {
    const navItems = NAV_ITEMS(SupportedChainId.MAINNET, false, true)

    expect(navItems).toContainEqual(expect.objectContaining({ href: '/otc' }))
  })

  it('hides OTC navigation when its kill switch is disabled', () => {
    const navItems = NAV_ITEMS(SupportedChainId.MAINNET, false, false)

    expect(navItems).not.toContainEqual(expect.objectContaining({ href: '/otc' }))
  })

  it('hides solvers menu item when the solvers flag is disabled', () => {
    expect(getMoreItemHrefs(false)).not.toContain('https://explorer.cow.fi/solvers')
  })

  it('shows solvers menu item when the solvers flag is enabled', () => {
    expect(getMoreItemHrefs(true)).toContain('https://explorer.cow.fi/solvers')
  })
})
