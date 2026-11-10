import type { TXO } from '@railgun-community/engine'
import type { JsonRpcProvider } from 'ethers'
import { CHAIN, TOKENS } from '../src/config'
import { CreditLedger } from '../src/credit'
import { verifyCreditBacking } from '../src/credit-backing'
import { verifyUnrelatedOwnerPayout, type AccountedNote } from '../src/credit-owner-payment'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { getRailgunWalletAddressData } from '@railgun-community/wallet'
import { feeAddress } from './credit-owner.fixture'
import type { CreditScope } from '../../railgun/credit-protocol'
import type { Store } from '../src/storage'

// CLI routing fixture; actual encrypted wallet scans are tested separately.
function cliNotes(accounted: readonly AccountedNote[], recipient = feeAddress) {
  return accounted.map((saved) => ({ ...saved, txid: saved.transactionHash, spendtxid: false,
    nullifier: saved.commitment, note: { hash: BigInt(saved.commitment), value: BigInt(saved.amount),
      tokenData: { tokenType: 0, tokenAddress: TOKENS[0].address, tokenSubID: '0' },
      receiverAddressData: getRailgunWalletAddressData(recipient) },
  })) as unknown as TXO[]
}
export async function cliBacking(accounted: readonly AccountedNote[], maximumInputs = 2) {
  const notes = cliNotes(accounted)
  const provider = {
    getNetwork: async () => ({ chainId: CHAIN }),
    getBlock: async (tag: number | string) => ({ number: typeof tag === 'number' ? tag : 100,
      hash: accounted.find((note) => note.blockNumber === tag)?.blockHash ?? `0x${'01'.repeat(32)}`,
      timestamp: Math.floor(Date.now() / 1000) }),
    call: async () => `0x${'00'.repeat(32)}`,
  } as unknown as JsonRpcProvider
  return verifyCreditBacking(provider, notes, accounted, maximumInputs)
}

export class RailgunSDK {
  address = ''
  constructor(_config: unknown, _secrets: unknown, private readonly store: Store) {}
  async start() {
    this.address = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get()
      ? CreditLedger.load(this.store).scope.recipient : feeAddress
  }
  ready() { return !!this.address }
  async balances() { return { [TOKENS[0].address]: '7' } }
  async confirmedCredits() { return [] }
  async confirmedRefund() { return false }
  async confirmedOwnerCollection() { throw new Error('The sync CLI must not collect fees.') }
  async validatePrepaid() { throw new Error('The sync CLI must not execute transactions.') }
  async sign() { throw new Error('The sync CLI must not advertise or sign.') }
  async stop() {}
  async unrelatedOwnerPayout(provider: JsonRpcProvider, scope: CreditScope, accounted: readonly AccountedNote[], hash: string) {
    if (!this.address) throw new Error('The CLI must synchronize before rejecting a private payout.')
    const receipt = await finalizedCreditReceipt(provider, hash)
    return { receipt, proof: await verifyUnrelatedOwnerPayout(provider, receipt, scope, cliNotes(accounted, scope.recipient), accounted) }
  }
  async accountedCreditBacking(_provider: unknown, accounted: readonly AccountedNote[], maximumInputs: number) {
    if (!this.address) throw new Error('The CLI must synchronize before preparing an owner payment.')
    return cliBacking(accounted, maximumInputs)
  }
}
