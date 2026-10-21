import { describe, expect, it } from 'vitest'
import { EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import { broadcasterFee, startBroadcasters, submitPrivate } from './broadcaster'
import type { WalletSession } from './wallet'
import { FEE_SIGNER, TOKENS } from './config'

const gas = {
  evmGasType: EVMGasType.Type4 as const,
  gasEstimate: 3_000_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
}
const selected: SelectedBroadcaster = {
  railgunAddress: FEE_SIGNER,
  tokenAddress: TOKENS.USDC.address,
  tokenFee: {
    expiration: Date.now() + 120_000,
    feesID: 'test',
    feePerUnitGas: '1000000000000',
    availableWallets: 1,
    relayAdapt: '',
    reliability: 1,
  },
}

describe('broadcaster fee bounds', () => {
  it('blocks mainnet discovery and submission in the default fork build before touching a provider', async () => {
    await expect(startBroadcasters(() => {})).rejects.toThrow(/disabled/)
    await expect(
      submitPrivate(
        {} as WalletSession,
        { transaction: { to: '', data: '' }, preTransactionPOIsPerTxidLeafPerList: {} },
        selected,
        gas,
        true,
      ),
    ).rejects.toThrow(/disabled/)
  })
  it('rejects expired and near-expiry millisecond timestamps', () => {
    expect(() => broadcasterFee(selected, gas)).not.toThrow()
    for (const expiration of [Date.now() - 1, Date.now() + 10_000, Math.floor(Date.now() / 1000) + 120]) {
      expect(() => broadcasterFee({ ...selected, tokenFee: { ...selected.tokenFee, expiration } }, gas)).toThrow(
        /expired/,
      )
    }
  })
})
