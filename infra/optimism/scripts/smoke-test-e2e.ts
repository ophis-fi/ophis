// infra/optimism/scripts/smoke-test-e2e.ts
//
// Programmatic end-to-end smoke test of the Optimism Sepolia chain
// backend. Signs a WETH→GTUSD order with a test wallet, posts to
// optimism-sepolia.ophis.fi/api/v1/orders, polls for settlement,
// verifies the on-chain settlement tx.
//
// Pre-condition: greg-chiado-test wallet (0x412c…294aB) must hold
// ≥ 0.001 ETH (gas) AND ≥ 0.001 WETH on Optimism Sepolia. Fund via
// https://docs.optimism.io/builders/tools/build/faucets then wrap to
// the WETH predeploy at 0x4200000000000000000000000000000000000006.
//
// Exits 0 on full success, 1 on any failure.

import { OrderKind, SigningScheme } from '@cowprotocol/cow-sdk';
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import chalk from 'chalk';

// Greg's CoW settlement deployment — CREATE2-deterministic across all
// Greg-deployed chains (Optimism Sepolia, MegaETH testnet, future mainnets).
// Different from canonical CoW (0x9008…ab41) because Greg uses its own
// deployer + salt.
const GPV2_SETTLEMENT = '0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce' as const;

const OPTIMISM_SEPOLIA = {
  ...sepolia,
  id: 11155420,
  name: 'Optimism Sepolia',
  rpcUrls: { default: { http: ['https://sepolia.optimism.io'] } },
} as const;

const ORDERBOOK_URL = 'https://optimism-sepolia.ophis.fi';
const VAULT_RELAYER = '0x842F655C9310C32e5932A0eBFa80c4Cd358c0205' as const;
const WETH =
  (process.env.OPTIMISM_SEPOLIA_WETH as `0x${string}` | undefined) ??
  '0x4200000000000000000000000000000000000006';
const GTUSD = process.env.OPTIMISM_SEPOLIA_GTUSD as `0x${string}` | undefined;
const TEST_PK = process.env.OPTIMISM_SEPOLIA_TEST_WALLET_PK as
  | `0x${string}`
  | undefined;

if (!GTUSD) {
  console.error(
    chalk.red(
      'Missing env OPTIMISM_SEPOLIA_GTUSD — set to the Greg-deployed GTUSD test-token address (see infra/cloudflare/ophis-chain-backends.md table)',
    ),
  );
  process.exit(2);
}
if (!TEST_PK) {
  console.error(
    chalk.red(
      'Missing env OPTIMISM_SEPOLIA_TEST_WALLET_PK — set to a Sepolia-funded private key holding WETH',
    ),
  );
  process.exit(2);
}

const account = privateKeyToAccount(TEST_PK);
console.log(chalk.dim(`test wallet: ${account.address}`));

const publicClient = createPublicClient({
  chain: OPTIMISM_SEPOLIA,
  transport: http(),
});
const walletClient = createWalletClient({
  account,
  chain: OPTIMISM_SEPOLIA,
  transport: http(),
});

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

async function main() {
  console.log(chalk.cyan('=== Optimism Sepolia E2E smoke test ==='));

  // Step 1: Check WETH balance
  const wethContract = getContract({
    address: WETH,
    abi: ERC20_ABI,
    client: publicClient,
  });
  const wethBalance = await wethContract.read.balanceOf([account.address]);
  console.log(chalk.dim(`WETH balance: ${wethBalance}`));
  if (wethBalance < parseEther('0.001')) {
    console.error(
      chalk.red(
        'Insufficient WETH (need ≥ 0.001) — fund via faucet then wrap ETH at the WETH predeploy 0x4200…0006',
      ),
    );
    process.exit(1);
  }

  // Step 2: Approve VaultRelayer if not already
  const allowance = await wethContract.read.allowance([
    account.address,
    VAULT_RELAYER,
  ]);
  if (allowance < parseEther('0.001')) {
    console.log(chalk.yellow('Approving VaultRelayer...'));
    const txHash = await walletClient.writeContract({
      address: WETH,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [VAULT_RELAYER, parseEther('1000')],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(chalk.green(`  ✓ approved (tx ${txHash})`));
  }

  // Step 3: Build + sign order. We talk to our self-hosted orderbook
  // via raw fetch — the cow-sdk's OrderBookApi has a hardcoded chain→URL
  // map and won't honor backendUrl for chains it doesn't know.
  const sellAmount = parseEther('0.001');
  const buyAmount = parseUnits('2', 18);

  const validTo = Math.floor(Date.now() / 1000) + 30 * 60;
  const appData = '{"appCode":"ophis"}';
  // appDataHash must equal keccak256(utf8(appData)) — the orderbook
  // recomputes and rejects on mismatch.
  const appDataHash = keccak256(toBytes(appData));
  const order = {
    sellToken: WETH,
    buyToken: GTUSD,
    receiver: account.address,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    validTo,
    feeAmount: '0',
    kind: OrderKind.SELL,
    partiallyFillable: false,
    appData,
    appDataHash,
  };

  // Sign EIP-712 manually — the cow-sdk's OrderSigningUtils.signOrder
  // hardcodes domains for canonical chains only and rejects 11155420.
  // The settlement contract is at the same CREATE2 address on every
  // chain we deploy it to, so the domain just swaps chainId.
  console.log(chalk.yellow('Signing order (manual EIP-712)...'));
  const signature = await walletClient.signTypedData({
    domain: {
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: 11155420,
      verifyingContract: GPV2_SETTLEMENT,
    },
    types: {
      Order: [
        { name: 'sellToken', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'receiver', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'buyAmount', type: 'uint256' },
        { name: 'validTo', type: 'uint32' },
        { name: 'appData', type: 'bytes32' },
        { name: 'feeAmount', type: 'uint256' },
        { name: 'kind', type: 'string' },
        { name: 'partiallyFillable', type: 'bool' },
        { name: 'sellTokenBalance', type: 'string' },
        { name: 'buyTokenBalance', type: 'string' },
      ],
    },
    primaryType: 'Order',
    message: {
      sellToken: WETH,
      buyToken: GTUSD,
      receiver: account.address,
      sellAmount,
      buyAmount,
      validTo,
      appData: appDataHash,
      feeAmount: 0n,
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
  });

  // Step 4: Submit
  console.log(chalk.yellow('Submitting to orderbook...'));
  const orderPayload = {
    sellToken: WETH,
    buyToken: GTUSD,
    receiver: account.address,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    validTo,
    appData,
    appDataHash,
    feeAmount: '0',
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
    signature,
    signingScheme: SigningScheme.EIP712,
    from: account.address,
  };
  const submitRes = await fetch(`${ORDERBOOK_URL}/api/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(orderPayload),
  });
  if (!submitRes.ok) {
    const body = await submitRes.text();
    console.error(chalk.red(`POST /orders → ${submitRes.status}: ${body}`));
    process.exit(1);
  }
  const orderUid = (await submitRes.json()) as string;
  console.log(chalk.green(`  ✓ order accepted, uid ${orderUid}`));

  // Step 5: Poll for settlement (max 5 min)
  console.log(chalk.yellow('Polling for settlement (up to 5 min)...'));
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const statusRes = await fetch(`${ORDERBOOK_URL}/api/v1/orders/${orderUid}`);
    if (!statusRes.ok) {
      console.error(
        chalk.red(`GET /orders/${orderUid} → ${statusRes.status}`),
      );
      process.exit(1);
    }
    const status = (await statusRes.json()) as {
      status: string;
    };
    if (status.status === 'fulfilled') {
      const tradesRes = await fetch(
        `${ORDERBOOK_URL}/api/v1/trades?orderUid=${orderUid}`,
      );
      const trades = (await tradesRes.json()) as Array<{ txHash?: string }>;
      const settlementTx = trades[0]?.txHash;
      if (!settlementTx) {
        console.error(
          chalk.red('Order fulfilled but no settlement tx returned'),
        );
        process.exit(1);
      }
      console.log(
        chalk.green(`  ✓ E2E passed, settlement tx ${settlementTx}`),
      );
      console.log(
        chalk.dim(
          `  https://sepolia-optimism.etherscan.io/tx/${settlementTx}`,
        ),
      );
      process.exit(0);
    }
    if (status.status === 'cancelled' || status.status === 'expired') {
      console.error(chalk.red(`Order ${status.status}`));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  console.error(chalk.red('Timed out waiting for settlement'));
  process.exit(1);
}

main().catch((err) => {
  console.error(chalk.red('Smoke test failed:'), err);
  process.exit(1);
});
