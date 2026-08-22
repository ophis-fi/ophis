function errorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const direct = Reflect.get(error, 'code')
  if (typeof direct === 'number') return direct
  return errorCode(Reflect.get(error, 'cause'))
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) {
    const cause = errorText(error.cause)
    return `${error.name} ${error.message} ${cause}`.trim()
  }
  if (typeof error === 'object' && error !== null) {
    return ['name', 'message', 'shortMessage', 'details']
      .map((key) => Reflect.get(error, key))
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
  }
  return ''
}

interface OtcErrorRule {
  pattern: RegExp
  message: string
}

const OTC_ERROR_RULES: readonly OtcErrorRule[] = [
  {
    pattern: /user rejected|user denied/,
    message: 'Transaction rejected in your wallet. No funds moved.',
  },
  { pattern: /insufficient funds/, message: 'This wallet does not have enough ETH to pay Ethereum gas.' },
  { pattern: /wrong chain/, message: 'Switch the connected wallet to Ethereum and try again.' },
  {
    pattern: /local fork verification/,
    message: 'The wallet RPC is not a local Anvil or Hardhat fork. Real-mainnet submission is blocked.',
  },
  { pattern: /account changed/, message: 'The connected wallet account changed. Review the action again.' },
  {
    pattern: /deadlineexpired|deadline expired|fill deadline/,
    message: 'The fill deadline expired. Refresh the order and try again.',
  },
  {
    pattern: /ordernotactive|order not active|order changed/,
    message: 'This order was filled, cancelled, or changed before submission. Refresh before trying again.',
  },
  {
    pattern: /source mismatch|wiring mismatch/,
    message: 'Escrow contract verification failed. Transactions remain disabled.',
  },
  { pattern: /allowance/, message: 'The token allowance could not be verified. Refresh before trying again.' },
  { pattern: /transaction reverted/, message: 'Ethereum reverted the transaction. No order state changed.' },
]

/** Converts connector, RPC, and Swapboard failures into persistent safe copy. */
export function translateOtcWriteError(error: unknown): string {
  const text = errorText(error).toLowerCase()
  if (errorCode(error) === 4001) return 'Transaction rejected in your wallet. No funds moved.'
  const rule = OTC_ERROR_RULES.find((candidate) => candidate.pattern.test(text))
  if (rule) return rule.message
  return 'The transaction could not be completed. No unconfirmed action will be retried automatically.'
}
