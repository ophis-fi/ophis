import type { IAgentRuntime, Memory } from '@elizaos/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { optimism } from 'viem/chains';

const mocks = vi.hoisted(() => ({ executeOphisSwap: vi.fn(), parse: vi.fn(), wallet: {} }));
vi.mock('@ophis/agent-swap', () => ({ executeOphisSwap: mocks.executeOphisSwap }));
vi.mock('@elizaos/core', () => ({
  ModelType: { TEXT_LARGE: 'text' },
  composePromptFromState: () => 'prompt',
  parseKeyValueXml: mocks.parse,
}));
vi.mock('../src/wallet.js', () => ({ buildOphisWallet: () => mocks.wallet }));

import * as chains from '../src/chains.js';
import { ophisSwapAction } from '../src/actions/swap.js';

const SELL = '0x3600000000000000000000000000000000000000';
const BUY = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.executeOphisSwap.mockReset();
  mocks.parse.mockReset();
});

describe('elizaOS configured referral defaults', () => {
  it.each([5042, 10])('forwards the default only for indexed chains (chain %i)', async (chainId) => {
    // Exercise the forwarding boundary without expanding the published resolver.
    expect(chains.resolveChain('arc')).toBeUndefined();
    vi.spyOn(chains, 'resolveChain').mockReturnValue({ id: chainId, chain: optimism, settingKey: 'TEST' });
    mocks.parse.mockReturnValue({ chain: 'test', inputToken: SELL, outputToken: BUY, amount: '1' });
    mocks.executeOphisSwap.mockResolvedValue({ orderUid: 'uid', explorerUrl: 'https://explorer.test/uid' });
    const runtime = {
      composeState: vi.fn(async () => ({ values: {} })),
      useModel: vi.fn(async () => '<intent />'),
      getSetting: (name: string) => name === 'OPHIS_REFERRAL_CODE' ? ' Partner_1 ' : undefined,
    } as unknown as IAgentRuntime;
    const result = await ophisSwapAction.handler(runtime, {
      content: { text: `Swap 1 ${SELL} for ${BUY} on test` },
    } as Memory);
    expect(result).toMatchObject({ success: true });
    const options = mocks.executeOphisSwap.mock.lastCall?.[2];
    if (chainId === 5042) expect(options).not.toHaveProperty('referralCode');
    else expect(options).toHaveProperty('referralCode', 'partner_1');
  });
});
