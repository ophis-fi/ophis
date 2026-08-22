import { getOtcWalletTransportId } from './useOtcNetworkReads'

describe('getOtcWalletTransportId', () => {
  it('is stable per transport and partitions distinct fork providers', () => {
    const first = {}
    const second = {}

    expect(getOtcWalletTransportId(first)).toBe(getOtcWalletTransportId(first))
    expect(getOtcWalletTransportId(first)).not.toBe(getOtcWalletTransportId(second))
    expect(getOtcWalletTransportId(undefined)).toBe(0)
  })
})
