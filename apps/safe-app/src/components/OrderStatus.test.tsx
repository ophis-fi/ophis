// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getOrder: vi.fn() }));
vi.mock('../lib/quote', () => ({ ophisOrderBook: () => ({ getOrder: mocks.getOrder }) }));

const { OrderStatus } = await import('./OrderStatus');
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.getOrder.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderStatus() {
  await act(async () => root.render(
    <OrderStatus chainId={10} orderUid="0xorder" safeTxHash="0xsafetx" />,
  ));
}

it.each(['fulfilled', 'cancelled', 'expired'])('shows %s without stale signing instructions and stops polling', async (status) => {
  mocks.getOrder.mockResolvedValue({ status });
  await renderStatus();
  expect(host.querySelector('h1')?.textContent).toBe(`Order ${status}`);
  expect(host.textContent).not.toContain('Owners must co-sign');
  expect(host.textContent).not.toContain('Order proposed');
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(mocks.getOrder).toHaveBeenCalledTimes(1);
});

it('shows signing instructions only while the order needs a Safe presignature', async () => {
  mocks.getOrder.mockResolvedValue({ status: 'presignaturePending' });
  await renderStatus();
  expect(host.textContent).toContain('Owners must co-sign and execute');
  expect(host.querySelector('h1')?.textContent).toBe('Order proposed');

  mocks.getOrder.mockResolvedValue({ status: 'open' });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.textContent).toContain('The order is open and awaiting settlement');
  expect(host.textContent).not.toContain('Owners must co-sign');
});

it('reports a failed status read and clears the warning after recovery', async () => {
  mocks.getOrder.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ status: 'open' });
  await renderStatus();
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Could not refresh order status');

  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.textContent).toContain('The order is open and awaiting settlement');
});
