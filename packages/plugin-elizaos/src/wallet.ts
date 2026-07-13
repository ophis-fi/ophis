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
      if (current >= minAtomicAmount) return;

      const approve = async (value: bigint) => {
        const hash = await walletClient.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, value],
          account,
          chain: resolved.chain,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        // A reverted approval must NOT proceed — otherwise we'd submit an unfillable
        // order against a still-insufficient allowance.
        if (receipt.status !== 'success') {
          throw new Error(`ERC-20 approve reverted (tx ${hash}) for ${token}; aborting the swap.`);
        }
      };

      // Some tokens (e.g. Ethereum USDT) revert on a non-zero -> non-zero approve, so
      // reset an existing insufficient allowance to 0 first. Then set the max approval
      // (the spender is the CoW vault relayer, fixed by the swap core), so repeat swaps
      // of the same token need no further approval.
      if (current > 0n) await approve(0n);
      await approve(maxUint256);
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
