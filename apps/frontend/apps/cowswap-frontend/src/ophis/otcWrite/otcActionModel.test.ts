import { deriveOtcActionModel } from './otcActionModel'

import type { OtcActionFacts } from './otcActionModel'

function facts(overrides: Partial<OtcActionFacts> = {}): OtcActionFacts {
  return {
    enabled: true,
    connected: true,
    correctChain: true,
    localForkVerified: true,
    ready: true,
    reviewed: true,
    allowance: 10n,
    allowanceFailed: false,
    requiredAllowance: 10n,
    recoveryRequired: false,
    allowanceCooldown: false,
    pendingIntent: null,
    executeLabel: 'Fill entire order',
    ...overrides,
  }
}

describe('deriveOtcActionModel', () => {
  it('uses one primary action through connect, fork verification, approval, and execution', () => {
    expect(deriveOtcActionModel(facts({ connected: false })).action).toBe('connect')
    expect(deriveOtcActionModel(facts({ correctChain: false })).action).toBe('switch')
    expect(deriveOtcActionModel(facts({ localForkVerified: null })).label).toBe('Verifying local fork...')
    expect(deriveOtcActionModel(facts({ localForkVerified: false })).label).toBe('Local Anvil fork required')
    expect(deriveOtcActionModel(facts({ allowance: 9n })).action).toBe('approve')
    expect(deriveOtcActionModel(facts()).action).toBe('execute')
  })

  it('blocks approval and execution until exact terms are reviewed', () => {
    const model = deriveOtcActionModel(facts({ reviewed: false, allowance: 0n }))
    expect(model.disabled).toBe(true)
    expect(model.label).toMatch(/Review before fill/)
  })

  it('keeps confirmation and allowance-cache gaps disabled', () => {
    expect(deriveOtcActionModel(facts({ pendingIntent: 'approve-fill' }))).toEqual({
      action: 'unavailable',
      label: 'Approving exact amount...',
      disabled: true,
      pending: true,
    })
    expect(deriveOtcActionModel(facts({ allowanceCooldown: true })).label).toBe('Refreshing exact allowance...')
  })

  it('prioritizes safe revocation after a raced fill', () => {
    expect(deriveOtcActionModel(facts({ recoveryRequired: true, allowance: 10n }))).toEqual({
      action: 'revoke',
      label: 'Revoke unused allowance',
      disabled: false,
      pending: false,
    })
  })
})
