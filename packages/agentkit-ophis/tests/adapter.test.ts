import type { EvmWalletProvider } from '@coinbase/agentkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ executeOphisSwap: vi.fn() }));

vi.mock('@ophis/agent-swap', () => ({ executeOphisSwap: mocks.executeOphisSwap }));

// Import the tsc output, not raw decorator syntax: AgentKit relies on
// emitDecoratorMetadata, which Vite's source transformer intentionally omits.
// CI and Turbo build dependencies before tests, so this also exercises exactly
// the JavaScript and metadata shipped to npm.
import { OphisSwapSchema } from '../dist/schemas.js';
import { OphisActionProvider } from '../dist/ophisActionProvider.js';
import { toOphisWallet } from '../dist/wallet-adapter.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const USDT_OP = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58';
const WETH_OP = '0x4200000000000000000000000000000000000006';
const SPENDER = '0x2222222222222222222222222222222222222222';
const TX_HASH = '0x' + 'ab'.repeat(32);
const SIGNATURE = '0x' + 'cd'.repeat(65);

function mockProvider(chainId = '10') {
  return {
    getName: vi.fn(() => 'mock-wallet'),
    getAddress: vi.fn(() => OWNER),
    getNetwork: vi.fn(() => ({ chainId, networkId: `eip155:${chainId}`, protocolFamily: 'evm' })),
    readContract: vi.fn(),
    sendTransaction: vi.fn(async () => TX_HASH),
    waitForTransactionReceipt: vi.fn(async () => ({})),
    signTypedData: vi.fn(async () => SIGNATURE),
  };
}

afterEach(() => {
  mocks.executeOphisSwap.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.OPHIS_REFERRAL_CODE;
});

describe('Ophis AgentKit action provider', () => {
  it('registers one EVM action and forwards referral, slippage, and derived stable-pair state', async () => {
    // AgentKit emits best-effort invocation analytics from its decorator. Keep
    // this adapter suite hermetic and assert only Ophis behavior.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    mocks.executeOphisSwap.mockResolvedValue({
      orderUid: 'uid',
      explorerUrl: 'https://explorer.test/orders/uid',
    });
    const provider = new OphisActionProvider({ referralCode: 'partner_1' });
    const walletProvider = mockProvider();
    const [action] = provider.getActions(walletProvider as unknown as EvmWalletProvider);

    expect(action?.name).toBe('OphisActionProvider_swap');
    expect(provider.supportsNetwork({ protocolFamily: 'evm' } as never)).toBe(true);
    expect(provider.supportsNetwork({ protocolFamily: 'svm' } as never)).toBe(false);

    const response = JSON.parse(
      await action!.invoke({
        sellToken: USDC_OP,
        buyToken: USDT_OP,
        sellAmount: '25',
        slippageBps: null,
      }),
    ) as Record<string, unknown>;

    expect(response).toMatchObject({ success: true, orderUid: 'uid' });
    expect(mocks.executeOphisSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        getChainId: expect.any(Function),
        signTypedData: expect.any(Function),
      }),
      { sellToken: USDC_OP, buyToken: USDT_OP, sellAmount: '25', slippageBps: undefined },
      { referralCode: 'partner_1', isStablePair: true },
    );
  });

  it('returns a structured failure instead of throwing into the agent loop', async () => {
    mocks.executeOphisSwap.mockRejectedValue(new Error('orderbook unavailable'));
    const provider = new OphisActionProvider({ referralCode: 'partner_1' });
    const response = JSON.parse(
      await provider.swap(mockProvider() as unknown as EvmWalletProvider, {
        sellToken: WETH_OP,
        buyToken: USDC_OP,
        sellAmount: '1',
        slippageBps: 50,
      }),
    ) as Record<string, unknown>;

    expect(response).toEqual({ success: false, error: 'Ophis swap failed: orderbook unavailable' });
  });

  it('keeps referral optional while warning the integrator', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new OphisActionProvider()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/No referral code set/));
  });

  it('rejects malformed addresses and unsafe slippage at the framework boundary', () => {
    expect(
      OphisSwapSchema.safeParse({
        sellToken: 'USDC',
        buyToken: USDT_OP,
        sellAmount: '1',
        slippageBps: null,
      }).success,
    ).toBe(false);
    expect(
      OphisSwapSchema.safeParse({
        sellToken: USDC_OP,
        buyToken: USDT_OP,
        sellAmount: '1',
        slippageBps: 5001,
      }).success,
    ).toBe(false);
  });
});

describe('AgentKit wallet adapter', () => {
  it('maps decimals, allowance approval, receipt waiting, and typed-data signing', async () => {
    const provider = mockProvider();
    provider.readContract
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(100n)
      .mockResolvedValueOnce(0n);
    const wallet = toOphisWallet(provider as unknown as EvmWalletProvider);

    expect(wallet.getAddress()).toBe(OWNER);
    expect(wallet.getChainId()).toBe(10);
    await expect(wallet.readErc20Decimals(USDC_OP)).resolves.toBe(6);

    await wallet.ensureErc20Allowance(USDC_OP, SPENDER, 50n);
    expect(provider.sendTransaction).not.toHaveBeenCalled();

    await wallet.ensureErc20Allowance(USDC_OP, SPENDER, 50n);
    expect(provider.sendTransaction).toHaveBeenCalledWith({
      to: USDC_OP,
      data: expect.stringMatching(/^0x/),
    });
    expect(provider.waitForTransactionReceipt).toHaveBeenCalledWith(TX_HASH);

    await expect(
      wallet.signTypedData({ domain: {}, types: {}, primaryType: 'Order', message: {} } as never),
    ).resolves.toBe(SIGNATURE);
  });
});
