import { render, waitFor } from '@testing-library/react'

import { RefCodeCaptureUpdater } from './RefCodeCaptureUpdater'

const mockSign = jest.fn()
const mockBind = jest.fn()
const mockMarkBound = jest.fn()
const wallet = '0x1111111111111111111111111111111111111111'

jest.mock('../hooks/useAffiliateWallet', () => ({ useAffiliateWallet: () => ({ account: wallet }) }))
jest.mock('jotai', () => ({
  useAtomValue: (atom: string) =>
    atom === 'saved' ? { [wallet]: { savedCode: 'partner' } } : atom === 'bound' ? () => false : undefined,
  useSetAtom: () => mockMarkBound,
}))
jest.mock('../state/affiliateTraderSavedCodeAtom', () => ({
  affiliatePendingRefCodeAtom: 'pending',
  affiliateTraderSavedCodeByWalletAtom: 'saved',
  setReferralCodeForWalletAtom: 'set',
}))
jest.mock('../state/refBoundWalletsAtom', () => ({ isRefBoundAtom: 'bound', markRefBoundAtom: 'mark' }))
jest.mock('../hooks/useAffiliateTraderCodeFromUrl', () => ({ useAffiliateTraderCodeFromUrl: jest.fn() }))
jest.mock('../lib/affiliateProgramUtils', () => ({ formatRefCode: (code: string) => code }))
jest.mock('../hooks/useOphisAffiliateSign', () => ({ useOphisAffiliateSign: () => mockSign }))
jest.mock('../lib/ophisAffiliateApi', () => ({
  AffiliateApiError: class extends Error {},
  bindRefCode: (body: unknown) => mockBind(body),
}))

it('forwards the signed chain to referral binding', async () => {
  mockSign.mockResolvedValue({ wallet, issued: 123, signature: '0xsigned', chainId: 5042 })
  mockBind.mockResolvedValue({ bound: true, alreadyBound: false })
  render(<RefCodeCaptureUpdater />)
  await waitFor(() =>
    expect(mockBind).toHaveBeenCalledWith({
      referredWallet: wallet,
      code: 'partner',
      issued: 123,
      signature: '0xsigned',
      chainId: 5042,
    }),
  )
  expect(mockSign).toHaveBeenCalledWith('bind referral code partner')
})
