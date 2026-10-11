import { ReactNode } from 'react'

import { hookDappIframeTransport } from '@cowprotocol/hook-dapp-lib'

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render } from '@testing-library/react'

import { HookDappContext, HookDappIframe } from '../../types/hooks'

import { IframeDappContainer } from './index'

interface MockBridge {
  origin: string
  onConnect: jest.Mock
  disconnect: jest.Mock
}

const mockBridges: MockBridge[] = []
let mockWalletProvider: { provider: unknown } | undefined

jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: () => mockWalletProvider }))
jest.mock('@cowprotocol/iframe-transport', () => ({
  IframeRpcProviderBridge: jest.fn().mockImplementation((_window: Window, origin: string) => {
    const bridge = { origin, onConnect: jest.fn(), disconnect: jest.fn() }
    mockBridges.push(bridge)
    return bridge
  }),
}))
jest.mock('@cowprotocol/hook-dapp-lib', () => ({
  CoWHookDappEvents: {
    ACTIVATE: 'ACTIVATE',
    ADD_HOOK: 'ADD_HOOK',
    EDIT_HOOK: 'EDIT_HOOK',
    SET_SELL_TOKEN: 'SET_SELL_TOKEN',
    SET_BUY_TOKEN: 'SET_BUY_TOKEN',
  },
  hookDappIframeTransport: {
    listenToMessageFromWindow: jest.fn(() => ({})),
    stopListeningWindowListener: jest.fn(),
    postMessageToWindow: jest.fn(),
  },
}))
jest.mock('@cowprotocol/ui', () => ({ ProductLogo: () => null, ProductVariant: {}, UI: {} }))

const PROVIDER = { request: jest.fn() }
const context = {} as HookDappContext

function ui(url: string): ReactNode {
  return (
    <I18nProvider i18n={i18n}>
      <IframeDappContainer dapp={{ url } as HookDappIframe} context={context} />
    </I18nProvider>
  )
}

describe('IframeDappContainer RPC bridge lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockBridges.length = 0
    mockWalletProvider = { provider: PROVIDER }
  })

  it('binds the current wallet to the bridge created for a replaced origin', () => {
    const { rerender } = render(ui('https://a.example/hook'))
    const [oldBridge] = mockBridges

    expect(oldBridge.onConnect).toHaveBeenCalledWith(PROVIDER)

    rerender(ui('https://b.example/hook'))
    const newBridge = mockBridges[1]

    expect(mockBridges).toHaveLength(2)
    expect(oldBridge.disconnect).toHaveBeenCalled()
    expect(oldBridge.onConnect).toHaveBeenCalledTimes(1)
    expect(newBridge.origin).toBe('https://b.example')
    expect(newBridge.onConnect).toHaveBeenCalledWith(PROVIDER)
    expect(newBridge.disconnect).not.toHaveBeenCalled()
    // Old-origin listeners are removed and new ones are bound to the new origin only
    expect(hookDappIframeTransport.stopListeningWindowListener).toHaveBeenCalledTimes(5)
    expect(jest.mocked(hookDappIframeTransport.listenToMessageFromWindow).mock.calls.slice(5)).toEqual(
      Array(5).fill([window, expect.anything(), expect.any(String), expect.any(Function), 'https://b.example']),
    )
  })

  it('never reconnects the old bridge when the new origin is invalid', () => {
    const { rerender } = render(ui('https://a.example/hook'))

    rerender(ui('javascript:alert(1)'))

    expect(mockBridges).toHaveLength(1)
    expect(mockBridges[0].disconnect).toHaveBeenCalled()
    expect(mockBridges[0].onConnect).toHaveBeenCalledTimes(1)
  })

  it('disconnects the old provider when the wallet goes away and reconnects the next one', () => {
    const { rerender } = render(ui('https://a.example/hook'))
    const [bridge] = mockBridges

    mockWalletProvider = undefined
    rerender(ui('https://a.example/hook'))

    expect(bridge.disconnect).toHaveBeenCalledTimes(1)

    const nextProvider = { request: jest.fn() }
    mockWalletProvider = { provider: nextProvider }
    rerender(ui('https://a.example/hook'))

    expect(mockBridges).toHaveLength(1)
    expect(bridge.onConnect).toHaveBeenLastCalledWith(nextProvider)
  })
})
