import { CowSwapWidgetHandler, createCowSwapWidget } from './cowSwapWidget'
import { CowSwapWidgetParams, EthereumProvider, TradeType } from './types'

describe('createCowSwapWidget', () => {
  const originalOpen = window.open

  beforeEach(() => {
    window.open = jest.fn()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    window.open = originalOpen
  })

  it('opens https links requested by the widget', () => {
    const { iframe } = createWidget()

    dispatchInterceptWindowOpen('https://example.com', undefined, iframe)

    expect(window.open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener')
  })

  it('blocks javascript urls requested by the widget', () => {
    const { iframe } = createWidget()

    dispatchInterceptWindowOpen('javascript://%0Aalert(1)', undefined, iframe)

    expect(window.open).not.toHaveBeenCalled()
  })

  it('opens relative links requested by the widget', () => {
    const { iframe } = createWidget()

    dispatchInterceptWindowOpen('/faq', undefined, iframe)

    expect(window.open).toHaveBeenCalledWith('https://swap.ophis.fi/faq', '_blank', 'noopener')
  })

  it('accepts messages from a custom widget baseUrl origin', () => {
    const { iframe } = createWidget('https://barn.cow.fi')

    dispatchInterceptWindowOpen('https://example.com', 'https://barn.cow.fi', iframe)

    expect(window.open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener')
  })

  it('ignores messages from an untrusted origin', () => {
    const { iframe } = createWidget('https://swap.cow.fi')

    dispatchInterceptWindowOpen('https://example.com', 'https://attacker.example', iframe)

    expect(window.open).not.toHaveBeenCalled()
  })

  it('does not window.open when disableWindowOpen = true', () => {
    const { iframe } = createWidget(undefined, { disableWindowOpen: true })

    dispatchInterceptWindowOpen('https://example.com', undefined, iframe)

    expect(window.open).not.toHaveBeenCalled()
  })

  describe('updateProvider', () => {
    it('sends one wallet request per message, to the current provider only, across repeated cycles', () => {
      const [first, second, third] = [createProvider(), createProvider(), createProvider()]
      const widget = createWidget(undefined, undefined, first)

      widget.updateProvider(second)
      widget.updateProvider(undefined)
      widget.updateProvider(third)
      widget.updateProvider(third)
      dispatchRpcRequest(widget.iframe)

      expect(first.request).not.toHaveBeenCalled()
      expect(second.request).not.toHaveBeenCalled()
      expect(third.request).toHaveBeenCalledTimes(1)
    })

    it('does not forward account events from replaced or destroyed providers', () => {
      const [first, second] = [createProvider(), createProvider()]
      const widget = createWidget(undefined, undefined, first)
      const postMessage = spyOnIframePostMessage(widget.iframe)

      widget.updateProvider(second)
      first.emit('accountsChanged', ['0xold'])
      second.emit('accountsChanged', ['0xnew'])
      widget.destroy()
      second.emit('accountsChanged', ['0xafterDestroy'])

      const forwardedEvents = postMessage.mock.calls
        .map(([data]) => data as { method?: string; params?: unknown })
        .filter((data) => data.method === 'PROVIDER_ON_EVENT')
      expect(forwardedEvents).toEqual([expect.objectContaining({ params: ['0xnew'] })])
    })

    it('does not replay requests sent while disconnected into a new provider', () => {
      const [first, second] = [createProvider(), createProvider()]
      const widget = createWidget(undefined, undefined, first)

      widget.updateProvider(undefined)
      dispatchRpcRequest(widget.iframe)
      widget.updateProvider(second)

      expect(first.request).not.toHaveBeenCalled()
      expect(second.request).not.toHaveBeenCalled()
    })
  })
})

interface MockProvider extends EthereumProvider {
  request: jest.Mock
  removeListener(event: string, handler: (params: unknown) => void): void
  emit(event: string, params: unknown): void
}

function createProvider(): MockProvider {
  const handlers: Record<string, Array<(params: unknown) => void>> = {}

  return {
    request: jest.fn().mockResolvedValue([]),
    on: (event: string, handler: unknown) => {
      handlers[event] = [...(handlers[event] || []), handler as (params: unknown) => void]
    },
    removeListener: (event: string, handler: (params: unknown) => void) => {
      handlers[event] = (handlers[event] || []).filter((h) => h !== handler)
    },
    emit: (event: string, params: unknown) => (handlers[event] || []).forEach((h) => h(params)),
  }
}

let nextRpcRequestId = 1

function dispatchRpcRequest(iframe: HTMLIFrameElement): void {
  const event = new MessageEvent('message', {
    origin: 'https://swap.ophis.fi',
    data: {
      key: 'cowSwapIframeRpcProviderTransport',
      method: 'PROVIDER_RPC_REQUEST',
      rpcRequest: { jsonrpc: '2.0', id: nextRpcRequestId++, method: 'eth_accounts', params: [] },
    },
  })

  Object.defineProperty(event, 'source', {
    configurable: true,
    value: iframe.contentWindow,
  })

  window.dispatchEvent(event)
}

function spyOnIframePostMessage(iframe: HTMLIFrameElement): jest.SpyInstance {
  const { contentWindow } = iframe
  if (!contentWindow) throw new Error('Iframe does not contain a window')

  return jest.spyOn(contentWindow, 'postMessage').mockImplementation(() => undefined)
}

function createWidget(
  baseUrl?: string,
  extraParams?: Partial<CowSwapWidgetParams>,
  provider?: EthereumProvider,
): CowSwapWidgetHandler {
  const container = document.createElement('div')
  document.body.appendChild(container)

  return createCowSwapWidget(container, {
    params: {
      appCode: 'test-app',
      baseUrl,
      chainId: 1,
      tradeType: TradeType.SWAP,
      ...extraParams,
    },
    provider,
  })
}

function dispatchInterceptWindowOpen(href: string, origin = 'https://swap.ophis.fi', iframe: HTMLIFrameElement): void {
  const event = new MessageEvent('message', {
    origin,
    source: iframe.contentWindow,
    data: {
      key: 'cowSwapWidget',
      method: 'INTERCEPT_WINDOW_OPEN',
      href,
      target: '_blank',
      rel: 'noopener',
    },
  })

  Object.defineProperty(event, 'source', {
    configurable: true,
    value: iframe.contentWindow,
  })

  window.dispatchEvent(event)
}
