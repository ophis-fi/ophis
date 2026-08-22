import { getOtcWalletTransportId, withOtcForkVerificationTimeout } from './useOtcNetworkReads'

describe('getOtcWalletTransportId', () => {
  it('is stable per transport and partitions distinct fork providers', () => {
    const first = {}
    const second = {}

    expect(getOtcWalletTransportId(first)).toBe(getOtcWalletTransportId(first))
    expect(getOtcWalletTransportId(first)).not.toBe(getOtcWalletTransportId(second))
    expect(getOtcWalletTransportId(undefined)).toBe(0)
  })
})

describe('withOtcForkVerificationTimeout', () => {
  it('fails a stalled wallet RPC verification closed', async () => {
    jest.useFakeTimers()
    try {
      const result = withOtcForkVerificationTimeout(new Promise<boolean>(() => undefined))
      const rejection = expect(result).rejects.toThrow('Ophis OTC local fork verification timed out')

      await jest.advanceTimersByTimeAsync(10_000)
      await rejection
    } finally {
      jest.useRealTimers()
    }
  })
})
