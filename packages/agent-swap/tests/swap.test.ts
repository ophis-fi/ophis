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

function mockWallet(chainId: number, decimals = 18): OphisAgentWallet {
  return {
    getAddress: () => '0x1111111111111111111111111111111111111111',
    getChainId: () => chainId,
    readErc20Decimals: vi.fn(async () => decimals),
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

  it('allows a missing referral code (warns once instead of throwing; the order still carries the base fee)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Referral is opt-in: an empty/missing code must NOT be a hard error (that hard
    // throw was the top agent-adoption blocker). The call proceeds past the referral
    // check and only rejects later for an unrelated reason (these input-guard mocks
    // return an empty quote), never for a missing referral code.
    await expect(
      executeOphisSwap(mockWallet(1), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, {}),
    ).rejects.not.toThrow(/referral code is required/i);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no referralcode set/i));
    warn.mockRestore();
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

  it('rejects an amount with MORE decimals than the token supports (would otherwise round: 0.5 of a 0-decimal token -> 1)', async () => {
    await expect(
      executeOphisSwap(mockWallet(1, 0), { sellToken: WETH, buyToken: USDC, sellAmount: '0.5' }, REF),
    ).rejects.toThrow(/decimal places/i);
  });

  it('rejects a non-plain-decimal amount (thousands separators / units / sci-notation)', async () => {
    for (const bad of ['1,000', '1_000', '1.5 ETH', '1e3']) {
      await expect(
        executeOphisSwap(mockWallet(1), { sellToken: WETH, buyToken: USDC, sellAmount: bad }, REF),
      ).rejects.toThrow(/plain decimal/i);
    }
  });

  it('accepts trailing zeros that carry no real precision (1.000 on a 0-decimal token is exact)', async () => {
    // Must pass the precision guard (then fails later for an unrelated mocked reason) —
    // it must NOT be rejected for decimal places.
    await expect(
      executeOphisSwap(mockWallet(1, 0), { sellToken: WETH, buyToken: USDC, sellAmount: '1.000' }, REF),
    ).rejects.not.toThrow(/decimal places/i);
  });

  it('rejects a non-integer slippageBps', async () => {
    await expect(
      executeOphisSwap(mockWallet(1), { sellToken: WETH, buyToken: USDC, sellAmount: '1', slippageBps: 50.5 }, REF),
    ).rejects.toThrow(/out of range|non-integer/i);
  });
});
