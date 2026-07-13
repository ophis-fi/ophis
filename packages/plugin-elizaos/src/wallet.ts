import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  maxUint256,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { IAgentRuntime } from '@elizaos/core';
import type { OphisAgentWallet, OphisTypedData } from '@ophis/agent-swap';
import { resolveChain, SUPPORTED_CHAIN_NAMES } from './chains.js';

function readPrivateKey(runtime: IAgentRuntime): `0x${string}` {
  const pk = runtime.getSetting('EVM_PRIVATE_KEY');
  if (typeof pk !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('EVM_PRIVATE_KEY is missing or is not a 32-byte 0x hex key.');
  }
  return pk as `0x${string}`;
}

/**
 * Build the `OphisAgentWallet` that `executeOphisSwap` needs, from the agent's own
 * EVM key + the target chain. The wallet is an EOA, so orders are signed via EIP-712
 * (not presign). RPC precedence: ETHEREUM_PROVIDER_<CHAIN> / EVM_PROVIDER_<CHAIN>
 * setting, else the chain's default public RPC.
 */
export function buildOphisWallet(runtime: IAgentRuntime, chainName: string): OphisAgentWallet {
  const resolved = resolveChain(chainName);
  if (!resolved) {
    throw new Error(`Unsupported chain "${chainName}". Ophis supports: ${SUPPORTED_CHAIN_NAMES.join(', ')}.`);
  }
  const account = privateKeyToAccount(readPrivateKey(runtime));
  const address = account.address as Address;

  const rpcOverride =
    runtime.getSetting(`ETHEREUM_PROVIDER_${resolved.settingKey}`) ??
    runtime.getSetting(`EVM_PROVIDER_${resolved.settingKey}`);
  const transport = http(typeof rpcOverride === 'string' && rpcOverride ? rpcOverride : undefined);

  const publicClient = createPublicClient({ chain: resolved.chain, transport });
  const walletClient = createWalletClient({ account, chain: resolved.chain, transport });

  return {
    getAddress: () => address,
    getChainId: () => resolved.id,
    readErc20Decimals: async (token) =>
      Number(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
    ensureErc20Allowance: async (token, spender, minAtomicAmount) => {
      const current = (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, spender],
      })) as bigint;
      if (current < minAtomicAmount) {
        // Max approval to the CoW vault relayer (spender fixed by the swap core) so a
        // repeat swap of the same token needs no further approval. Await the receipt
        // so the subsequent order is fillable.
        const hash = await walletClient.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, maxUint256],
          account,
          chain: resolved.chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
    },
    signTypedData: async (data: OphisTypedData) => {
      // The EOA signs the CoW order directly (EIP-712). OphisTypedData is a loose
      // envelope by design (domain/types/message are Records), so cast it to viem's
      // strict typed-data parameter type at this single boundary.
      const signature = await account.signTypedData(
        data as Parameters<typeof account.signTypedData>[0],
      );
      return signature as Address;
    },
  };
}
