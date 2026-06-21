import type { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { erc20Abi, maxUint256 } from 'viem';
import type { Address, OphisAgentWallet, OphisTypedData } from '@ophis/agent-swap';

/**
 * Translate a GOAT `EVMWalletClient` into the framework-agnostic `OphisAgentWallet` the swap core
 * needs. The core does the CoW order flow; this only maps the five wallet primitives.
 */
export function toOphisWallet(client: EVMWalletClient): OphisAgentWallet {
  const address = () => client.getAddress() as Address;
  return {
    getAddress: address,
    getChainId: () => client.getChain().id,
    readErc20Decimals: async (token) => {
      const { value } = await client.read({ address: token, abi: erc20Abi, functionName: 'decimals' });
      return Number(value);
    },
    ensureErc20Allowance: async (token, spender, minAmount) => {
      const current = await client.getTokenAllowance({ tokenAddress: token, owner: address(), spender });
      if (BigInt(current as string) < minAmount) {
        // Approve the CoW vault relayer (an audited, fixed contract). A max approval avoids a
        // re-approve on every swap — the common pattern for a programmatic agent.
        await client.approve({ tokenAddress: token, spender, amount: maxUint256.toString() });
      }
    },
    signTypedData: async (data: OphisTypedData) => {
      const { signature } = await client.signTypedData(data as never);
      return signature as Address;
    },
  };
}
