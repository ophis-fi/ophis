import { WalletConnect, WalletConnectConstructorArgs } from '@web3-react/walletconnect-v2'

export class WalletConnectV2Connector extends WalletConnect {
  private disconnecting?: Promise<void>

  constructor(private readonly configuration: WalletConnectConstructorArgs) {
    super(configuration)
  }

  async connectEagerly(): Promise<void> {
    await super.connectEagerly()
    this.syncRpcChain()
  }

  private syncRpcChain(): void {
    // WalletConnect restores RPCs in session-account order, which can differ
    // from the selected chain. Align reads before using the connected wallet.
    if (this.provider?.session) this.provider.signer.setDefaultChain(`eip155:${this.provider.chainId}`)
  }

  async activate(desiredChainId?: number): Promise<void> {
    await this.disconnecting
    try {
      if (this.provider && !this.provider.session) {
        const cancelActivation = this.actions.startActivation()
        const chainId = desiredChainId ?? this.configuration.defaultChainId
        const { chains, optionalChains } = this.configuration.options
        try {
          await this.provider.connect({
            chains: preferChain(chains, chainId),
            optionalChains: preferChain(optionalChains, chainId),
          })
        } catch (error) {
          await this.deactivate()
          cancelActivation()
          throw error
        }
      } else {
        await super.activate(desiredChainId)
      }
    } catch (error) {
      // Upstream caches a rejected initialization promise before its cleanup block.
      if (!this.provider) await this.deactivate()
      throw error
    }
    this.syncRpcChain()

    /**
     * In CoW Swap we have "change wallet" functionality.
     * When user changes wallet from WC to another one and back to WC, we need to update the state.
     * Because in `WalletConnect.activate()` they don't update the state if the session is the same.
     */
    if (this.provider) {
      this.actions.update({ chainId: this.provider.chainId, accounts: this.provider.accounts })
    }
  }

  async deactivate(): Promise<void> {
    if (!this.provider) return super.deactivate()
    // The SDK keeps its engine on a shared Core after disconnect. Reinitializing
    // would leave competing engines consuming responses for the same session.
    this.actions.resetState()
    if (!this.disconnecting) {
      this.disconnecting = this.provider.disconnect().finally(() => {
        this.actions.resetState()
        this.disconnecting = undefined
      })
    }
    return this.disconnecting
  }
}

function preferChain(chains: number[] | undefined, chainId: number | undefined): number[] | undefined {
  if (!chainId || !chains?.length) return chains
  if (!chains.includes(chainId)) throw new Error(`Invalid chainId ${chainId}`)
  return [chainId, ...chains.filter((chain) => chain !== chainId)]
}
