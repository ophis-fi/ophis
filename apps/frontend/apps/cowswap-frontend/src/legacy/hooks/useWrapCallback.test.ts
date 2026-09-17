import { NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'
import { BigNumber } from '@ethersproject/bignumber'

import { wrapUnwrapCallback, WrapUnwrapContext } from './useWrapCallback'

jest.mock('@cowprotocol/tokens', () => ({ getChainCurrencySymbols: () => ({ native: 'ETH', wrapped: 'WETH' }) }))
jest.mock('common/services/logEthSendingTransaction', () => ({
  logEthSendingIntention: () => 'test',
  logEthSendingTransaction: jest.fn(),
}))

it('checks the deposit balance while leaving gas payment to the wallet', async () => {
  const account = '0x1111111111111111111111111111111111111111'
  const sendTransaction = jest.fn().mockResolvedValue({ hash: '0x1234' })
  const getBalance = jest.fn().mockResolvedValue(BigNumber.from(1000))
  const getAddress = jest.fn().mockResolvedValue(account)
  const getNetwork = jest.fn().mockResolvedValue({ chainId: 1 })
  const context = {
    chainId: 1,
    account,
    amount: CurrencyAmount.fromRawAmount(NATIVE_CURRENCIES[1], '1000'),
    wethContract: {
      provider: { getBalance, getNetwork },
      signer: { getAddress, sendTransaction },
      estimateGas: { deposit: jest.fn().mockResolvedValue(BigNumber.from(50000)) },
      populateTransaction: { deposit: jest.fn().mockImplementation((tx) => tx) },
    },
    analytics: { sendEvent: jest.fn() },
    addTransaction: jest.fn(),
    closeModals: jest.fn(),
    openTransactionConfirmationModal: jest.fn(),
  } as unknown as WrapUnwrapContext

  await expect(wrapUnwrapCallback(context)).resolves.toEqual({ hash: '0x1234' })
  expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ value: '0x3e8', chainId: 1 }))
  sendTransaction.mockClear()
  getBalance.mockResolvedValue(BigNumber.from(999))
  await expect(wrapUnwrapCallback(context)).rejects.toThrow('Insufficient balance to wrap')
  getBalance.mockResolvedValue(BigNumber.from(1000))
  getAddress.mockResolvedValue('0x2222222222222222222222222222222222222222')
  await expect(wrapUnwrapCallback(context)).rejects.toThrow('Wallet account changed')
  expect(sendTransaction).not.toHaveBeenCalled()
})
