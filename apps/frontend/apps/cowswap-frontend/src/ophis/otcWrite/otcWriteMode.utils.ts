/** Both Ethereum modes share canonical reads, durable proofs and the runtime emergency stop. */
export function isOtcMainnetMode(mode: string | undefined): boolean {
  return mode === 'canary' || mode === 'public'
}
