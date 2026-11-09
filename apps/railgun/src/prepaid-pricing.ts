import { calculateMaximumGas, type TransactionGasDetails } from '@railgun-community/shared-models'
import type { PreparedCredit } from './prepaid'

// Keep quote arithmetic independent of browser storage and transport setup.
export function prepaidAttemptFee(credit: PreparedCredit, gas: TransactionGasDetails): bigint {
  return ((calculateMaximumGas(gas) + credit.collectionAllowance) * credit.rate + 10n ** 18n - 1n) / 10n ** 18n
}
