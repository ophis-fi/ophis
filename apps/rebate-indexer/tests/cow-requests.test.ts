import { describe, it, expect, vi } from 'vitest';
import { readCow } from '../src/cow/requests.js';

const parse = (response: Response) => response.json();

describe('CoW read scheduling', () => {
  it('shares pacing across chain paths while another origin continues', async () => {
    const calls: { name: string; at: number }[] = [];
    const request = (name: string) => async () => {
      calls.push({ name, at: Date.now() });
      return new Response('{}');
    };
    await Promise.all([
      readCow('https://pacing.test/mainnet', request('mainnet'), parse),
      readCow('https://pacing.test/base', request('base'), parse),
      readCow('https://independent.test/', request('other'), parse),
    ]);
    expect(calls.map(c => c.name)).toEqual(['mainnet', 'other', 'base']);
    expect(calls[2]!.at - calls[0]!.at).toBeGreaterThanOrEqual(400);
  });

  it('retries a 429 read after Retry-After', async () => {
    const at: number[] = [];
    const request = vi.fn(async () => {
      at.push(Date.now());
      return at.length === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '0.05' } })
        : new Response('{"ok":true}');
    });
    expect(await readCow('https://retry.test/', request, parse)).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(50);
  });

  it('defers a long rate limit without hammering the next wallet', async () => {
    const request = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(readCow('https://cooldown.test/mainnet', request, parse)).rejects.toThrow('429');
    await expect(readCow('https://cooldown.test/base', request, parse)).rejects.toThrow('429');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued caller without sending its request', async () => {
    let release!: (response: Response) => void;
    const first = readCow('https://cancel.test/first', () => new Promise<Response>(r => { release = r; }), parse);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const controller = new AbortController();
    const request = vi.fn(async () => new Response('{}'));
    const second = readCow('https://cancel.test/second', request, parse, controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow();
    release(new Response('{}'));
    await first;
    expect(request).not.toHaveBeenCalled();
  });

  it('backs off a failed host without blocking another host', async () => {
    const request = vi.fn(async () => new Response('', { status: 530 }));
    await expect(readCow('https://down.test/api/v2/trades', request, parse)).rejects.toThrow('530');
    await expect(readCow('https://down.test/api/v1/orders/id', request, parse)).rejects.toThrow('530');
    await expect(readCow('https://down.test/api/v1/token/healthy/native_price', request, parse)).rejects.toThrow('530');
    expect(request).toHaveBeenCalledTimes(1);
    expect(await readCow('https://healthy.test/', async () => new Response('{}'), parse)).toEqual({});
  });

  it('isolates a chain server error while sharing its host rate limit', async () => {
    await expect(readCow('https://chains.test/avalanche/api/v2/trades', async () => new Response('', { status: 503 }), parse)).rejects.toThrow('503');
    expect(await readCow('https://chains.test/mainnet/api/v2/trades', async () => new Response('{}'), parse)).toEqual({});
    const failed = vi.fn(async () => new Response('{}'));
    await expect(readCow('https://chains.test/avalanche/api/v1/orders/id', failed, parse)).rejects.toThrow('503');
    expect(failed).not.toHaveBeenCalled();
  });

  it.each([500, 503, 'timeout'] as const)('isolates token estimator failure %s from healthy tokens and chain reads', async (status) => {
    const failed = vi.fn(async () => {
      if (status === 'timeout') throw new Error('request timed out');
      return new Response('estimation unavailable', { status });
    });
    const host = `https://prices-${status}.test`;
    const badToken = `${host}/mainnet/api/v1/token/bad/native_price`;
    const error = status === 'timeout' ? 'timed out' : String(status);
    await expect(readCow(badToken, failed, parse)).rejects.toThrow(error);
    expect(await readCow(`${host}/mainnet/api/v1/token/good/native_price`, async () => new Response('{"ok":true}'), parse))
      .toEqual({ ok: true });
    expect(await readCow(`${host}/mainnet/api/v2/trades`, async () => new Response('[]'), parse)).toEqual([]);
    await expect(readCow(badToken, failed, parse)).rejects.toThrow(error);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
