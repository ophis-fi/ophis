import { EVM, FunctionOptions } from '@heyanon/sdk';
import { erc20Abi, type Address } from 'viem';
import type { OphisAgentWallet, OphisTypedData } from '@ophis/agent-swap';

type Evm = NonNullable<FunctionOptions['evm']>;

/**
 * Translate HeyAnon's `options.evm` into the framework-agnostic `OphisAgentWallet`
 * the audited `executeOphisSwap` needs. `account` + `chainId` are resolved by the
 * caller (HeyAnon `getAddress()` is async) so the sync `getAddress`/`getChainId`
 * accessors can return them. Requires `signTypedDatas` — the caller feature-detects it.
 */
export function toOphisWallet(evm: Evm, account: Address, chainId: number): OphisAgentWallet {
  const provider = evm.getProvider(chainId);
  return {
    getAddress: () => account,
    getChainId: () => chainId,
    readErc20Decimals: async (token) =>
      Number(await provider.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
    ensureErc20Allowance: async (token, spender, minAtomicAmount) => {
      // Reuse HeyAnon's audited checkToApprove: it reads the current allowance and
      // appends an approve tx only when insufficient. Fire it via sendTransactions.
      const transactions: EVM.types.TransactionParams[] = [];
      await EVM.utils.checkToApprove({
        args: { account, target: token, spender, amount: minAtomicAmount },
        transactions,
        provider,
      });
      if (transactions.length > 0) {
        await evm.sendTransactions({ chainId, account, transactions });
      }
    },
    signTypedData: async (data: OphisTypedData) => {
      // Feature-detected by the caller. @heyanon/sdk 2.3.1 takes an array of
      // Omit<SignTypedDataParameters, 'account'> (the SDK signs with the connected
      // account itself — do NOT pass account). OphisTypedData is a loose envelope, so
      // cast at this boundary. One order in, read result[0].
      const sigs = await evm.signTypedDatas!([data as never]);
      return sigs[0] as Address;
    },
  };
}
