/**
 * Fork-test harness: spin an anvil fork, deploy a 1-of-1 Safe against the canonical
 * (real, deployed) Safe infrastructure, and fund it with a real ERC-20 by probing the
 * balance storage slot. No mocks: everything runs against the chain's actual contracts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Anvil default account 0 (well-known dev key).
export const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const ANVIL_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

// Canonical Safe v1.3.0 deterministic deployments (present on every EVM chain Safe supports).
const SAFE_L2_SINGLETON = '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA' as const;
const SAFE_PROXY_FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as const;
const SAFE_FALLBACK_HANDLER = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' as const;

const FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);
const SAFE_SETUP_ABI = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
]);
export const SETTLEMENT_ABI = parseAbi(['function preSignature(bytes) view returns (uint256)']);

// GPv2 marker written by setPreSignature(uid, true).
export const PRE_SIGNED = BigInt(keccak256(toHex('GPv2Signing.Scheme.PreSign')));

const anvilBin = `${homedir()}/.foundry/bin/anvil`;

export interface Fork {
  rpcUrl: string;
  pub: PublicClient;
  wallet: WalletClient;
  proc: ChildProcess;
  stop: () => void;
}

export async function startFork(forkUrl: string, port: number): Promise<Fork> {
  const proc = spawn(anvilBin, ['--fork-url', forkUrl, '--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL_PK), transport: http(rpcUrl) });

  // Wait for the RPC to answer.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error('anvil did not become ready in 30s');
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { rpcUrl, pub, wallet, proc, stop: () => proc.kill() };
}

async function anvilRpc(fork: Fork, method: string, params: unknown[]): Promise<void> {
  await fetch(fork.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** Deploy a 1-of-1 Safe owned by anvil account 0 against the canonical factory. */
export async function deploySafe(fork: Fork, saltNonce: bigint): Promise<Address> {
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [
      [ANVIL_ACCOUNT],
      1n,
      '0x0000000000000000000000000000000000000000',
      '0x',
      SAFE_FALLBACK_HANDLER,
      '0x0000000000000000000000000000000000000000',
      0n,
      '0x0000000000000000000000000000000000000000',
    ],
  });
  const { result } = await fork.pub.simulateContract({
    account: ANVIL_ACCOUNT,
    address: SAFE_PROXY_FACTORY,
    abi: FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_L2_SINGLETON, initializer, saltNonce],
  });
  const hash = await fork.wallet.writeContract({
    chain: null,
    account: privateKeyToAccount(ANVIL_PK),
    address: SAFE_PROXY_FACTORY,
    abi: FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_L2_SINGLETON, initializer, saltNonce],
  });
  await fork.pub.waitForTransactionReceipt({ hash });
  return result as Address;
}

/**
 * Fund `holder` with `amount` of ERC-20 `token` by finding the balanceOf storage slot:
 * write a sentinel to mapping(address=>uint) at each candidate base slot and keep the one
 * that makes balanceOf() reflect it. Robust across FiatToken / WETH / OZ layouts.
 */
export async function dealErc20(fork: Fork, token: Address, holder: Address, amount: bigint): Promise<void> {
  for (let slot = 0n; slot <= 30n; slot++) {
    const key = keccak256(`0x${pad(holder, { size: 32 }).slice(2)}${pad(toHex(slot), { size: 32 }).slice(2)}` as Hex);
    const prev = await fork.pub.getStorageAt({ address: token, slot: key });
    await anvilRpc(fork, 'anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })]);
    const bal = await fork.pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] });
    if (bal === amount) return;
    // restore and keep probing
    await anvilRpc(fork, 'anvil_setStorageAt', [token, key, prev ?? pad('0x0', { size: 32 })]);
  }
  throw new Error(`dealErc20: could not find the balance slot for ${token}`);
}

export async function impersonate(fork: Fork, addr: Address): Promise<void> {
  await anvilRpc(fork, 'anvil_impersonateAccount', [addr]);
  await anvilRpc(fork, 'anvil_setBalance', [addr, toHex(10n ** 18n)]); // gas
}
