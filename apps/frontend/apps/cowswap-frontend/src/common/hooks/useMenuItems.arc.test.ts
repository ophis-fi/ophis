import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'

import { useMenuItems } from './useMenuItems'

import { Routes } from '../constants/routes'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn() }))
jest.mock('@cowprotocol/common-hooks', () => ({ useFeatureFlags: () => ({ isYieldEnabled: false }) }))
jest.mock('legacy/state/user/hooks', () => ({ useHooksEnabled: () => false }))
jest.mock('@lingui/react', () => ({ useLingui: () => ({ i18n: { _: (value: unknown) => value } }) }))

it('does not offer undeployed TWAP contracts on Arc', () => {
  jest.mocked(useWalletInfo).mockReturnValue({ chainId: ARC_CHAIN_ID } as ReturnType<typeof useWalletInfo>)
  const { result } = renderHook(useMenuItems)
  expect(result.current.some((item) => item.route === Routes.ADVANCED_ORDERS)).toBe(false)
  expect(result.current.some((item) => item.route === Routes.SWAP)).toBe(true)
})
