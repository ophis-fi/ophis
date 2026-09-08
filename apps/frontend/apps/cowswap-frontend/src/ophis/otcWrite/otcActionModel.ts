import type { OtcPendingIntent } from './otcWrite.types'

export type OtcPrimaryAction = 'connect' | 'switch' | 'approve' | 'execute' | 'revoke' | 'unavailable'

export interface OtcActionFacts {
  enabled: boolean
  connected: boolean
  correctChain: boolean
  networkVerified: boolean | null
  mainnet: boolean
  walletAdmitted: boolean | undefined
  ready: boolean
  reviewed: boolean
  allowance: bigint | null
  allowanceFailed: boolean
  requiredAllowance: bigint | null
  recoveryRequired: boolean
  allowanceCooldown: boolean
  receiptConfirmed: boolean
  receiptUncertain: boolean
  pendingIntent: OtcPendingIntent | null
  executeLabel: string
  unavailableLabel: string
}

export interface OtcActionModel {
  action: OtcPrimaryAction
  label: string
  disabled: boolean
  pending: boolean
}

type MaybeActionModel = OtcActionModel | null

function pendingLabel(intent: OtcActionFacts['pendingIntent']): string {
  switch (intent) {
    case 'reconcile':
      return 'Checking transaction confirmation...'
    case 'switch':
      return 'Switching network...'
    case 'approve-create':
    case 'approve-fill':
      return 'Approving exact amount...'
    case 'revoke-create':
    case 'revoke-fill':
      return 'Revoking allowance...'
    case 'create':
      return 'Creating order...'
    case 'fill':
      return 'Filling order...'
    case 'cancel':
      return 'Cancelling order...'
    default:
      return 'Waiting for confirmation...'
  }
}

function pendingModel(facts: OtcActionFacts): MaybeActionModel {
  if (!facts.pendingIntent) return null
  return { action: 'unavailable', label: pendingLabel(facts.pendingIntent), disabled: true, pending: true }
}

function lacksWalletAdmission({ mainnet, walletAdmitted }: OtcActionFacts): boolean {
  return mainnet && walletAdmitted !== true
}

function environmentModel(facts: OtcActionFacts): MaybeActionModel {
  if (!facts.enabled) return { action: 'unavailable', label: 'OTC writes disabled', disabled: true, pending: false }
  if (!facts.connected) return { action: 'connect', label: 'Connect wallet', disabled: false, pending: false }
  if (lacksWalletAdmission(facts)) {
    return { action: 'unavailable', label: 'This wallet is not in the OTC canary.', disabled: true, pending: false }
  }
  if (!facts.correctChain) {
    return {
      action: 'switch',
      label: facts.mainnet ? 'Switch to Ethereum' : 'Select chain-id-1 local fork',
      disabled: false,
      pending: false,
    }
  }
  if (facts.networkVerified === null) {
    return {
      action: 'unavailable',
      label: facts.mainnet ? 'Verifying Ethereum...' : 'Verifying local fork...',
      disabled: true,
      pending: true,
    }
  }
  if (!facts.networkVerified) {
    return {
      action: 'unavailable',
      label: facts.mainnet ? 'Ethereum verification unavailable' : 'Local Anvil fork required',
      disabled: true,
      pending: false,
    }
  }
  return null
}

function readinessModel(facts: OtcActionFacts): MaybeActionModel {
  if (facts.receiptUncertain) {
    return { action: 'unavailable', label: 'Verify submitted transaction', disabled: true, pending: false }
  }
  if (facts.allowanceFailed) {
    return { action: 'unavailable', label: 'Allowance unavailable', disabled: true, pending: false }
  }
  if (facts.allowanceCooldown) {
    return { action: 'unavailable', label: 'Refreshing exact allowance...', disabled: true, pending: true }
  }
  if (facts.requiredAllowance !== null && facts.allowance === null) {
    return { action: 'unavailable', label: 'Checking exact allowance...', disabled: true, pending: true }
  }
  return null
}

function revokeModel(facts: OtcActionFacts): MaybeActionModel {
  const positiveAllowance = (facts.allowance ?? 0n) > 0n
  if (positiveAllowance && (facts.recoveryRequired || !facts.ready)) {
    return { action: 'revoke', label: 'Revoke unused allowance', disabled: false, pending: false }
  }
  if (facts.requiredAllowance !== null && positiveAllowance && facts.allowance !== facts.requiredAllowance) {
    return { action: 'revoke', label: 'Revoke mismatched allowance', disabled: false, pending: false }
  }
  return null
}

function transactionModel(facts: OtcActionFacts): OtcActionModel {
  const revoke = revokeModel(facts)
  if (revoke) return revoke
  if (facts.receiptConfirmed) {
    return { action: 'unavailable', label: 'Transaction confirmed', disabled: true, pending: false }
  }
  if (!facts.ready) {
    return { action: 'unavailable', label: facts.unavailableLabel, disabled: true, pending: false }
  }
  if (!facts.reviewed) {
    return {
      action: 'unavailable',
      label: `Review before ${facts.executeLabel.toLowerCase()}`,
      disabled: true,
      pending: false,
    }
  }
  if (facts.requiredAllowance !== null && facts.allowance !== facts.requiredAllowance) {
    return { action: 'approve', label: 'Approve exact amount', disabled: false, pending: false }
  }
  return { action: 'execute', label: facts.executeLabel, disabled: false, pending: false }
}

/** Pure one-button state machine: connect → network → approve → execute/recover. */
export function deriveOtcActionModel(facts: OtcActionFacts): OtcActionModel {
  for (const model of [pendingModel(facts), environmentModel(facts), readinessModel(facts)]) {
    if (model) return model
  }
  return transactionModel(facts)
}
