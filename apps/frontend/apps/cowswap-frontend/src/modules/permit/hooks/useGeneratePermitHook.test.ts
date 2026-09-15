import { generatePermitHook, getPermitUtilsInstance } from '@cowprotocol/permit-utils'

import { renderHook } from '@testing-library/react'

import { useGeneratePermitHook } from './useGeneratePermitHook'
import { useGetCachedPermit } from './useGetCachedPermit'

jest.mock('jotai', () => ({ useAtomValue: jest.fn(), useSetAtom: () => jest.fn() }))
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ chainId: 1 }) }))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: () => ({}) }))
jest.mock('@cowprotocol/permit-utils', () => ({
  generatePermitHook: jest.fn(),
  getPermitUtilsInstance: jest.fn(),
  isSupportedPermitInfo: () => true,
}))
jest.mock('./useGetCachedPermit', () => ({ useGetCachedPermit: jest.fn() }))
jest.mock('../state/permitCacheAtom', () => ({
  staticPermitCacheAtom: {},
  storePermitCacheAtom: {},
  userPermitCacheAtom: {},
}))

it.each([0n, 10000000n])('rejects finite DAI amount %s before reading an old cached permit', async (amount) => {
  const getCachedPermit = jest.fn().mockResolvedValue({ callData: 'old-unlimited-dai-permit' })
  jest.mocked(useGetCachedPermit).mockReturnValue(getCachedPermit)
  const { result } = renderHook(useGeneratePermitHook)

  expect(
    await result.current({
      inputToken: { address: '0x1234567890123456789012345678901234567890', name: 'DAI' },
      account: '0x1111111111111111111111111111111111111111',
      permitInfo: { type: 'dai-like' },
      amount,
    }),
  ).toBeUndefined()
  expect(getCachedPermit).not.toHaveBeenCalled()
  expect(getPermitUtilsInstance).not.toHaveBeenCalled()
  expect(generatePermitHook).not.toHaveBeenCalled()
})
