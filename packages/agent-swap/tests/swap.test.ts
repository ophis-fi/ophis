import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OphisAgentWallet, Address } from '../src/index.js';

// A mutable quote the mocked orderbook returns. Defaults to {} so the input-guard tests keep
// throwing at order-build (unchanged); the binding-guard tests set a concrete quote to drive
// past the build and exercise the request<->quote binding checks.
const hoisted = vi.hoisted(() => ({ quote: {} as Record<string, unknown> }));

// Stub the cow-sdk / app-data modules so importing swap.ts doesn't pull the heavy CoW order stack
// (and its ethers-v5 CJS shim) into Node. These input-guard tests throw BEFORE any of it is used.
vi.mock('@cowprotocol/cow-sdk', () => ({
  OrderBookApi: class {
    async getQuote() {
      return { quote: hoisted.quote };
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
// Mock @ophis/sdk so the binding tests, which proceed past the input guards, never touch the live
// rebate indexer (enrollOphisTrader) or any real network — keeps the suite deterministic in CI.
vi.mock('@ophis/sdk', () => ({
  isOphisFeeChain: (id: number) => id === 1,
  enrollOphisTrader: async () => {},
  buildOphisOrderMetadata: () => ({}),
  getOphisOrderbookUrl: () => 'https://orderbook.test',
  getOphisVaultRelayer: () => '0x2222222222222222222222222222222222222222',
  getOphisOrderDomain: () => ({
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId: 1,
    verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  }),
  ophisOrderReceiver: (owner: string) => owner,
  assertReceiverIsOwner: () => {},
  buildOphisOrderCreation: (x: unknown) => x,
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

describe('executeOphisSwap quote<->request binding (defense against a malicious/compromised quote)', () => {
  afterEach(() => {
    hoisted.quote = {};
  });

  // 1 WETH (18 decimals) => atomic 1e18. An honest sell quote has sellAmount + feeAmount === 1e18.
  const honest = {
    sellToken: WETH,
    buyToken: USDC,
    sellAmount: '995000000000000000',
    feeAmount: '5000000000000000',
    buyAmount: '3000000000',
    validTo: 4_000_000_000,
  };

  it('refuses to sign when the quote substitutes the sell token', async () => {
    hoisted.quote = { ...honest, sellToken: USDC }; // != requested WETH
    await expect(
      executeOphisSwap(mockWallet(1, 18), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/sellToken.*refusing to sign/i);
  });

  it('refuses to sign when the quote substitutes the buy token', async () => {
    hoisted.quote = { ...honest, buyToken: WETH }; // != requested USDC
    await expect(
      executeOphisSwap(mockWallet(1, 18), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/buyToken.*refusing to sign/i);
  });

  it('refuses to sign when the gross (sellAmount + feeAmount) exceeds the requested amount', async () => {
    // Honest sum is 1e18; inflate the fee by 1 wei so the wallet would approve/sign more than asked.
    hoisted.quote = { ...honest, sellAmount: '1000000000000000000', feeAmount: '1' };
    await expect(
      executeOphisSwap(mockWallet(1, 18), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/!= requested.*refusing to sign/i);
  });

  it('refuses to sign when the gross is LESS than requested (under-pull: sells less than asked)', async () => {
    hoisted.quote = { ...honest, sellAmount: '900000000000000000', feeAmount: '5000000000000000' }; // 0.905e18 < 1e18
    await expect(
      executeOphisSwap(mockWallet(1, 18), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/!= requested.*refusing to sign/i);
  });

  it('refuses to sign a zero-proceeds order (tiny buyAmount rounds the buy floor to 0)', async () => {
    // buyAmount 1 with the default 50bps slippage floors minBuyAmount to 0 => sell everything for ~nothing.
    hoisted.quote = { ...honest, buyAmount: '1' };
    await expect(
      executeOphisSwap(mockWallet(1, 18), { sellToken: WETH, buyToken: USDC, sellAmount: '1' }, REF),
    ).rejects.toThrow(/zero-proceeds|buy floor/i);
  });

  it('does not reject an honest quote for a binding reason', async () => {
    hoisted.quote = { ...honest };
    // May still reject downstream for an unrelated mocked reason; it must NOT be the binding error.
    const err = await executeOphisSwap(
      mockWallet(1, 18),
      { sellToken: WETH, buyToken: USDC, sellAmount: '1' },
      REF,
    ).then(
      () => null,
      (e: Error) => e,
    );
    if (err) expect(err.message).not.toMatch(/refusing to sign/i);
  });
});
