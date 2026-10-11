import type { EIP6963AnnounceProviderEvent, EIP6963ProviderDetail } from '@cowprotocol/types'

import {
  IframeRpcProviderEvents,
  iframeRpcProviderTransport,
  ProviderRpcRequestPayload,
  ProviderRpcResponsePayload,
} from './iframeRpcProviderEvents'
import { getEip6963ProviderInfo, getProviderWcMetadata } from './utils'

import type { EthereumProvider, JsonRpcRequestMessage, WindowListener } from '../types'

const EVENTS_TO_FORWARD_TO_IFRAME = ['connect', 'disconnect', 'close', 'chainChanged', 'accountsChanged']

interface ProviderEventHandlers {
  provider: EthereumProvider
  handlers: [string, (params: unknown) => void][]
}

const eip6963Providers: EIP6963ProviderDetail[] = []

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event: Event) => {
    const providerEvent = event as EIP6963AnnounceProviderEvent
    eip6963Providers.push(providerEvent.detail)
  })
}

/**
 * Handles JSON-RPC request coming from an iFrame by delegating to a given Ethereum provider.
 * The result will be passed back to the iFrame.
 *
 * Additionally, it will forward some special events from the wallet, to the iFrame window, for example connect/disconnect/chainChanged
 */
export class IframeRpcProviderBridge {
  /**
   * The Ethereum provider instance.
   * When is null the JSON-RPC bridge is disconnected from the Ethereum provider.
   * */
  private ethereumProvider: EthereumProvider | null = null

  /**
   * The actual `message` listeners registered by the transport (wrappers around our callbacks).
   * They must be kept to be able to remove them, otherwise every reconnection would stack a new listener.
   */
  private windowListeners: WindowListener[] = []

  /** Handlers registered in the current provider, to unsubscribe them when the provider is replaced/disconnected. */
  private providerEventHandlers: ProviderEventHandlers | null = null

  /**
   * Creates an instance of IframeRpcProviderBridge.
   * @param iframeWindow - The iFrame window that will post up general RPC messages and to which the IframeRpcProviderBridge will forward the RPC result.
   *  Also it will receive some special RPC events coming from the wallet, like connect/chainChanged,accountChanged
   */
  constructor(
    private iframeWindow: Window,
    private iframeOrigin?: string,
  ) {}

  /**
   * Disconnects the JSON-RPC bridge from the Ethereum provider.
   * Stops listening to the iFrame and invalidates responses from the disconnected provider.
   */
  disconnect(): void {
    if (typeof window === 'undefined') return

    // Disconnect provider
    this.disconnectProvider()

    this.windowListeners.forEach((listener) => iframeRpcProviderTransport.stopListeningWindowListener(window, listener))
    this.windowListeners = []
  }

  /**
   * Handles the 'connect' event and sets up event listeners for Ethereum provider events.
   * @param newProvider - The Ethereum provider to connect.
   */
  onConnect(newProvider: EthereumProvider): void {
    if (typeof window === 'undefined') return

    // Disconnect the previous provider (keep listening to the iFrame)
    this.disconnectProvider()

    if (this.windowListeners.length === 0) {
      this.windowListeners = [
        // Listen for messages coming to the main window (from the iFrame window)
        iframeRpcProviderTransport.listenToMessageFromWindow(
          window,
          this.iframeWindow,
          IframeRpcProviderEvents.PROVIDER_RPC_REQUEST,
          this.processRpcCallFromWindow,
          this.iframeOrigin,
        ),
        // Listen for provider meta info request
        iframeRpcProviderTransport.listenToMessageFromWindow(
          window,
          this.iframeWindow,
          IframeRpcProviderEvents.REQUEST_PROVIDER_META_INFO,
          this.processProviderMetaInfoRequest,
          this.iframeOrigin,
        ),
      ]
    }

    // Save the provider
    this.ethereumProvider = newProvider

    // Register in the provider, the events that needs to be forwarded to the iFrame window
    const subscription: ProviderEventHandlers = { provider: newProvider, handlers: [] }
    this.providerEventHandlers = subscription
    EVENTS_TO_FORWARD_TO_IFRAME.forEach((event) => {
      // Ignore events once this provider is no longer the connected one (in case it doesn't support removeListener)
      const handler = (params: unknown): void => {
        if (this.providerEventHandlers === subscription) this.onProviderEvent(event, params)
      }

      newProvider.on(event, handler)
      subscription.handlers.push([event, handler])
    })
  }

  private disconnectProvider(): void {
    this.ethereumProvider = null

    if (!this.providerEventHandlers) return

    const { provider, handlers } = this.providerEventHandlers
    this.providerEventHandlers = null
    handlers.forEach(([event, handler]) => provider.removeListener?.(event, handler))
  }

  /**
   * Processes a JSON-RPC request and sends appropriate response or error via the content window.
   * @param request - The JSON-RPC request to be processed.
   */
  processRpcRequest(request: JsonRpcRequestMessage): void {
    const { id, jsonrpc, method } = request
    const subscription = this.providerEventHandlers
    if (!subscription || id === undefined) {
      return
    }
    const requestPromise =
      // Keep the legacy "enable" method for backward compatibility
      method === 'enable'
        ? subscription.provider.request({ method: 'eth_requestAccounts', id })
        : subscription.provider.request({ ...request, id })

    // A previous connection must not disclose responses to a replacement iframe/provider session.
    requestPromise
      .then((result) => {
        if (this.providerEventHandlers !== subscription) return
        this.forwardRpcResponseToIframe({ rpcResponse: { jsonrpc, id, result } })
      })
      .catch((error) => {
        if (this.providerEventHandlers !== subscription) return
        this.forwardRpcResponseToIframe({ rpcResponse: { jsonrpc, id, error } })
      })
  }

  private processRpcCallFromWindow = ({ rpcRequest }: ProviderRpcRequestPayload): void => {
    this.processRpcRequest(rpcRequest)
  }

  private processProviderMetaInfoRequest = (): void => {
    if (!this.ethereumProvider) return
    // We assume, that all EIP-6963 providers are already announced
    const providerEip6963Info = getEip6963ProviderInfo(this.ethereumProvider, eip6963Providers)
    const providerWcMetadata = getProviderWcMetadata(this.ethereumProvider)

    // Send the provider meta info to the iFrame window
    iframeRpcProviderTransport.postMessageToWindow(
      this.iframeWindow,
      IframeRpcProviderEvents.SEND_PROVIDER_META_INFO,
      { providerEip6963Info, providerWcMetadata },
      this.iframeOrigin,
    )
  }

  private onProviderEvent(event: string, params: unknown): void {
    iframeRpcProviderTransport.postMessageToWindow(
      this.iframeWindow,
      IframeRpcProviderEvents.PROVIDER_ON_EVENT,
      { event, params },
      this.iframeOrigin,
    )
  }

  /**
   * Forward a JSON-RPC message to the content window.
   */
  private forwardRpcResponseToIframe(params: ProviderRpcResponsePayload): void {
    iframeRpcProviderTransport.postMessageToWindow(
      this.iframeWindow,
      IframeRpcProviderEvents.PROVIDER_RPC_RESPONSE,
      params,
      this.iframeOrigin,
    )
  }
}
