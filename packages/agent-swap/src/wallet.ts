export type Address = `0x${string}`;

/** The EIP-712 typed-data envelope passed to {@link OphisAgentWallet.signTypedData}. */
export interface OphisTypedData {
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * The minimal wallet surface `executeOphisSwap` needs. Both the GOAT `EVMWalletClient` and the
 * Coinbase AgentKit `EvmWalletProvider` expose equivalents of every method below, so each framework
 * adapter is a thin translation to this interface — the swap flow itself is written once.
 *
 * IMPORTANT: the agent wallet is an EOA (it holds a private key), so orders are signed via EIP-712
 * (`signTypedData`), NOT presign. (Presign is the smart-contract-wallet path, e.g. a Safe.)
 */
export interface OphisAgentWallet {
  /** The agent's EOA address — the order owner AND, pinned, the receiver. */
  getAddress(): Address;
  /** The numeric EVM chain id the agent is operating on. */
  getChainId(): number;
  /** Read an ERC-20's `decimals()` so a human/whole-unit amount can be converted to base units. */
  readErc20Decimals(token: Address): Promise<number>;
  /**
   * Ensure `spender` is approved to pull at least `minAtomicAmount` of `token` from the agent
   * (read the allowance; send an `approve` only if it is insufficient). Must resolve AFTER the
   * approval is mined, so the subsequent order is fillable.
   */
  ensureErc20Allowance(token: Address, spender: Address, minAtomicAmount: bigint): Promise<void>;
  /** Sign an EIP-712 typed message; returns the 0x-hex signature. */
  signTypedData(data: OphisTypedData): Promise<Address>;
}
