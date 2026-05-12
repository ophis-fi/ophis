// infra/megaeth/scripts/smoke-test-e2e.ts
//
// Programmatic end-to-end smoke test of the MegaETH testnet chain backend.
//
// MegaETH testnet has a documented sequencer bug rejecting valid EIP-1559
// settlement txs ("Cannot read properties of undefined (reading 'length')").
// The expected success state stops at "driver simulated OK" — the orderbook
// accepts the order, the driver simulates settlement, but the on-chain
// submission fails at the upstream sequencer. Per Spec 1 design decision D5:
// exits 0 on this expected state, 1 on any other failure (including the case
// where MegaETH unexpectedly settles — that would invalidate our 'known bug'
// annotation and is worth a louder signal than silent success).

import {
  OrderBookApi,
  OrderKind,
  OrderSigningUtils,
  SupportedChainId,
} from '@cowprotocol/cow-sdk';
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseEther,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import chalk from 'chalk';

const MEGAETH_TESTNET = {
  ...sepolia,
  id: 6343,
  name: 'MegaETH Testnet',
  rpcUrls: { default: { http: ['https://carrot.megaeth.com/rpc'] } },
} as const;

const ORDERBOOK_URL = 'https://megaeth-testnet.ophis.fi';
const VAULT_RELAYER = '0x842F655C9310C32e5932A0eBFa80c4Cd358c0205' as const;
const WETH =
  (process.env.MEGAETH_TESTNET_WETH as `0x${string}` | undefined) ??
  '0x4200000000000000000000000000000000000006';
const GTUSD = process.env.MEGAETH_TESTNET_GTUSD as `0x${string}` | undefined;
const TEST_PK = process.env.MEGAETH_TESTNET_TEST_WALLET_PK as
  | `0x${string}`
  | undefined;

if (!GTUSD) {
  console.error(
    chalk.red(
      'Missing env MEGAETH_TESTNET_GTUSD — see infra/megaeth/.env on the VM for the deployed address',
    ),
  );
  process.exit(2);
}
if (!TEST_PK) {
  console.error(
    chalk.red(
      'Missing env MEGAETH_TESTNET_TEST_WALLET_PK — fund via testnet.megaeth.com faucet first',
    ),
  );
  process.exit(2);
}

const account = privateKeyToAccount(TEST_PK);
console.log(chalk.dim(`test wallet: ${account.address}`));

const publicClient = createPublicClient({
  chain: MEGAETH_TESTNET,
  transport: http(),
});
const walletClient = createWalletClient({
  account,
  chain: MEGAETH_TESTNET,
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
  console.log(chalk.cyan('=== MegaETH testnet E2E smoke test ==='));
  console.log(
    chalk.dim(
      'Expected: stops at "driver simulated OK" due to known sequencer bug.',
    ),
  );

  // Step 1: WETH balance check
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
        'Insufficient WETH (need ≥ 0.001) — fund via faucet at testnet.megaeth.com',
      ),
    );
    process.exit(1);
  }

  // Step 2: Approve VaultRelayer
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

  // Step 3: Build + sign order via cow-sdk
  const orderBookApi = new OrderBookApi({
    chainId: 6343 as unknown as SupportedChainId,
    backendUrl: ORDERBOOK_URL,
  });

  const sellAmount = parseEther('0.001');
  const buyAmount = parseUnits('2', 18);

  const order = {
    sellToken: WETH,
    buyToken: GTUSD,
    receiver: account.address,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    validTo: Math.floor(Date.now() / 1000) + 30 * 60,
    feeAmount: '0',
    kind: OrderKind.SELL,
    partiallyFillable: false,
    appData: '{"appCode":"ophis"}',
    appDataHash:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
  };

  console.log(chalk.yellow('Signing order...'));
  const signature = await OrderSigningUtils.signOrder(
    order as any,
    6343,
    walletClient as any,
  );

  // Step 4: Submit
  console.log(chalk.yellow('Submitting to orderbook...'));
  const orderUid = await orderBookApi.sendOrder({
    ...order,
    ...signature,
    from: account.address,
  } as any);
  console.log(chalk.green(`  ✓ order accepted, uid ${orderUid}`));

  // Step 5: Poll. Expected MegaETH success state: order stays open while the
  // driver competition shows a successful simulation. Unexpected: order
  // reaches 'fulfilled' (means the sequencer bug is gone — louder signal).
  console.log(chalk.yellow('Polling competitions (up to 3 min)...'));
  const deadline = Date.now() + 3 * 60_000;
  let driverSimulatedOK = false;
  while (Date.now() < deadline) {
    const status = await orderBookApi.getOrder(orderUid);
    if (status.status === 'fulfilled') {
      console.error(
        chalk.red(
          "Unexpected: MegaETH testnet settled the order. Sequencer bug may have been fixed upstream — update the spec's 'known bug' annotation and switch this script's exit code logic.",
        ),
      );
      process.exit(1);
    }
    if (status.status === 'cancelled' || status.status === 'expired') {
      console.error(chalk.red(`Order ${status.status}`));
      process.exit(1);
    }
    try {
      const competition = (await fetch(
        `${ORDERBOOK_URL}/api/v1/orders/${orderUid}/competition`,
      ).then((r) => r.json() as any)) as any;
      const hasSimulation = competition?.solutions?.some(
        (s: any) => s.simulationOk === true,
      );
      if (hasSimulation) {
        driverSimulatedOK = true;
        console.log(
          chalk.green(
            '  ✓ driver simulated OK (settlement-side sequencer-bug stop expected)',
          ),
        );
        break;
      }
    } catch {
      /* competition endpoint flaky; poll again */
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  if (driverSimulatedOK) {
    console.log(
      chalk.green(
        '✓ simulated, sequencer-bug stop expected (exit 0 per D5)',
      ),
    );
    process.exit(0);
  }

  console.error(
    chalk.red(
      'Timed out without observing driver-simulated state — backend may be unhealthy',
    ),
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(chalk.red('Smoke test failed:'), err);
  process.exit(1);
});
