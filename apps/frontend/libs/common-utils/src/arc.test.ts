import {
  ARC_CHAIN_ID,
  ARC_USDC,
  ARC_EURC,
  ARC_ENABLED,
  NATIVE_CURRENCIES,
  WRAPPED_NATIVE_CURRENCIES,
} from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'

import { getIsNativeToken } from './getIsNativeToken'
import { getIsWrapOrUnwrap } from './getIsWrapOrUnwrap'
import { getWrappedToken } from './getWrappedToken'
import { maxAmountSpend } from './maxAmountSpend'

it('keeps native gas and ERC20 units separate and reserves USDC for gas', () => {
  const gas = NATIVE_CURRENCIES[ARC_CHAIN_ID]
  expect(gas.decimals).toBe(18)
  expect(ARC_USDC.decimals).toBe(6)
  expect(getIsNativeToken(ARC_CHAIN_ID, 'USDC')).toBe(false)
  expect(getIsNativeToken(ARC_USDC)).toBe(false)
  expect(WRAPPED_NATIVE_CURRENCIES[ARC_CHAIN_ID]).toBeUndefined()
  expect(getWrappedToken(gas)).toBe(gas)
  expect(getIsWrapOrUnwrap(ARC_CHAIN_ID, gas, ARC_USDC)).toBe(false)
  expect(maxAmountSpend(CurrencyAmount.fromRawAmount(ARC_USDC, '10000000'))?.quotient.toString()).toBe('9000000')
  expect(maxAmountSpend(CurrencyAmount.fromRawAmount(ARC_USDC, '500000'))?.quotient.toString()).toBe('0')
  expect(maxAmountSpend(CurrencyAmount.fromRawAmount(ARC_EURC, '10000000'))?.quotient.toString()).toBe('10000000')
  expect(ARC_ENABLED).toBe(false)
})
