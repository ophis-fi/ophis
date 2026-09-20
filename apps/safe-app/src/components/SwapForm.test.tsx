// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: { sdk: {}, safe: { chainId: 10, safeAddress: '0x1111111111111111111111111111111111111111' }, connected: true },
  getQuote: vi.fn(),
}));
vi.mock('@safe-global/safe-apps-react-sdk', () => ({ useSafeAppsSDK: () => mocks.context }));
vi.mock('../lib/chains', () => ({ isOphisFeeChain: () => true }));
vi.mock('../lib/quote', () => ({ getQuote: mocks.getQuote }));
vi.mock('../lib/appData', () => ({ buildAppData: async () => ({ fullAppData: '{}', appDataHash: '0xhash' }) }));
vi.mock('../lib/order', () => ({ assembleOrder: vi.fn() }));
vi.mock('../lib/submit', () => ({ submitOrder: vi.fn() }));
vi.mock('../lib/referral', () => ({ resolveReferralCode: () => undefined }));
vi.mock('../lib/weth', () => ({ getWethAddress: () => '0x4200000000000000000000000000000000000006' }));
vi.mock('../lib/source', () => ({ isSafeWalletLaunch: () => false }));
vi.mock('./OrderStatus', () => ({ OrderStatus: () => null }));

const { App } = await import('../App');
let root: Root;
let host: HTMLDivElement;
let resolveQuote: (value: unknown) => void;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.context.safe = { chainId: 10, safeAddress: '0x1111111111111111111111111111111111111111' };
  mocks.getQuote.mockReturnValue(new Promise((resolve) => { resolveQuote = resolve; }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('native input setter missing');
  await act(async () => {
    for (const [index, input] of Array.from(host.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')).entries()) {
      setter.call(input, index === 2 ? '1000' : `0x${index + 2}`.padEnd(42, '0'));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('prevents edits while the pending quote captures the displayed trade', async () => {
  await act(async () => host.querySelector('button')?.click());
  expect(mocks.getQuote).toHaveBeenCalled();
  expect(Array.from(host.querySelectorAll('input')).every((input) => input.disabled)).toBe(true);
  await act(async () => resolveQuote({ buyAmount: '2000' }));
  expect(host.textContent).toContain('Review & propose to Safe');
  expect(host.querySelector<HTMLInputElement>('input[placeholder="1000000000000000000"]')?.value).toBe('1000');
});

it.each(['account', 'chain'])('drops the previous %s quote even when its response arrives late', async (change) => {
  await act(async () => host.querySelector('button')?.click());
  mocks.context.safe = change === 'chain'
    ? { ...mocks.context.safe, chainId: 1 }
    : { ...mocks.context.safe, safeAddress: '0x9999999999999999999999999999999999999999' };
  await act(async () => root.render(<App />));
  await act(async () => resolveQuote({ buyAmount: '2000' }));
  expect(host.textContent).not.toContain('Review & propose to Safe');
  expect(host.querySelector<HTMLInputElement>('input[placeholder="1000000000000000000"]')?.value).toBe('');
});
