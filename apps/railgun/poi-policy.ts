import type { POI } from '@railgun-community/engine'
import type { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'

const disabledRequest = async (): Promise<never> => {
  throw new Error('PPOI requests are disabled for Ophis.')
}

export function disablePPOI(poi: typeof POI, network: (typeof NETWORK_CONFIG)[NetworkName]): void {
  // The wallet SDK derives PPOI enforcement from the selected network's metadata.
  delete network.poi
  poi.init([], {
    isActive: () => false,
    isRequired: async () => false,
    getPOIsPerList: disabledRequest,
    getPOIMerkleProofs: disabledRequest,
    validatePOIMerkleroots: disabledRequest,
    submitPOI: disabledRequest,
    submitLegacyTransactProofs: disabledRequest,
  })
}
