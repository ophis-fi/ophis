import { ErrorCode } from '@ethersproject/logger'

import { UserRejectedRequestError } from 'viem'

export function isPermitCancellation(error: unknown): boolean {
  // WalletConnect can omit the code; generic -32000 RPC errors are not cancellations.
  const message = error && typeof error === 'object' && 'message' in error ? error.message : error
  return Boolean(
    (error &&
      typeof error === 'object' &&
      'code' in error &&
      [UserRejectedRequestError.code, ErrorCode.ACTION_REJECTED].some((code) => code === error.code)) ||
      (typeof message === 'string' &&
        /user (?:rejected|denied)|rejected transaction|transaction was rejected/i.test(message)),
  )
}
