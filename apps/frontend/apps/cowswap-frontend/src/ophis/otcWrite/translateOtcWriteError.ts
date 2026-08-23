const MAX_ERROR_DEPTH = 8
const MAX_ERROR_TEXT = 4_000

function safeProperty(error: object, key: string): unknown {
  try {
    return Reflect.get(error, key)
  } catch {
    return undefined
  }
}

function errorCode(error: unknown, seen = new WeakSet<object>(), depth = 0): number | undefined {
  if (typeof error !== 'object' || error === null || seen.has(error) || depth >= MAX_ERROR_DEPTH) return undefined
  seen.add(error)
  const direct = safeProperty(error, 'code')
  if (typeof direct === 'number') return direct
  return errorCode(safeProperty(error, 'cause'), seen, depth + 1)
}

function errorText(error: unknown, seen = new WeakSet<object>(), depth = 0): string {
  if (typeof error === 'string') return error.slice(0, MAX_ERROR_TEXT)
  if (typeof error !== 'object' || error === null || seen.has(error) || depth >= MAX_ERROR_DEPTH) return ''
  seen.add(error)
  const fields = ['name', 'message', 'shortMessage', 'details']
    .map((key) => safeProperty(error, key))
    .filter((value): value is string => typeof value === 'string')
  const cause = errorText(safeProperty(error, 'cause'), seen, depth + 1)
  return [...fields, cause].join(' ').trim().slice(0, MAX_ERROR_TEXT)
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
  {
    pattern: /wrong chain/,
    message: 'Connect the wallet to the configured local Anvil or Hardhat mainnet fork and try again.',
  },
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
