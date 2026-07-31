import { IframeSafeSdkBridge } from './IframeSafeSdkBridge'

const IFRAME_ORIGIN = 'https://swap.example'
const PARENT_ORIGIN = 'https://safe.example'

const request = {
  id: 'request-id',
  method: 'getSafeInfo',
  params: {},
  env: { sdkVersion: '1.0.0' },
}

const response = {
  id: 'request-id',
  success: true,
  version: '1.0.0',
}

describe('IframeSafeSdkBridge', () => {
  const addEventListener = jest.fn()
  const removeEventListener = jest.fn()
  const parentPostMessage = jest.fn()
  const iframePostMessage = jest.fn()
  const parentWindow = { postMessage: parentPostMessage } as unknown as Window
  const iframeWindow = { postMessage: iframePostMessage } as unknown as Window
  const appWindow = {
    addEventListener,
    removeEventListener,
    parent: parentWindow,
  } as unknown as Window

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('forwards a request only from the trusted widget frame and origin', () => {
    const bridge = new IframeSafeSdkBridge(appWindow, iframeWindow, IFRAME_ORIGIN, PARENT_ORIGIN)

    bridge.forwardSdkMessage(messageEvent(request, iframeWindow, IFRAME_ORIGIN))

    expect(parentPostMessage).toHaveBeenCalledWith(request, PARENT_ORIGIN)
  })

  it.each([
    ['untrusted source', parentWindow, IFRAME_ORIGIN],
    ['untrusted origin', iframeWindow, 'https://attacker.example'],
  ])('rejects a request from an %s', (_label, source, origin) => {
    const bridge = new IframeSafeSdkBridge(appWindow, iframeWindow, IFRAME_ORIGIN, PARENT_ORIGIN)

    bridge.forwardSdkMessage(messageEvent(request, source, origin))

    expect(parentPostMessage).not.toHaveBeenCalled()
  })

  it('forwards a response only from the trusted parent and origin', () => {
    const bridge = new IframeSafeSdkBridge(appWindow, iframeWindow, IFRAME_ORIGIN, PARENT_ORIGIN)

    bridge.forwardSdkMessage(messageEvent(response, parentWindow, PARENT_ORIGIN))

    expect(iframePostMessage).toHaveBeenCalledWith(response, IFRAME_ORIGIN)
  })

  it.each([
    ['untrusted source', iframeWindow, PARENT_ORIGIN],
    ['untrusted origin', parentWindow, 'https://attacker.example'],
  ])('rejects a response from an %s', (_label, source, origin) => {
    const bridge = new IframeSafeSdkBridge(appWindow, iframeWindow, IFRAME_ORIGIN, PARENT_ORIGIN)

    bridge.forwardSdkMessage(messageEvent(response, source, origin))

    expect(iframePostMessage).not.toHaveBeenCalled()
  })

  it('fails closed when the embedding parent origin cannot be resolved', () => {
    const bridge = new IframeSafeSdkBridge(appWindow, iframeWindow, IFRAME_ORIGIN)

    bridge.forwardSdkMessage(messageEvent(request, iframeWindow, IFRAME_ORIGIN))
    bridge.forwardSdkMessage(messageEvent(response, parentWindow, PARENT_ORIGIN))

    expect(parentPostMessage).not.toHaveBeenCalled()
    expect(iframePostMessage).not.toHaveBeenCalled()
  })
})

function messageEvent(data: unknown, source: Window, origin: string): MessageEvent<unknown> {
  return { data, source, origin } as MessageEvent<unknown>
}
