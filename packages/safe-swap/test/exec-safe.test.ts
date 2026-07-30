import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';

const EXEC_FAILURE_TOPIC = keccak256(toHex('ExecutionFailure(bytes32,uint256)'));

// Mock protocol-kit's default export (Safe.init) so the executor's control flow is
// covered in CI without a chain. The fork test covers the real threshold-1 execute path.
const okReceipt = { status: 1, logs: [] as { topics: string[] }[] };
const safeMock = vi.hoisted(() => ({
  createTransaction: vi.fn(async () => ({ __safeTx: true })),
  getTransactionHash: vi.fn(async () => '0xsafetxhash'),
  signTransaction: vi.fn(async () => ({ __signed: true, encodedSignatures: () => '0xSIG' })),
  getThreshold: vi.fn(async () => 1),
  executeTransaction: vi.fn(async () => ({ hash: '0xethtxhash', transactionResponse: { wait: async () => okReceipt } })),
}));
const init = vi.hoisted(() => vi.fn(async () => safeMock));
vi.mock('@safe-global/protocol-kit', () => ({ default: { init } }));

const { executeOphisSafePresign } = await import('../src/exec-safe.js');

const TXS = [
  { to: '0x1111111111111111111111111111111111111111', value: '0', data: '0xaaaa' },
  { to: '0x2222222222222222222222222222222222222222', value: '0', data: '0xbbbb' },
] as const;
const base = { provider: 'http://localhost:8545', signer: '0x' + '1'.repeat(64), safe: '0x3333333333333333333333333333333333333333' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  safeMock.getThreshold.mockResolvedValue(1);
  okReceipt.status = 1;
  okReceipt.logs = [];
  safeMock.executeTransaction.mockResolvedValue({ hash: '0xethtxhash', transactionResponse: { wait: async () => okReceipt } });
});

describe('executeOphisSafePresign', () => {
  it('builds a MultiSendCallOnly batch and executes at threshold 1', async () => {
    const res = await executeOphisSafePresign({ ...base, txs: [...TXS] });
    expect(safeMock.createTransaction).toHaveBeenCalledWith({
      transactions: [
        { to: TXS[0].to, value: '0', data: TXS[0].data },
        { to: TXS[1].to, value: '0', data: TXS[1].data },
      ],
      onlyCalls: true, // MultiSendCallOnly
    });
    expect(safeMock.executeTransaction).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ safeTxHash: '0xsafetxhash', ethTxHash: '0xethtxhash', executed: true, threshold: 1 });
  });

  it('THROWS when the receipt reverted (status 0)', async () => {
    okReceipt.status = 0;
    await expect(executeOphisSafePresign({ ...base, txs: [...TXS] })).rejects.toThrow(/did not succeed.*reverted/);
  });

  it('THROWS on a Safe ExecutionFailure (mined but inner batch reverted)', async () => {
    okReceipt.logs = [{ topics: [EXEC_FAILURE_TOPIC] }];
    await expect(executeOphisSafePresign({ ...base, txs: [...TXS] })).rejects.toThrow(/ExecutionFailure/);
  });

  it('does NOT execute a multisig (threshold > 1); returns the safeTxHash + this signer signature', async () => {
    safeMock.getThreshold.mockResolvedValue(3);
    const res = await executeOphisSafePresign({ ...base, txs: [...TXS] });
    expect(safeMock.signTransaction).toHaveBeenCalledTimes(1);
    expect(safeMock.executeTransaction).not.toHaveBeenCalled();
    expect(res).toEqual({ safeTxHash: '0xsafetxhash', executed: false, threshold: 3, signatures: '0xSIG' });
  });

  it('rejects an empty batch', async () => {
    await expect(executeOphisSafePresign({ ...base, txs: [] })).rejects.toThrow(/empty tx batch/);
    expect(init).not.toHaveBeenCalled();
  });
});
