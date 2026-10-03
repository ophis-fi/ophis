import { UserRejectedRequestError } from 'viem'

import { NearTransfer } from './nearDirect.schemas'
import {
  getNearFundingDeadline,
  getNearTokens,
  getNearTransferStatus,
  hasCurrentNearAssets,
  validateNearTransfer,
} from './nearDirect.service'

export async function prepareSourceFunding(transfer: NearTransfer, blockchain: string): Promise<void> {
  validateNearTransfer(transfer)
  if (transfer.source.blockchain !== blockchain || transfer.response.quote.depositMemo)
    throw new Error('Unsupported wallet deposit route.')
  if (!hasCurrentNearAssets(transfer, await getNearTokens()))
    throw new Error('Asset details changed. Review a new quote.')
  if ((await getNearTransferStatus(transfer)).status !== 'PENDING_DEPOSIT')
    throw new Error('A deposit has already been detected. Do not send again.')
  assertFundingDeadline(transfer)
}

export function assertFundingDeadline(transfer: NearTransfer): void {
  if (getNearFundingDeadline(transfer.response) <= Date.now() + 60_000)
    throw new Error('Quote expired. Do not fund it.')
}

export function handleSourceWalletFailure(failure: unknown): never {
  // Only an explicit wallet rejection permits retrying. A timeout may follow broadcast.
  if (typeof failure === 'object' && failure !== null && 'code' in failure && failure.code === 4001)
    throw new UserRejectedRequestError(new Error('Transaction rejected in wallet.'))
  throw failure
}
