import type { EvmWalletProvider } from '@coinbase/agentkit';
import { erc20Abi, encodeFunctionData, maxUint256 } from 'viem';
import type { Address, OphisAgentWallet, OphisTypedData } from '@ophis/agent-swap';

/**
 * Translate a Coinbase AgentKit `EvmWalletProvider` into the framework-agnostic `OphisAgentWallet`
 * the swap core needs. AgentKit's chainId is a decimal STRING; the rest map 1:1.
 */
export function toOphisWallet(provider: EvmWalletProvider): OphisAgentWallet {
  const address = () => provider.getAddress() as Address;
  return {
    getAddress: address,
    getChainId: () => Number(provider.getNetwork().chainId),
    readErc20Decimals: async (token) => {
      const decimals = await provider.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
      return Number(decimals);
    },
    ensureErc20Allowance: async (token, spender, minAmount) => {
      const current = (await provider.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address(), spender],
      })) as bigint;
      if (current < minAmount) {
        // Approve the CoW vault relayer (audited, fixed). Max approval avoids a re-approve per swap.
        const hash = await provider.sendTransaction({
          to: token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }),
        });
        await provider.waitForTransactionReceipt(hash);
      }
    },
    signTypedData: async (data: OphisTypedData) => {
      const signature = await provider.signTypedData(data as never);
      return signature as Address;
    },
  };
}
