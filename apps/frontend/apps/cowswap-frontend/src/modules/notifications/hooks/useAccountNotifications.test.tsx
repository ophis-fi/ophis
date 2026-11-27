import type { PropsWithChildren, ReactNode } from 'react'

import { getAccountNotifications } from '@cowprotocol/core'

import { renderHook } from '@testing-library/react'
import { SWRConfig, unstable_serialize } from 'swr'

import { useAccountNotifications } from './useAccountNotifications'

const mockAccount = '0x0000000000000000000000000000000000000001'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ account: mockAccount }) }))
jest.mock('@cowprotocol/core', () => ({ getAccountNotifications: jest.fn().mockResolvedValue([]) }))

function CachedCampaign({ children }: PropsWithChildren): ReactNode {
  const key = unstable_serialize([mockAccount, 'account-notifications'])
  return <SWRConfig value={{ fallback: { [key]: [{ id: 1, title: 'Upstream campaign' }] } }}>{children}</SWRConfig>
}

it('ignores cached upstream campaigns and never requests the feed with the connected wallet', () => {
  const { result } = renderHook(useAccountNotifications, { wrapper: CachedCampaign })

  expect(result.current).toEqual([])
  expect(getAccountNotifications).not.toHaveBeenCalled()
})
