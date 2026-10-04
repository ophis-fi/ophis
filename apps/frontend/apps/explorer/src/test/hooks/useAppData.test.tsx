import { ReactNode } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { renderHook, waitFor } from '@testing-library/react'
import { orderBookSDK } from 'cowSdk'
import { useAppData } from 'hooks/useAppData'
import { useNetworkId } from 'state/network'
import { SWRConfig } from 'swr'

jest.mock('state/network', () => ({ useNetworkId: jest.fn() }))
jest.mock('cowSdk', () => ({
  orderBookSDK: { getAppData: jest.fn() },
  metadataApiSDK: {
    appDataHexToCid: jest.fn().mockResolvedValue('cid'),
    appDataHexToCidLegacy: jest.fn().mockResolvedValue('legacy-cid'),
    fetchDocFromAppDataHex: jest.fn().mockResolvedValue(undefined),
    fetchDocFromAppDataHexLegacy: jest.fn().mockResolvedValue(undefined),
  },
}))

const mockedNetworkId = jest.mocked(useNetworkId)
const mockedGetAppData = jest.mocked(orderBookSDK.getAppData)
const appDataHash = `0x${'a'.repeat(64)}`
const fullAppData = JSON.stringify({ version: '1.14.0', appCode: 'ophis', metadata: {} })

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
}

describe('useAppData', () => {
  beforeEach(() => {
    mockedNetworkId.mockReset().mockReturnValue(SupportedChainId.BASE)
    mockedGetAppData.mockReset().mockResolvedValue({ fullAppData })
  })

  it('decodes inline metadata without a redundant orderbook request', async () => {
    const { result } = renderHook(() => useAppData(appDataHash, fullAppData), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.appDataDoc?.appCode).toBe('ophis')
    expect(result.current.hasError).toBe(false)
    expect(mockedGetAppData).not.toHaveBeenCalled()
  })

  it('fetches metadata on the selected network and refetches when that network changes', async () => {
    const { result, rerender } = renderHook(() => useAppData(appDataHash), { wrapper })
    await waitFor(() => expect(result.current.appDataDoc?.appCode).toBe('ophis'))
    expect(mockedGetAppData).toHaveBeenLastCalledWith(appDataHash, { chainId: SupportedChainId.BASE })

    mockedNetworkId.mockReturnValue(SupportedChainId.ARBITRUM_ONE)
    rerender()
    await waitFor(() => expect(mockedGetAppData).toHaveBeenCalledTimes(2))
    expect(mockedGetAppData).toHaveBeenLastCalledWith(appDataHash, { chainId: SupportedChainId.ARBITRUM_ONE })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })

  it('keeps the API fallback when inline JSON cannot be decoded', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const { result } = renderHook(() => useAppData(appDataHash, 'invalid-json'), { wrapper })
      await waitFor(() => expect(result.current.appDataDoc?.appCode).toBe('ophis'))
      expect(mockedGetAppData).toHaveBeenCalledWith(appDataHash, { chainId: SupportedChainId.BASE })
      expect(result.current.hasError).toBe(false)
    } finally {
      error.mockRestore()
      info.mockRestore()
    }
  })

  it('waits for network selection instead of requesting default-mainnet metadata', async () => {
    mockedNetworkId.mockReturnValue(null)
    const { result, rerender } = renderHook(() => useAppData(appDataHash), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockedGetAppData).not.toHaveBeenCalled()

    mockedNetworkId.mockReturnValue(SupportedChainId.BASE)
    rerender()
    await waitFor(() => expect(mockedGetAppData).toHaveBeenCalledWith(appDataHash, { chainId: SupportedChainId.BASE }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })
})
