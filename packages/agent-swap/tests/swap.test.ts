import { describe, it, expect, vi } from 'vitest';
import type { OphisAgentWallet, Address } from '../src/index.js';

// Stub the cow-sdk / app-data modules so importing swap.ts doesn't pull the heavy CoW order stack
// (and its ethers-v5 CJS shim) into Node. These input-guard tests throw BEFORE any of it is used.
vi.mock('@cowprotocol/cow-sdk', () => ({
  OrderBookApi: class {
    async getQuote() {
      return { quote: {} };
    }
    async sendOrder() {
      return 'uid';
    }
  },
  SigningScheme: { EIP712: 'eip712' },
  OrderQuoteSideKindSell: { SELL: 'sell' },
}));
vi.mock('@cowprotocol/app-data', () => ({
  MetadataApi: class {
    async generateAppDataDoc() {
      return {};
    }
  },
  stringifyDeterministic: async () => '{}',
}));

const { executeOphisSwap } = await import('../src/swap.js');

const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

function mockWallet(chainId: number): OphisAgentWallet {
  return {
    getAddress: () => '0x1111111111111111111111111111111111111111',
    getChainId: () => chainId,
    readErc20Decimals: vi.fn(async () => 18),
    ensureErc20Allowance: vi.fn(async () => {}),
    signTypedData: vi.fn(async () => '0xdeadbeef' as Address),
  };
}

const REF = { referralCode: 'ref123' };

describe('executeOphisSwap input guards', () => {
  it('rejects an unsupported chain before any network call', async () => {
    await expect(
      executeOphisSwap(mockWallet(123456789), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/does not operate on chain/i);
  });

  it('requires a referral code (it carries the rebate)', async () => {
    await expect(
      executeOphisSwap(mockWallet(1), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, { referralCode: '' }),
    ).rejects.toThrow(/referral code is required/i);
  });

  it('rejects native ETH as the sell token (ERC-20 only — wrap to WETH)', async () => {
    await expect(
      executeOphisSwap(mockWallet(1), { sellToken: NATIVE, buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/ERC-20 only/i);
  });

  it('rejects native ETH as the buy token', async () => {
    await expect(
      executeOphisSwap(mockWallet(1), { sellToken: WETH, buyToken: NATIVE, sellAmount: '1' }, REF),
    ).rejects.toThrow(/ERC-20 only/i);
  });

  it('rejects a malformed token address', async () => {
    await expect(
      executeOphisSwap(mockWallet(1), { sellToken: '0xnotanaddress', buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/not a valid address/i);
  });

  it('rejects an out-of-range slippage', async () => {
    await expect(
      executeOphisSwap(mockWallet(1), { sellToken: WETH, buyToken: USDC, sellAmount: '1', slippageBps: 20000 }, REF),
    ).rejects.toThrow(/slippageBps out of range/i);
  });
});
