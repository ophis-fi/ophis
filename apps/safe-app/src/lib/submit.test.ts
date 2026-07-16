import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbiCoder, Interface } from 'ethers';
import { computeOrderUid, type VaultOrder } from '@ophis/safe-swap';
import { getOphisSettlementAddress, getOphisVaultRelayer } from '@ophis/sdk';

// Mock the network-facing collaborators BEFORE importing submit. vi.mock factories are
// hoisted above module consts, so the shared spies must come from vi.hoisted().
const { sendOrder, enrollTrackedWallet } = vi.hoisted(() => ({
  sendOrder: vi.fn<(body: unknown) => Promise<string>>(),
  enrollTrackedWallet: vi.fn<(addr: string) => Promise<void>>(),
}));
vi.mock('./quote', () => ({ ophisOrderBook: () => ({ sendOrder }) }));
vi.mock('./tracking', () => ({ enrollTrackedWallet }));
// weth.ts statically imports @cowprotocol/cow-sdk (WRAPPED_NATIVE_CURRENCIES), whose transitive
// @cowprotocol/contracts module-init assumes ethers v5 and crashes under node/vitest. Provide the
// identical deposit() Interface here — the wrap-tx calldata asserted below is byte-for-byte the same.
vi.mock('./weth', async () => ({
  WETH_DEPOSIT_IFACE: new (await import('ethers')).Interface(['function deposit() payable']),
}));

const { submitOrder } = await import('./submit');

const CHAIN = 10;
const OWNER = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' as `0x${string}`;
const WETH = '0x4200000000000000000000000000000000000006' as `0x${string}`;
const APP_DATA_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const FULL_APP_DATA = '{"appCode":"ophis"}';
const SETTLEMENT = (getOphisSettlementAddress(CHAIN) as string).toLowerCase();
const RELAYER = (getOphisVaultRelayer(CHAIN) as string).toLowerCase();
const MAX_UINT256 = (1n << 256n) - 1n;

const APPROVE_IFACE = new Interface(['function approve(address,uint256)']);
const decodeApprove = (data: string) => {
  const [spender, amount] = APPROVE_IFACE.decodeFunctionData('approve', data);
  return { spender: String(spender).toLowerCase(), amount: BigInt(amount) };
};

const order: VaultOrder = {
  sellToken: USDC,
  buyToken: WETH,
  receiver: OWNER,
  sellAmount: '1000000',
  buyAmount: '500000000000000000',
  validTo: Math.floor(Date.now() / 1000) + 1800,
  appData: APP_DATA_HASH,
  feeAmount: '0',
  kind: 'sell',
  partiallyFillable: false,
  sellTokenBalance: 'erc20',
  buyTokenBalance: 'erc20',
};
const UID = computeOrderUid(order, CHAIN, OWNER);

type SentTxs = { txs: { to: string; value: string; data: string }[] };

function mockSdk(allowance: bigint | 'throws') {
  const call = vi.fn(async () => {
    if (allowance === 'throws') throw new Error('rpc down');
    return AbiCoder.defaultAbiCoder().encode(['uint256'], [allowance]);
  });
  const send = vi.fn(async (_args: SentTxs) => ({ safeTxHash: '0x5afe' }));
  return { sdk: { eth: { call }, txs: { send } } as never, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendOrder.mockResolvedValue(UID);
  enrollTrackedWallet.mockResolvedValue();
});

describe('submitOrder (shared @ophis/safe-swap batch + wire body)', () => {
  it('zero allowance -> [approve(exact), presign] against Ophis relayer/settlement', async () => {
    const { sdk, send } = mockSdk(0n);
    const res = await submitOrder(sdk, CHAIN, OWNER, order, FULL_APP_DATA, APP_DATA_HASH);
    expect(res.orderUid).toBe(UID);
    const { txs } = send.mock.calls[0]![0] as { txs: { to: string; value: string; data: string }[] };
    expect(txs).toHaveLength(2);
    const approve = decodeApprove(txs[0]!.data);
    expect(txs[0]!.to).toBe(USDC);
    expect(approve.spender).toBe(RELAYER);
    expect(approve.amount).toBe(1_000_000n); // EXACT, never MaxUint256
    expect(txs[1]!.to.toLowerCase()).toBe(SETTLEMENT);
    expect(txs[1]!.data.toLowerCase()).toContain(UID.slice(2).toLowerCase()); // setPreSignature(uid, true)
  });

  it('allowance read failure -> defensive [approve(0), approve(exact), presign]', async () => {
    const { sdk, send } = mockSdk('throws');
    await submitOrder(sdk, CHAIN, OWNER, order, FULL_APP_DATA, APP_DATA_HASH);
    const { txs } = send.mock.calls[0]![0] as { txs: { data: string }[] };
    expect(txs).toHaveLength(3);
    expect(decodeApprove(txs[0]!.data).amount).toBe(0n);
    expect(decodeApprove(txs[1]!.data).amount).toBe(1_000_000n);
  });

  it('oversized (MaxUint) allowance is CLAMPED: reset + exact approve (guard parity)', async () => {
    const { sdk, send } = mockSdk(MAX_UINT256);
    await submitOrder(sdk, CHAIN, OWNER, order, FULL_APP_DATA, APP_DATA_HASH);
    const { txs } = send.mock.calls[0]![0] as { txs: { data: string }[] };
    expect(txs).toHaveLength(3);
    expect(decodeApprove(txs[0]!.data).amount).toBe(0n);
    expect(decodeApprove(txs[1]!.data).amount).toBe(1_000_000n);
  });

  it('wrapNative prepends WETH.deposit{value: pullAmount} FIRST', async () => {
    const wethOrder: VaultOrder = { ...order, sellToken: WETH };
    sendOrder.mockResolvedValue(computeOrderUid(wethOrder, CHAIN, OWNER));
    const { sdk, send } = mockSdk(0n);
    await submitOrder(sdk, CHAIN, OWNER, wethOrder, FULL_APP_DATA, APP_DATA_HASH, true);
    const { txs } = send.mock.calls[0]![0] as { txs: { to: string; value: string; data: string }[] };
    expect(txs).toHaveLength(3); // [wrap, approve, presign]
    expect(txs[0]!.to).toBe(WETH);
    expect(txs[0]!.value).toBe('1000000'); // deposit exactly the pull amount
  });

  it('REFUSES to presign a host uid that does not match the local order (no Safe tx proposed)', async () => {
    sendOrder.mockResolvedValue('0x' + 'ff'.repeat(56));
    const { sdk, send } = mockSdk(0n);
    await expect(submitOrder(sdk, CHAIN, OWNER, order, FULL_APP_DATA, APP_DATA_HASH)).rejects.toThrow(
      /does not match the locally computed order uid/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('wire body: full appData preimage + hash + presign signature = owner; enrollment precedes creation', async () => {
    const { sdk } = mockSdk(0n);
    await submitOrder(sdk, CHAIN, OWNER, order, FULL_APP_DATA, APP_DATA_HASH);
    expect(enrollTrackedWallet).toHaveBeenCalledWith(OWNER);
    expect(enrollTrackedWallet.mock.invocationCallOrder[0]!).toBeLessThan(sendOrder.mock.invocationCallOrder[0]!);
    const body = sendOrder.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.appData).toBe(FULL_APP_DATA);
    expect(body.appDataHash).toBe(APP_DATA_HASH);
    expect(body.signature).toBe(OWNER);
    expect(body.signingScheme).toBe('presign');
    expect(body.from).toBe(OWNER);
    expect(body.feeAmount).toBe('0');
  });

  it('enrollment failure is non-blocking and surfaced as a warning', async () => {
    enrollTrackedWallet.mockRejectedValue(new Error('indexer 503'));
    const { sdk } = mockSdk(0n);
    const res = await submitOrder(sdk, CHAIN, OWNER, order, FULL_APP_DATA, APP_DATA_HASH);
    expect(res.orderUid).toBe(UID);
    expect(res.enrollmentWarning).toMatch(/503/);
  });
});
