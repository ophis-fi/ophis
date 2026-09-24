import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import {
  encodeFunctionData,
  BaseError,
  UserRejectedRequestError,
  type Hex,
  type Transaction,
  type WalletClient,
} from 'viem'

import { CCTP_ABI, MESSAGE_TRANSMITTER } from './cctp.const'
import { cctpClient, type CctpQuote, type CctpTransfer } from './cctp.service'
import { CCTP_STORAGE_KEY, cctpStorage, cctpTransferSchema } from './cctpState'
import {
  cctpReceipt,
  getCctpStatus,
  isCctpCancellation,
  isCctpFinalized,
  verifyMintReceipt,
} from './cctpStatus.service'
import { burnCctp, claimCctp } from './cctpWallet.service'

function isExplicitRejection(error: unknown): boolean {
  if (error instanceof BaseError)
    return error.walk((cause) => cause instanceof UserRejectedRequestError) instanceof UserRejectedRequestError
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4001
}

function matchesSavedTransfer(value: unknown, expected: CctpTransfer): boolean {
  const saved = cctpTransferSchema.safeParse(value)
  // Parsing gives both objects schema order; JSON omits optional undefined keys
  // exactly as persistence does. Reloading must not change journal identity.
  return saved.success && JSON.stringify(saved.data) === JSON.stringify(cctpTransferSchema.parse(expected))
}

// Every journal mutation shares the burn lock. A stale tab must never erase or
// overwrite a newer transfer while an RPC response or wallet signature is pending.
export async function updateCctpTransfer(
  expected: CctpTransfer,
  update: () => Promise<CctpTransfer | null>,
  persist: (value: CctpTransfer | null) => void,
): Promise<void> {
  if (!navigator.locks) throw new Error('Please use a current browser to bridge')
  await navigator.locks.request('ophisCctpBurn', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another tab is updating this bridge. Wait and try again.')
    const saved = await cctpStorage.getItem(CCTP_STORAGE_KEY, null)
    if (!matchesSavedTransfer(saved, expected))
      throw new Error('Bridge details changed in another tab. Refresh before continuing.')
    persist(await update())
  })
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
      if (!matchesSavedTransfer(saved, pending))
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

export async function claimCctpTransfer(
  wallet: WalletClient,
  transfer: CctpTransfer,
  persist: (value: CctpTransfer | null) => void,
): Promise<CctpTransfer> {
  const latest = await getCctpStatus(transfer)
  if (latest.completed) return transfer
  if (latest.claimPending)
    throw new Error('A destination transaction is already pending. Wait for confirmation or recover its hash.')
  if (!latest.message || !latest.attestation) throw new Error('The attestation is not ready yet')
  let pending = transfer
  let signatureRequested = false
  try {
    const mintHash = await claimCctp(wallet, transfer, latest.message, latest.attestation, async (nonce) => {
      pending = { ...transfer, mintHash: undefined, claimNonce: nonce }
      persist(pending)
      if (!matchesSavedTransfer(await cctpStorage.getItem(CCTP_STORAGE_KEY, null), pending))
        throw new Error('Unable to save claim recovery details. Nothing was signed.')
      signatureRequested = true
    })
    if (!/^0x[a-fA-F0-9]{64}$/.test(mintHash))
      throw new Error('Check wallet activity and recover the destination claim hash.')
    return { ...pending, mintHash }
  } catch (caught) {
    if (!signatureRequested || isExplicitRejection(caught)) persist(transfer)
    throw caught
  }
}

export async function resumeCctpClaim(transfer: CctpTransfer, value: string): Promise<CctpTransfer> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error('Enter the destination claim transaction hash')
  const latest = await getCctpStatus(transfer)
  if (latest.completed) return transfer
  if (!latest.message || !latest.attestation) throw new Error('The attestation is not ready yet')
  const mintHash = value as Hex
  const receipt = await cctpReceipt(transfer.destination, mintHash)
  if (!receipt) throw new Error('Destination transaction is not confirmed yet. Check again shortly.')
  const tx = await cctpClient(transfer.destination).getTransaction({ hash: mintHash })
  if (isCctpCancellation(tx, transfer.owner, transfer.claimNonce)) {
    if (!(await isCctpFinalized(transfer.destination, receipt)))
      throw new Error('Wait for the claim cancellation to become final')
    return { ...transfer, claimNonce: undefined, mintHash: undefined }
  }
  if (receipt.status === 'success') verifyMintReceipt(receipt, latest.message, transfer)
  else {
    const data = encodeFunctionData({
      abi: CCTP_ABI,
      functionName: 'receiveMessage',
      args: [latest.message, latest.attestation],
    })
    assertClaimTransaction(tx, transfer, data)
  }
  return { ...transfer, mintHash }
}

function assertClaimTransaction(tx: Transaction, transfer: CctpTransfer, data: Hex): void {
  if (
    !areAddressesEqual(tx.from, transfer.owner) ||
    !areAddressesEqual(tx.to, MESSAGE_TRANSMITTER) ||
    tx.nonce !== transfer.claimNonce ||
    tx.input.toLowerCase() !== data.toLowerCase() ||
    tx.value !== 0n
  )
    throw new Error('Transaction does not match the saved claim')
}
