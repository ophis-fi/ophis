import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { open } from 'node:fs/promises';
import {
  TRADE_REWARDS_CHAIN_ID,
  TRADE_REWARDS_DISTRIBUTOR_SAFE,
  TRADE_REWARDS_MAX_PAYOUT,
  TRADE_REWARDS_RELAYER,
  TRADE_REWARDS_SIGNER,
  ROBINHOOD_USDG,
} from './config.js';

export const REWARDS_DISTRIBUTOR_ABI = [
  {
    type: 'function', name: 'assign', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'ticketId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
  },
  {
    type: 'function', name: 'claim', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'recipient', type: 'address' }],
  },
  {
    type: 'function', name: 'rewardOf', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'claimed', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }],
  },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'rewardSigner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'signerEpoch', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'totalClaimedValue', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'rewardToken', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

const BALANCE_OF_ABI = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}] as const;

const ASSIGNMENT_TYPES = {
  Assignment: [
    { name: 'recipient', type: 'address' },
    { name: 'ticketId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'signerEpoch', type: 'uint256' },
  ],
} as const;

async function privateKeyFromFile(envName: string): Promise<Hex> {
  const path = process.env[envName]?.trim();
  if (!path) throw new Error(`${envName} is required`);
  const handle = await open(path, 'r');
  let rawValue: string;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${envName} must point to a regular file`);
    if ((metadata.mode & 0o077) !== 0) throw new Error(`${envName} must have mode 0600 or stricter`);
    rawValue = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const value = rawValue.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${envName} does not contain a private key`);
  return value as Hex;
}

export function rewardsDistributorAddress(): `0x${string}` {
  const value = process.env.REWARDS_DISTRIBUTOR_ADDRESS?.trim();
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('REWARDS_DISTRIBUTOR_ADDRESS is not configured');
  }
  return value as `0x${string}`;
}

function rewardsRpcUrl(): string {
  const value = process.env.REWARDS_ROBINHOOD_RPC_URL?.trim()
    || process.env.SETTLE_RPC_URL_4663?.trim()
    || 'https://rpc.mainnet.chain.robinhood.com';
  return value;
}

export async function assertRewardsContractReady(): Promise<void> {
  const transport = http(rewardsRpcUrl(), { timeout: 15_000 });
  const client = createPublicClient({ transport });
  const distributor = rewardsDistributorAddress();
  const code = await client.getCode({ address: distributor });
  if (!code || code === '0x') throw new Error('rewards distributor has no code on Robinhood Chain');
  const [owner, signer, token, balance, claimedValue] = await Promise.all([
    client.readContract({ address: distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'owner' }),
    client.readContract({ address: distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'rewardSigner' }),
    client.readContract({ address: distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'rewardToken' }),
    client.readContract({ address: ROBINHOOD_USDG, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [distributor] }),
    client.readContract({ address: distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'totalClaimedValue' }),
  ]);
  if (owner.toLowerCase() !== TRADE_REWARDS_DISTRIBUTOR_SAFE.toLowerCase()) throw new Error('rewards owner mismatch');
  if (signer.toLowerCase() !== TRADE_REWARDS_SIGNER.toLowerCase()) throw new Error('rewards signer mismatch');
  if (token.toLowerCase() !== ROBINHOOD_USDG.toLowerCase()) throw new Error('rewards token mismatch');
  assertRewardsFunding(balance, claimedValue);
}

/**
 * Require enough USDG to cover the campaign's remaining maximum liability.
 * Excess tokens are harmless: ERC-20 transfers cannot be rejected, so exact
 * equality would let any account halt assignments by donating one base unit.
 */
export function assertRewardsFunding(balance: bigint, claimedValue: bigint): void {
  const lifetimeFunding = balance + claimedValue;
  if (lifetimeFunding < TRADE_REWARDS_MAX_PAYOUT) {
    throw new Error(
      `rewards funding invariant failed: balance + paid = ${lifetimeFunding}/${TRADE_REWARDS_MAX_PAYOUT} USDG base units`,
    );
  }
}

export async function rewardState(recipient: `0x${string}`): Promise<{ amount: bigint; claimed: boolean }> {
  const client = createPublicClient({ transport: http(rewardsRpcUrl(), { timeout: 15_000 }) });
  const address = rewardsDistributorAddress();
  const [amount, wasClaimed] = await Promise.all([
    client.readContract({ address, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'rewardOf', args: [recipient] }),
    client.readContract({ address, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'claimed', args: [recipient] }),
  ]);
  return { amount, claimed: wasClaimed };
}

export async function signRewardAssignment(
  recipient: `0x${string}`,
  ticketId: bigint,
  amount: bigint,
): Promise<{ signature: Hex; signerEpoch: bigint }> {
  const signer = privateKeyToAccount(await privateKeyFromFile('REWARDS_SIGNER_PRIVATE_KEY_FILE'));
  if (signer.address.toLowerCase() !== TRADE_REWARDS_SIGNER.toLowerCase()) {
    throw new Error(`reward signer key resolves to ${signer.address}, expected ${TRADE_REWARDS_SIGNER}`);
  }
  const client = createPublicClient({ transport: http(rewardsRpcUrl(), { timeout: 15_000 }) });
  const signerEpoch = await client.readContract({
    address: rewardsDistributorAddress(), abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'signerEpoch',
  });
  const signature = await signer.signTypedData({
    domain: {
      name: 'Ophis Rewards',
      version: '1',
      chainId: TRADE_REWARDS_CHAIN_ID,
      verifyingContract: rewardsDistributorAddress(),
    },
    types: ASSIGNMENT_TYPES,
    primaryType: 'Assignment',
    message: { recipient, ticketId, amount, signerEpoch },
  });
  return { signature, signerEpoch };
}

function signatureParts(signature: Hex): { v: number; r: Hex; s: Hex } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('invalid 65-byte assignment signature');
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const rawV = Number.parseInt(signature.slice(130, 132), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  if (v !== 27 && v !== 28) throw new Error('invalid assignment signature v');
  return { v, r, s };
}

async function relayerClients() {
  const account = privateKeyToAccount(await privateKeyFromFile('REWARDS_RELAYER_PRIVATE_KEY_FILE'));
  if (account.address.toLowerCase() !== TRADE_REWARDS_RELAYER.toLowerCase()) {
    throw new Error(`relayer key resolves to ${account.address}, expected ${TRADE_REWARDS_RELAYER}`);
  }
  const transport = http(rewardsRpcUrl(), { timeout: 15_000 });
  return {
    account,
    publicClient: createPublicClient({ transport }),
    walletClient: createWalletClient({ account, transport }),
  };
}

export async function relayAssignment(
  recipient: `0x${string}`,
  ticketId: bigint,
  amount: bigint,
  signature: Hex,
): Promise<Hex> {
  const { account, publicClient, walletClient } = await relayerClients();
  const { v, r, s } = signatureParts(signature);
  const request = await publicClient.simulateContract({
    account,
    address: rewardsDistributorAddress(),
    abi: REWARDS_DISTRIBUTOR_ABI,
    functionName: 'assign',
    args: [recipient, ticketId, amount, v, r, s],
  });
  const hash = await walletClient.writeContract(request.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error(`reward assignment reverted: ${hash}`);
  return hash;
}

export async function relayClaim(recipient: `0x${string}`): Promise<Hex> {
  const { account, publicClient, walletClient } = await relayerClients();
  const request = await publicClient.simulateContract({
    account,
    address: rewardsDistributorAddress(),
    abi: REWARDS_DISTRIBUTOR_ABI,
    functionName: 'claim',
    args: [recipient],
  });
  const hash = await walletClient.writeContract(request.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error(`reward claim reverted: ${hash}`);
  return hash;
}
