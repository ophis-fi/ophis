import { expect, it } from 'vitest'
import { POI, WalletBalanceBucket } from '@railgun-community/engine'
import { NETWORK_CONFIG, NetworkName, TXIDVersion } from '@railgun-community/shared-models'
import { POIRequired } from '@railgun-community/wallet'
import { disablePPOI } from '../poi-policy'

it('allows pending shield inputs without PPOI while preserving the chain and privacy contracts', async () => {
  const network = NETWORK_CONFIG[NetworkName.Ethereum]
  const contracts = { proxy: network.proxyContract, delegate: network.relayAdapt7702Contract, chain: network.chain }
  disablePPOI(POI, network)
  expect(await POIRequired.isRequiredForNetwork(NetworkName.Ethereum)).toBe(false)
  expect(POI.getActiveListKeys()).toEqual([])
  expect(await POI.getSpendableBalanceBuckets(network.chain)).toContain(WalletBalanceBucket.ShieldPending)
  expect({ proxy: network.proxyContract, delegate: network.relayAdapt7702Contract, chain: network.chain }).toEqual(contracts)
  await expect(POI.validatePOIMerkleroots(TXIDVersion.V2_PoseidonMerkle, network.chain, 'unused', [])).rejects.toThrow('disabled')
})
