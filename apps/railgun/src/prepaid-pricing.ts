import { calculateMaximumGas, type TransactionGasDetails } from '@railgun-community/shared-models'
import type { PreparedCredit } from './prepaid'

/** Price headroom is part of the reviewed Arbitrum COMMON fee, never added at confirmation. */
export function bufferedArbitrumGasPrice(current: bigint, minimum: bigint, maximum: bigint): bigint {
  if (current <= 0n || minimum < 0n || maximum <= 0n)
    throw new Error('Current gas pricing exceeds the reviewed prepaid limit.')
  const buffered = (current * 110n + 99n) / 100n + 1n
  const target = minimum > buffered ? minimum : buffered
  const price = target > maximum ? maximum : target
  if (price < minimum || price < current + 1n)
    throw new Error('Current gas pricing exceeds the reviewed prepaid limit.')
  return price
}

// Keep quote arithmetic independent of browser storage and transport setup.
export function prepaidAttemptFee(credit: PreparedCredit, gas: TransactionGasDetails): bigint {
  const maximum = credit.scope.chainId === 8453 && credit.scope.funding === 'native'
    ? credit.maximumGasCost : calculateMaximumGas(gas)
  return ((maximum + credit.collectionAllowance) * credit.rate + 10n ** 18n - 1n) / 10n ** 18n
}
