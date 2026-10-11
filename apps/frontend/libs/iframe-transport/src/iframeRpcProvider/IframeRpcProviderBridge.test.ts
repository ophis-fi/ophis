import { IframeRpcProviderBridge } from './IframeRpcProviderBridge'
import { IframeRpcProviderEvents } from './iframeRpcProviderEvents'

import type { EthereumProvider } from '../types'

const ORIGIN = 'https://swap.cow.fi'
const TRANSPORT_KEY = 'cowSwapIframeRpcProviderTransport'

interface MockProvider extends EthereumProvider {
  request: jest.Mock
  emit(event: string, params: unknown): void
}

function createProvider({ withRemoveListener = true } = {}): MockProvider {
  const handlers: Record<string, Array<(params: unknown) => void>> = {}

  return {
    request: jest.fn().mockResolvedValue('0xresult'),
    on: (event: string, handler: unknown) => {
      handlers[event] = [...(handlers[event] || []), handler as (params: unknown) => void]
    },
    ...(withRemoveListener
      ? {
          removeListener: (event: string, handler: (params: unknown) => void) => {
            handlers[event] = (handlers[event] || []).filter((h) => h !== handler)
          },
        }
      : {}),
    emit: (event: string, params: unknown) => (handlers[event] || []).forEach((h) => h(params)),
  }
}

function sendFromIframe(method: IframeRpcProviderEvents, payload: object = {}): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: { key: TRANSPORT_KEY, method, ...payload }, origin: ORIGIN, source: window }),
  )
}

let nextRequestId = 1
function sendRpcRequest(): void {
  sendFromIframe(IframeRpcProviderEvents.PROVIDER_RPC_REQUEST, {
    rpcRequest: { jsonrpc: '2.0', id: nextRequestId++, method: 'eth_accounts', params: [] },
  })
}

function postedMessages(method: IframeRpcProviderEvents): unknown[] {
  return jest
    .mocked(window.postMessage)
    .mock.calls.map(([data]) => data as { method: string })
    .filter((data) => data.method === method)
}

describe('IframeRpcProviderBridge', () => {
  let bridge: IframeRpcProviderBridge

  beforeEach(() => {
    jest.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    bridge = new IframeRpcProviderBridge(window, ORIGIN)
  })

  afterEach(() => {
    bridge.disconnect()
    jest.restoreAllMocks()
  })

  it('forwards requests and provider events on the initial connection', async () => {
    const provider = createProvider()
    bridge.onConnect(provider)

    sendRpcRequest()
    provider.emit('accountsChanged', ['0x1'])
    await Promise.resolve()

    expect(provider.request).toHaveBeenCalledTimes(1)
    expect(postedMessages(IframeRpcProviderEvents.PROVIDER_ON_EVENT)).toEqual([
      expect.objectContaining({ event: 'accountsChanged', params: ['0x1'] }),
    ])
  })

  it('sends one wallet request per message across repeated disconnect/connect cycles', () => {
    const providers = [createProvider(), createProvider(), createProvider()]

    providers.forEach((provider) => {
      // Same sequence as widget.updateProvider
      bridge.disconnect()
      bridge.onConnect(provider)
    })
    sendRpcRequest()

    expect(providers[0].request).not.toHaveBeenCalled()
    expect(providers[1].request).not.toHaveBeenCalled()
    expect(providers[2].request).toHaveBeenCalledTimes(1)
  })

  it('sends one wallet request per message when switching providers without disconnecting', () => {
    const [first, second] = [createProvider(), createProvider()]

    bridge.onConnect(first)
    bridge.onConnect(second)
    bridge.onConnect(second)
    sendRpcRequest()
    sendFromIframe(IframeRpcProviderEvents.REQUEST_PROVIDER_META_INFO)

    expect(first.request).not.toHaveBeenCalled()
    expect(second.request).toHaveBeenCalledTimes(1)
    expect(postedMessages(IframeRpcProviderEvents.SEND_PROVIDER_META_INFO)).toHaveLength(1)
  })

  it.each([true, false])(
    'does not forward events of a torn down provider (removeListener supported: %s)',
    (withRemoveListener) => {
      const [first, second] = [createProvider({ withRemoveListener }), createProvider({ withRemoveListener })]

      bridge.onConnect(first)
      bridge.onConnect(second)
      first.emit('accountsChanged', ['0xold'])
      bridge.disconnect()
      second.emit('accountsChanged', ['0xold2'])

      expect(postedMessages(IframeRpcProviderEvents.PROVIDER_ON_EVENT)).toHaveLength(0)
    },
  )

  it.each(['disconnect', 'replace', 'reconnect'] as const)(
    'discards pending RPC results and errors after %s',
    async (transition) => {
      const provider = createProvider()
      let resolveRequest: (value: unknown) => void = () => undefined
      let rejectRequest: (reason: Error) => void = () => undefined
      provider.request
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRequest = resolve
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectRequest = reject
            }),
        )
      bridge.onConnect(provider)
      sendRpcRequest()
      sendRpcRequest()

      if (transition === 'disconnect') bridge.disconnect()
      if (transition === 'replace') bridge.onConnect(createProvider())
      if (transition === 'reconnect') {
        bridge.disconnect()
        bridge.onConnect(provider)
      }
      resolveRequest(['0xold-account'])
      rejectRequest(new Error('Old wallet error'))
      await Promise.resolve()
      await Promise.resolve()

      expect(postedMessages(IframeRpcProviderEvents.PROVIDER_RPC_RESPONSE)).toHaveLength(0)
      if (transition !== 'disconnect') {
        sendRpcRequest()
        await Promise.resolve()
        expect(postedMessages(IframeRpcProviderEvents.PROVIDER_RPC_RESPONSE)).toHaveLength(1)
      }
    },
  )

  it('accepts zero as a JSON-RPC request id', async () => {
    const provider = createProvider()
    bridge.onConnect(provider)
    sendFromIframe(IframeRpcProviderEvents.PROVIDER_RPC_REQUEST, {
      rpcRequest: { jsonrpc: '2.0', id: 0, method: 'eth_accounts', params: [] },
    })
    await Promise.resolve()
    expect(postedMessages(IframeRpcProviderEvents.PROVIDER_RPC_RESPONSE)).toEqual([
      expect.objectContaining({ rpcResponse: { jsonrpc: '2.0', id: 0, result: '0xresult' } }),
    ])
  })

  it('ignores requests after disconnect and never replays them into a new provider', () => {
    const [first, second] = [createProvider(), createProvider()]

    bridge.onConnect(first)
    bridge.disconnect()
    sendRpcRequest()
    sendFromIframe(IframeRpcProviderEvents.REQUEST_PROVIDER_META_INFO)
    bridge.onConnect(second)

    expect(first.request).not.toHaveBeenCalled()
    expect(second.request).not.toHaveBeenCalled()
    expect(postedMessages(IframeRpcProviderEvents.SEND_PROVIDER_META_INFO)).toHaveLength(0)

    sendRpcRequest()
    expect(second.request).toHaveBeenCalledTimes(1)
  })
})
