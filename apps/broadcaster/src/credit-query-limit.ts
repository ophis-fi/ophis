interface Window { started: number; ordinary: number; recovery: number; costly: number }

/** Unfunded discovery cannot consume a funded owner's recovery budget. */
export class CreditQueryLimit {
  private readonly owners = new Map<string, Window>()
  private unfunded: number[] = []
  accept(owner: string, funded: boolean, kind: string, now = performance.now()): void {
    for (const [key, window] of this.owners) if (now - window.started >= 60_000) this.owners.delete(key)
    this.unfunded = this.unfunded.filter((time) => now - time < 60_000)
    if (!funded && this.unfunded.length >= 300) throw new Error('Unfunded prepaid query limit reached.')
    const key = owner.toLowerCase()
    let window = this.owners.get(key)
    if (!window) {
      // The unfunded global allowance bounds unauthenticated account churn; funded rows already have a durable ledger identity.
      window = { started: now, ordinary: 0, recovery: 0, costly: 0 }
      this.owners.set(key, window)
    }
    const recovery = ['balance', 'recover', 'attempt', 'refund-status'].includes(kind)
    const costly = ['claim', 'refund', 'quote'].includes(kind)
    if (recovery ? window.recovery >= 30 : window.ordinary >= 12)
      throw new Error('This prepaid owner query limit reached.')
    if (costly && window.costly >= 6) throw new Error('This prepaid owner refresh limit reached.')
    if (recovery) window.recovery++; else window.ordinary++
    if (costly) window.costly++
    if (!funded) this.unfunded.push(now)
  }
}
