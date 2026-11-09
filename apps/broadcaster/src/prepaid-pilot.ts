import { isHexString, ZeroHash } from 'ethers'

/** An explicit pilot approval is bound to the existing immutable credit identity. */
export function withdrawalPilotKey(ledgerId: string, approvedLedgerId?: string): string {
  if (approvedLedgerId === undefined) return 'withdrawalPilot'
  if (!isHexString(ledgerId, 32) || ledgerId.toLowerCase() === ZeroHash ||
    !isHexString(approvedLedgerId, 32) || approvedLedgerId.toLowerCase() === ZeroHash ||
    ledgerId.toLowerCase() !== approvedLedgerId.toLowerCase())
    throw new Error('The prepaid pilot approval does not match the existing credit ledger.')
  return `prepaidWithdrawalPilot:${ledgerId.toLowerCase()}`
}
