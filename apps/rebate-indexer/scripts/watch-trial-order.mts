/**
 * watch-trial-order - M4 live-trial observability (R1).
 *
 * Watches ONE vault-rebalance order end to end and verifies, against the
 * chain, the invariants the fork tests cannot (a fork has no solver network):
 *
 *   1. the order reached a terminal `fulfilled` status on the Ophis orderbook
 *   2. the settlement tx carries a Trade event on the REAL settlement with
 *      owner == the vault Safe and the exact orderUid
 *   3. the bought token was Transferred settlement -> Safe (>= signed
 *      buyAmount, == executedBuyAmount)
 *   4. the sold token was Transferred Safe -> settlement (== executedSellAmount)
 *   5. the protocol (partner) fee was COLLECTED (orderbook executedProtocolFees)
 *   6. fee ARRIVAL at the 0x858...CeF8 Safe is reported as PENDING SWEEP with
 *      the settlement's current buffer balance - on the sovereign chains the
 *      CIP-75 fee accrues INSIDE the settlement contract and only reaches the
 *      recipient via the operator sweep (sweep-to-safe.sh), NOT in the
 *      settlement tx (docs/audits/2026-05-20-cip75-partner-fee-bypass.md).
 *
 * Usage (from apps/rebate-indexer):
 *   pnpm exec tsx scripts/watch-trial-order.mts \
 *     --chain 130 --uid 0x<56-byte-orderUid> --safe 0x<vaultSafe> \
 *     [--rpc <url>] [--timeout 2100] [--interval 10]
 *
 * Telegram ping on completion if TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are set
 * (reuses src/telegram/alerter.ts, which no-ops cleanly when unset).
 */
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem';
import { TRADE_EVENT } from '../src/cow/settleAbi.js';
import { notify } from '../src/telegram/alerter.js';

// Chain wiring. Values mirror @ophis/sdk + contracts/deployments (the SDK is
// not a dependency of this app; keep these in sync with packages/sdk if a
// chain is ever re-pointed). Unichain + OP are Ophis self-hosted
// (non-canonical settlement); Base is CoW-hosted (canonical).
// `sovereign: true` = Ophis self-hosted settlement, where the CIP-75 fee
// accrues in the settlement buffer until the operator sweep. On CoW-hosted
// chains (Base) the canonical settlement is NOT ours to sweep; fee arrival
// follows CoW's own remittance accounting instead.
const CHAINS: Record<number, { name: string; orderbook: string; settlement: Address; rpc: string; sovereign: boolean }> = {
  130: {
    name: 'Unichain',
    orderbook: 'https://unichain-mainnet.ophis.fi',
    settlement: '0x108A678716e5E1776036eF044CAB7064226F714E',
    rpc: 'https://mainnet.unichain.org',
    sovereign: true,
  },
  10: {
    name: 'Optimism',
    orderbook: 'https://optimism-mainnet.ophis.fi',
    settlement: '0x310784c7FCE12d578dA6f53460777bAc9718B859',
    rpc: 'https://mainnet.optimism.io',
    sovereign: true,
  },
  8453: {
    name: 'Base',
    orderbook: 'https://api.cow.fi/base',
    settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    rpc: 'https://mainnet.base.org',
    sovereign: false,
  },
};

const PARTNER_FEE_SAFE: Address = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
const SETTLEMENT_EVENT = parseAbiItem('event Settlement(address indexed solver)');
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ERC20_BALANCE_ABI = [parseAbiItem('function balanceOf(address) view returns (uint256)')];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(2);
}

// Returns null on ANY failure (non-2xx, network error, DNS, abort timeout,
// malformed JSON) so the long-running poll loop retries instead of dying
// mid-trial with no report.
async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[fetch] transient failure for ${url}: ${(e as Error).message}`);
    return null;
  }
}

interface CheckRow {
  name: string;
  pass: boolean | 'PENDING';
  detail: string;
}

async function main(): Promise<void> {
  const chainId = Number(arg('chain') ?? fail('--chain required'));
  const uid = (arg('uid') ?? fail('--uid required')).toLowerCase() as Hex;
  const safe = getAddress(arg('safe') ?? fail('--safe required'));
  const chain = CHAINS[chainId] ?? fail(`unsupported chain ${chainId} (know: ${Object.keys(CHAINS).join(', ')})`);
  const rpc = arg('rpc') ?? chain.rpc;
  const timeoutSec = Number(arg('timeout') ?? 2100); // > the 30 min order TTL
  const intervalSec = Number(arg('interval') ?? 10);
  if (!/^0x[0-9a-f]{112}$/.test(uid)) fail('--uid must be a 56-byte orderUid');

  const client = createPublicClient({ transport: http(rpc) });
  console.log(`[watch] chain=${chain.name}(${chainId}) settlement=${chain.settlement}`);
  console.log(`[watch] safe=${safe}`);
  console.log(`[watch] uid=${uid}`);

  // ---- 1) poll the orderbook until the order is terminal --------------------
  let order: Record<string, unknown> | null = null;
  let status: string;
  const deadline = Date.now() + timeoutSec * 1_000;
  do {
    order = (await fetchJson(`${chain.orderbook}/api/v1/orders/${uid}`)) as Record<string, unknown> | null;
    status = String(order?.status ?? 'unknown');
    const executed = String(order?.executedBuyAmount ?? '0');
    console.log(`[poll ${new Date().toISOString()}] status=${status} executedBuy=${executed}`);
    if (status === 'fulfilled' || status === 'cancelled' || status === 'expired') break;
    await new Promise((r) => setTimeout(r, intervalSec * 1_000));
  } while (Date.now() <= deadline);

  const checks: CheckRow[] = [];
  checks.push({
    name: 'order fulfilled',
    pass: status === 'fulfilled',
    detail: `terminal status: ${status}`,
  });

  if (status !== 'fulfilled' || !order) {
    report(chain.name, uid, checks);
    await notify(`Trial order ${uid.slice(0, 18)}... on ${chain.name}: NOT fulfilled (status=${status})`);
    process.exit(1);
  }

  const buyToken = getAddress(String(order.buyToken));
  const sellToken = getAddress(String(order.sellToken));
  const signedBuyAmount = BigInt(String(order.buyAmount));
  const executedBuy = BigInt(String(order.executedBuyAmount ?? '0'));
  const executedSell = BigInt(String(order.executedSellAmount ?? '0'));

  // ---- 2) find the settlement tx --------------------------------------------
  // v1 first (canonical CoW orderbook), tolerate deployments serving v2.
  const trades =
    ((await fetchJson(`${chain.orderbook}/api/v1/trades?orderUid=${uid}`)) as Record<string, unknown>[] | null) ??
    ((await fetchJson(`${chain.orderbook}/api/v2/trades?orderUid=${uid}`)) as Record<string, unknown>[] | null);
  const txHash = trades?.[0]?.txHash as Hex | undefined;
  checks.push({
    name: 'settlement tx located',
    pass: Boolean(txHash),
    detail: txHash ?? 'no trade row returned by the orderbook',
  });
  if (!txHash) {
    report(chain.name, uid, checks);
    process.exit(1);
  }

  // ---- 3) verify the receipt against the REAL settlement --------------------
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const settlementLc = chain.settlement.toLowerCase();

  let tradeOk = false;
  let solver: string | undefined;
  let buyTransfer = 0n;
  let sellTransfer = 0n;
  for (const log of receipt.logs) {
    const addr = log.address.toLowerCase();
    try {
      if (addr === settlementLc && log.topics[0] === TRADE_EVENT_TOPIC()) {
        const dec = decodeEventLog({ abi: [TRADE_EVENT], data: log.data, topics: log.topics });
        const a = dec.args as { owner: Address; orderUid: Hex };
        if (a.owner.toLowerCase() === safe.toLowerCase() && a.orderUid.toLowerCase() === uid) tradeOk = true;
      } else if (addr === settlementLc && log.topics[0] === SETTLEMENT_EVENT_TOPIC()) {
        const dec = decodeEventLog({ abi: [SETTLEMENT_EVENT], data: log.data, topics: log.topics });
        solver = (dec.args as { solver: Address }).solver;
      } else if (log.topics[0] === TRANSFER_TOPIC()) {
        const dec = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
        const t = dec.args as { from: Address; to: Address; value: bigint };
        if (addr === buyToken.toLowerCase() && t.from.toLowerCase() === settlementLc && t.to.toLowerCase() === safe.toLowerCase()) {
          buyTransfer += t.value;
        }
        if (addr === sellToken.toLowerCase() && t.from.toLowerCase() === safe.toLowerCase() && t.to.toLowerCase() === settlementLc) {
          sellTransfer += t.value;
        }
      }
    } catch {
      /* unrelated log shapes: skip */
    }
  }

  checks.push({
    name: 'Trade event (owner==Safe, uid match) on the real settlement',
    pass: tradeOk,
    detail: `block ${receipt.blockNumber}`,
  });
  checks.push({
    name: 'solver observed',
    pass: Boolean(solver),
    detail: solver ?? 'no Settlement event decoded',
  });
  checks.push({
    name: 'buy token returned to the Safe',
    pass: buyTransfer >= signedBuyAmount && buyTransfer === executedBuy,
    detail: `transferred=${buyTransfer} signedMin=${signedBuyAmount} executed=${executedBuy}`,
  });
  checks.push({
    name: 'sell token pulled exactly',
    pass: sellTransfer === executedSell,
    detail: `transferred=${sellTransfer} executed=${executedSell}`,
  });

  // ---- 4) fee: collected now, arrives at the Safe on sweep ------------------
  // executedProtocolFees lives on the TRADE row (backend model/trade.rs), not
  // on the order metadata; keep the order-level read only as a fallback for
  // orderbook versions that mirror it there.
  const tradeRow = trades?.find((t) => (t.txHash as string | undefined)?.toLowerCase() === txHash.toLowerCase()) ?? trades?.[0];
  const protocolFees = ((tradeRow?.executedProtocolFees ?? order.executedProtocolFees ?? []) as { amount?: string; token?: string }[]);
  const feeCollected = protocolFees.reduce((acc, f) => acc + BigInt(f.amount ?? '0'), 0n);
  checks.push({
    name: 'partner fee collected (trade executedProtocolFees)',
    pass: feeCollected > 0n,
    detail: `total=${feeCollected} entries=${JSON.stringify(protocolFees)}`,
  });

  if (chain.sovereign) {
    // Sovereign settlement: the CIP-75 fee accrues INSIDE the settlement and
    // only reaches the fee Safe via the operator sweep - report the live
    // buffer and leave arrival PENDING until sweep-to-safe.sh runs.
    const bufferBalance = (await client.readContract({
      address: buyToken,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [chain.settlement],
    })) as bigint;
    checks.push({
      name: `fee arrival at ${PARTNER_FEE_SAFE}`,
      pass: 'PENDING',
      detail: `sovereign CIP-75 fee accrues in the settlement; buffer(buyToken)=${bufferBalance}; run sweep-to-safe.sh and verify the Transfer to the fee Safe`,
    });
  } else {
    // CoW-hosted chain: the canonical settlement is not ours to sweep; the
    // partner fee is remitted through CoW's own fee accounting. Collection
    // (above) is the verifiable on-trial signal here.
    checks.push({
      name: `fee arrival at ${PARTNER_FEE_SAFE}`,
      pass: 'PENDING',
      detail: 'CoW-hosted chain: fee remitted via CoW fee accounting/payouts, not an Ophis sweep; reconcile against the next CoW payout cycle',
    });
  }

  const allPass = checks.every((c) => c.pass === true || c.pass === 'PENDING');
  report(chain.name, uid, checks);
  await notify(
    `Trial order on ${chain.name}: ${allPass ? 'PASS' : 'FAIL'}\n` +
      checks.map((c) => `${c.pass === true ? 'OK' : c.pass === 'PENDING' ? '..' : 'XX'} ${c.name}`).join('\n') +
      `\ntx ${txHash}`,
  );
  process.exit(allPass ? 0 : 1);
}

function TRADE_EVENT_TOPIC(): string {
  return '0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17';
}
function SETTLEMENT_EVENT_TOPIC(): string {
  return '0x40338ce1a7c49204f0099533b1e9a7ee0a3d261f84974ab7af36105b8c4e9db4';
}
function TRANSFER_TOPIC(): string {
  return '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
}

function report(chainName: string, uid: string, checks: CheckRow[]): void {
  console.log(`\n=== trial-order verification (${chainName}) ===`);
  console.log(`uid: ${uid}`);
  for (const c of checks) {
    const mark = c.pass === true ? 'PASS   ' : c.pass === 'PENDING' ? 'PENDING' : 'FAIL   ';
    console.log(`  [${mark}] ${c.name}`);
    console.log(`            ${c.detail}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
