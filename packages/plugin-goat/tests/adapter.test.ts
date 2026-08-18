import type { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ executeOphisSwap: vi.fn() }));

vi.mock('@ophis/agent-swap', () => ({ executeOphisSwap: mocks.executeOphisSwap }));

// Import the tsc output so GOAT's runtime decorator metadata is present. CI and
// Turbo build dependencies before tests; this is the exact JavaScript shipped
// to npm rather than Vite-transformed decorator source.
import { OphisPlugin } from '../dist/ophis.plugin.js';
import { toOphisWallet } from '../dist/wallet-adapter.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const SPENDER = '0x2222222222222222222222222222222222222222';
const SIGNATURE = '0x' + 'cd'.repeat(65);

function mockClient(chainId = 1) {
  return {
    getAddress: vi.fn(() => OWNER),
    getChain: vi.fn(() => ({ type: 'evm', id: chainId })),
    read: vi.fn(),
    getTokenAllowance: vi.fn(),
    approve: vi.fn(async () => ({ hash: '0xapproval' })),
    signTypedData: vi.fn(async () => ({ signature: SIGNATURE })),
  };
}

afterEach(() => {
  mocks.executeOphisSwap.mockReset();
  vi.restoreAllMocks();
});

describe('Ophis GOAT plugin', () => {
  it('registers one tool and forwards referral, slippage, and derived stable-pair state', async () => {
    mocks.executeOphisSwap.mockResolvedValue({
      orderUid: 'uid',
      explorerUrl: 'https://explorer.test/orders/uid',
    });
    const plugin = new OphisPlugin({ referralCode: 'partner_1' });
    const client = mockClient();
    const [tool] = await plugin.getTools(client as unknown as EVMWalletClient);

    expect(tool?.name).toBe('ophis_swap');
    expect(plugin.supportsChain({ type: 'evm', id: 1 })).toBe(true);
    expect(plugin.supportsChain({ type: 'evm', id: 999_999 })).toBe(false);
    expect(plugin.supportsChain({ type: 'solana' } as never)).toBe(false);

    const result = await tool!.execute({
      sellToken: USDC,
      buyToken: USDT,
      sellAmount: '25',
      slippageBps: 75,
    });

    expect(result).toMatchObject({ orderUid: 'uid' });
    expect(mocks.executeOphisSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        getChainId: expect.any(Function),
        signTypedData: expect.any(Function),
      }),
      { sellToken: USDC, buyToken: USDT, sellAmount: '25', slippageBps: 75 },
      { referralCode: 'partner_1', isStablePair: true },
    );
  });

  it('enforces the adapter slippage schema before an agent call executes', async () => {
    const plugin = new OphisPlugin({ referralCode: 'partner_1' });
    const [tool] = await plugin.getTools(mockClient() as unknown as EVMWalletClient);

    expect(
      tool!.parameters.safeParse({
        sellToken: WETH,
        buyToken: USDC,
        sellAmount: '1',
        slippageBps: 5001,
      }).success,
    ).toBe(false);
    expect(
      tool!.parameters.safeParse({ sellToken: WETH, buyToken: USDC, sellAmount: '1' }).success,
    ).toBe(true);
  });

  it('keeps referral optional while warning the integrator', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new OphisPlugin()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/No referralCode set/));
  });
});

describe('GOAT wallet adapter', () => {
  it('maps decimals, allowance approval, and typed-data signing', async () => {
    const client = mockClient();
    client.read.mockResolvedValue({ value: 6 });
    client.getTokenAllowance.mockResolvedValueOnce('100').mockResolvedValueOnce('0');
    const wallet = toOphisWallet(client as unknown as EVMWalletClient);

    expect(wallet.getAddress()).toBe(OWNER);
    expect(wallet.getChainId()).toBe(1);
    await expect(wallet.readErc20Decimals(USDC)).resolves.toBe(6);

    await wallet.ensureErc20Allowance(USDC, SPENDER, 50n);
    expect(client.approve).not.toHaveBeenCalled();

    await wallet.ensureErc20Allowance(USDC, SPENDER, 50n);
    expect(client.approve).toHaveBeenCalledWith({
      tokenAddress: USDC,
      spender: SPENDER,
      amount: (2n ** 256n - 1n).toString(),
    });

    await expect(
      wallet.signTypedData({ domain: {}, types: {}, primaryType: 'Order', message: {} } as never),
    ).resolves.toBe(SIGNATURE);
  });
});
