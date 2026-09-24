import { BaseError, UserRejectedRequestError, type Hex, type WalletClient } from 'viem'

import { type CctpQuote, type CctpTransfer } from './cctp.service'
import { CCTP_STORAGE_KEY, cctpStorage } from './cctpState'
import { getCctpStatus } from './cctpStatus.service'
import { burnCctp, claimCctp } from './cctpWallet.service'

function isExplicitRejection(error: unknown): boolean {
  if (error instanceof BaseError)
    return error.walk((cause) => cause instanceof UserRejectedRequestError) instanceof UserRejectedRequestError
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4001
}

export async function submitCctpBurn(
  wallet: WalletClient,
  quote: CctpQuote,
  persist: (value: CctpTransfer | null) => void,
): Promise<void> {
  if (!navigator.locks) throw new Error('Please use a current browser to bridge')
  await navigator.locks.request('ophisCctpBurn', { ifAvailable: true }, async (lock) => {
    if (!lock || (await cctpStorage.getItem(CCTP_STORAGE_KEY, null)))
      throw new Error('A bridge is already pending. Resume it before starting another.')
    let pending: CctpTransfer = quote
    let persisted = false
    let signatureRequested = false
    const beforeSignature = async (nonce: number): Promise<void> => {
      pending = { ...quote, sourceNonce: nonce }
      persist(pending)
      persisted = true
      const saved = await cctpStorage.getItem(CCTP_STORAGE_KEY, null)
      if (JSON.stringify(saved) !== JSON.stringify(pending))
        throw new Error('Unable to save bridge recovery details. Nothing was signed.')
      signatureRequested = true
    }
    try {
      const burnHash = await burnCctp(wallet, quote, beforeSignature)
      if (!/^0x[a-fA-F0-9]{64}$/.test(burnHash))
        throw new Error('Wallet returned no valid source hash. Check wallet activity to resume.')
      try {
        persist({ ...pending, burnHash })
      } catch {
        throw new Error(`Bridge submitted. Save this source hash to resume: ${burnHash}`)
      }
    } catch (caught) {
      if (persisted && (!signatureRequested || isExplicitRejection(caught))) persist(null)
      throw caught
    }
  })
}

export async function resumeCctpTransfer(transfer: CctpTransfer, value: string): Promise<CctpTransfer> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error('Enter the source burn transaction hash')
  const resumed = { ...transfer, burnHash: value as Hex }
  const next = await getCctpStatus(resumed)
  if (!next.sourceConfirmed && !next.failed) throw new Error('Transaction is not confirmed yet. Check again shortly.')
  return resumed
}

export async function claimCctpTransfer(wallet: WalletClient, transfer: CctpTransfer): Promise<CctpTransfer> {
  const latest = await getCctpStatus(transfer)
  if (latest.completed) return transfer
  if (latest.mintHash) throw new Error('A destination transaction is already pending. Wait for confirmation.')
  if (!latest.message || !latest.attestation) throw new Error('The attestation is not ready yet')
  const mintHash = await claimCctp(wallet, transfer, latest.message, latest.attestation)
  return { ...transfer, mintHash }
}
