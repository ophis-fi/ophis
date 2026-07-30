import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, http } from 'viem';
import {
  MULTICALL3_ADDRESS,
  ERC20_PREFLIGHT_ABI,
  ophisPreflight,
  isPreflightReady,
  approvalNeeded,
  OphisPreflightError,
  type OphisMulticallClient,
  type OphisPreflightResult,
} from '../src/preflight.js';
import { OPHIS_VAULT_RELAYER_ADDRESSES } from '../src/domain.js';

const TOKEN = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' as const; // USDC on OP
const TOKEN_2 = '0x4200000000000000000000000000000000000006' as const; // WETH on OP
const OWNER = '0x6D46e28aB34622d9A39d0F306a37a8dC270951aF' as const;
const OP_RELAYER = OPHIS_VAULT_RELAYER_ADDRESSES[10] as `0x${string}`;
const CUSTOM_SPENDER = '0x1111111111111111111111111111111111111111' as const;

type MulticallArgs = Parameters<OphisMulticallClient['multicall']>[0];

/** Stub client returning viem-shaped allowFailure entries. */
const stubClient = (
  results: readonly { status: 'success' | 'failure'; result?: unknown; error?: unknown }[],
) => {
  const multicall = vi.fn(async (_args: MulticallArgs) => results);
  return { client: { multicall } as OphisMulticallClient, multicall };
};

const ok = (result: bigint) => ({ status: 'success', result }) as const;
const fail = () =>
  ({ status: 'failure', error: new Error('execution reverted'), result: undefined }) as const;

describe('OphisMulticallClient structural typing', () => {
  it('is satisfied by a real viem PublicClient with no cast (decision 13)', () => {
    // Compile-time assertion: `pnpm typecheck` fails if viem's PublicClient
    // stops satisfying the structural interface. No request is ever sent.
    const publicClient = createPublicClient({ transport: http('https://localhost:1') });
    const structural: OphisMulticallClient = publicClient;
    expect(typeof structural.multicall).toBe('function');
  });
});

describe('ophisPreflight', () => {
  it('reports ready when balance and allowance both cover required', async () => {
    const { client, multicall } = stubClient([ok(1_000n), ok(500n)]);
    const [result] = await ophisPreflight(client, 10, [
      { token: TOKEN, owner: OWNER, required: 500n },
    ]);
    expect(result).toMatchObject({
      token: TOKEN,
      owner: OWNER,
      spender: OP_RELAYER,
      required: 500n,
      balance: 1_000n,
      allowance: 500n,
      balanceReadFailed: false,
      allowanceReadFailed: false,
      sufficientBalance: true,
      sufficientAllowance: true,
      ready: true,
    });
    expect(isPreflightReady(result as OphisPreflightResult)).toBe(true);
    expect(approvalNeeded(result as OphisPreflightResult)).toBe(0n);

    // One batched call: balanceOf + allowance against the pinned Multicall3,
    // with chunking disabled (batchSize: 0) so the whole batch is a single
    // eth_call and every read comes from the same block snapshot.
    expect(multicall).toHaveBeenCalledTimes(1);
    const args = multicall.mock.calls[0]?.[0] as MulticallArgs;
    expect(args.allowFailure).toBe(true);
    expect(args.batchSize).toBe(0);
    expect(args.multicallAddress).toBe(MULTICALL3_ADDRESS);
    expect(args.contracts).toEqual([
      { address: TOKEN, abi: ERC20_PREFLIGHT_ABI, functionName: 'balanceOf', args: [OWNER] },
      {
        address: TOKEN,
        abi: ERC20_PREFLIGHT_ABI,
        functionName: 'allowance',
        args: [OWNER, OP_RELAYER],
      },
    ]);
  });

  it('defaults the spender to the chain vault relayer (the correct approve target), not the settlement', () => {
    // Pin the OP relayer literal: silently defaulting to a wrong spender would
    // make every preflight lie about approvals.
    expect(OP_RELAYER).toBe('0x83847EaB41ad9ea43809ce71569eB2e9daF51830');
  });

  it('honors an explicit spender override', async () => {
    const { client, multicall } = stubClient([ok(10n), ok(10n)]);
    const [result] = await ophisPreflight(client, 10, [
      { token: TOKEN, owner: OWNER, required: 10n, spender: CUSTOM_SPENDER },
    ]);
    expect(result?.spender).toBe(CUSTOM_SPENDER);
    const args = multicall.mock.calls[0]?.[0] as MulticallArgs;
    expect(args.contracts[1]?.args).toEqual([OWNER, CUSTOM_SPENDER]);
  });

  it('flags approval_needed when the allowance is short but the balance covers', async () => {
    const { client } = stubClient([ok(1_000n), ok(300n)]);
    const [result] = await ophisPreflight(client, 10, [
      { token: TOKEN, owner: OWNER, required: 800n },
    ]);
    expect(result?.ready).toBe(false);
    expect(result?.sufficientBalance).toBe(true);
    expect(result?.sufficientAllowance).toBe(false);
    expect(approvalNeeded(result as OphisPreflightResult)).toBe(500n);
  });

  it('flags an insufficient balance', async () => {
    const { client } = stubClient([ok(100n), ok(10_000n)]);
    const [result] = await ophisPreflight(client, 10, [
      { token: TOKEN, owner: OWNER, required: 800n },
    ]);
    expect(result?.ready).toBe(false);
    expect(result?.sufficientBalance).toBe(false);
    expect(result?.sufficientAllowance).toBe(true);
    expect(approvalNeeded(result as OphisPreflightResult)).toBe(0n);
  });

  it('batches multiple checks in one multicall, two reads per check, in order', async () => {
    const { client, multicall } = stubClient([ok(1n), ok(1n), ok(2n), ok(0n)]);
    const results = await ophisPreflight(client, 10, [
      { token: TOKEN, owner: OWNER, required: 1n },
      { token: TOKEN_2, owner: OWNER, required: 2n },
    ]);
    expect(multicall).toHaveBeenCalledTimes(1);
    const args = multicall.mock.calls[0]?.[0] as MulticallArgs;
    expect(args.contracts).toHaveLength(4);
    expect(results.map((r) => r.ready)).toEqual([true, false]);
    expect(isPreflightReady(results)).toBe(false);
  });

  describe('RPC failure paths (a failed multicall must throw, never report ready)', () => {
    it('throws OphisPreflightError when the multicall itself rejects', async () => {
      const rpcFailure = new Error('HTTP 503 from RPC');
      const client: OphisMulticallClient = {
        multicall: async () => {
          throw rpcFailure;
        },
      };
      const promise = ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toMatchObject({ cause: rpcFailure });
    });

    it('throws when the client returns a non-array', async () => {
      const { client } = stubClient([]);
      (client as { multicall: unknown }).multicall = async () => 'nonsense';
      await expect(
        ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toBeInstanceOf(OphisPreflightError);
    });

    it('throws when the result count does not match the request (truncated batch)', async () => {
      const { client } = stubClient([ok(1n)]); // 1 entry for 2 calls
      await expect(
        ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(/expected 2/);
    });

    it('throws when entries lack allowFailure statuses (client ignored the contract)', async () => {
      const flat = [1_000n, 500n]; // allowFailure:false shape
      const client: OphisMulticallClient = { multicall: async () => flat };
      await expect(
        ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(/allowFailure/);
    });

    it('hits the typed diagnostic on a sparse result array (holes are not entries)', async () => {
      const sparse = new Array<unknown>(2); // right length, but holes instead of entries
      const client: OphisMulticallClient = { multicall: async () => sparse };
      const promise = ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toThrow(/allowFailure/);
    });

    it('throws when a successful read decodes to a non-bigint (refuses to coerce)', async () => {
      const { client } = stubClient([{ status: 'success', result: '1000' }, ok(1n)]);
      await expect(
        ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(/expected bigint/);
    });

    it('throws on a total outage: every entry failure (viem swallows the rejected aggregate call)', async () => {
      // With allowFailure: true, viem does NOT reject when the aggregate
      // eth_call fails; it returns one failure entry per contract. Answering
      // that shape would zero every balance and show "insufficient funds"
      // during an RPC outage.
      const transportError = Object.assign(new Error('HTTP request failed'), {
        name: 'HttpRequestError',
      });
      const { client } = stubClient([
        { status: 'failure', error: transportError, result: undefined },
        { status: 'failure', error: transportError, result: undefined },
        { status: 'failure', error: transportError, result: undefined },
        { status: 'failure', error: transportError, result: undefined },
      ]);
      const promise = ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 1n },
        { token: TOKEN_2, owner: OWNER, required: 1n },
      ]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toThrow(/every call in the preflight batch failed/);
      // The underlying errors ride along for support, names as diagnostic only.
      await expect(promise).rejects.toThrow(/HttpRequestError/);
      const caught = await promise.catch((error: unknown) => error);
      expect((caught as OphisPreflightError).cause).toBeInstanceOf(AggregateError);
      expect(((caught as OphisPreflightError).cause as AggregateError).errors).toContain(
        transportError,
      );
    });

    // ---- regression: aligned-chunk transport death (review finding, 2026-07-25) ----
    // A chunk that aligns to COMPLETE (balanceOf, allowance) pairs defeats the
    // pair-consistency rule: both halves of each pair fail together, and that
    // rule only fires on a HALF-failed pair. If another chunk succeeds, the
    // all-failure rule does not fire either. In that window the transport-name
    // list is the ONLY remaining gate, so a transport error missing from it is
    // answered as zero balances -- the exact fail-open this module prevents.
    // viem 2.48.8 hands a BARE SocketClosedError to in-flight requests at
    // utils/rpc/socket.js:54 (the webSocket.js path wraps it in
    // WebSocketRequestError and was already covered).
    it('throws when an aligned chunk dies on a bare SocketClosedError while another chunk succeeds', async () => {
      const socketClosed = Object.assign(new Error('The socket has been closed.'), {
        name: 'SocketClosedError',
      });
      const { client } = stubClient([
        { status: 'failure', error: socketClosed, result: undefined },
        { status: 'failure', error: socketClosed, result: undefined },
        ok(1_000n),
        ok(1_000n),
      ]);
      const promise = ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 1n },
        { token: TOKEN_2, owner: OWNER, required: 1n },
      ]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toThrow(/SocketClosedError/);
    });

    it('throws on a bare ProviderDisconnectedError in an aligned chunk (EIP-1193 4900)', async () => {
      const disconnected = Object.assign(new Error('provider disconnected'), {
        name: 'ProviderDisconnectedError',
      });
      const { client } = stubClient([
        { status: 'failure', error: disconnected, result: undefined },
        { status: 'failure', error: disconnected, result: undefined },
        ok(1_000n),
        ok(1_000n),
      ]);
      await expect(
        ophisPreflight(client, 10, [
          { token: TOKEN, owner: OWNER, required: 1n },
          { token: TOKEN_2, owner: OWNER, required: 1n },
        ]),
      ).rejects.toThrow(/ProviderDisconnectedError/);
    });

    it('still zeroes an aligned chunk that failed with a genuine revert (widening must not swallow real reverts)', async () => {
      const { client } = stubClient([fail(), fail(), ok(1_000n), ok(1_000n)]);
      const results = await ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 1n },
        { token: TOKEN_2, owner: OWNER, required: 1n },
      ]);
      expect(results[0]?.balance).toBe(0n);
      expect(results[0]?.allowance).toBe(0n);
      expect(results[1]?.balance).toBe(1_000n);
    });

    it('throws on a single check whose both reads failed (deliberate: an all-failure batch, not a not-ready)', async () => {
      // Behavior change vs 0.3.0-rc: one check with balanceOf AND allowance
      // both failing IS the all-failure shape and is indistinguishable from
      // an outage, so it throws instead of reporting not-ready.
      const { client } = stubClient([fail(), fail()]);
      await expect(
        ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(/every call in the preflight batch failed/);
    });

    it('still throws on an all-failure batch when entries carry no error field (message stays typed)', async () => {
      const { client } = stubClient([
        { status: 'failure', result: undefined },
        { status: 'failure', result: undefined },
      ]);
      const promise = ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      const caught = await promise.catch((error: unknown) => error);
      expect((caught as OphisPreflightError).cause).toBeUndefined();
    });

    it('keeps per-token zeroing for PARTIAL failures: mixed batch zeroes the failed token and pins ready false', async () => {
      const { client } = stubClient([ok(1_000n), ok(1_000n), fail(), fail()]);
      const results = await ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 500n },
        { token: TOKEN_2, owner: OWNER, required: 500n },
      ]);
      expect(results[0]?.ready).toBe(true);
      expect(results[1]).toMatchObject({
        ready: false,
        balance: 0n,
        allowance: 0n,
        balanceReadFailed: true,
        allowanceReadFailed: true,
        sufficientBalance: false,
        sufficientAllowance: false,
      });
      expect(isPreflightReady(results)).toBe(false);
    });

    it('throws on a half-failed pair: balanceOf failed while allowance answered (unexplainable as a token revert)', async () => {
      // A genuine non-ERC20 or reverting token fails BOTH calls of its pair.
      // Exactly one failing is only explainable by a chunk split or partial
      // transport failure, so zeroing it would be answering a batch that was
      // not one snapshot.
      const { client } = stubClient([fail(), ok(10n ** 30n)]);
      const promise = ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toThrow(/inconsistent read pair/);
      await expect(promise).rejects.toThrow(TOKEN);
      // Both entry states are named for support.
      await expect(promise).rejects.toThrow(/balanceOf failed \(Error\) while allowance succeeded/);
    });

    it('throws on the other half-pair orientation: allowance failed while balanceOf answered', async () => {
      const { client } = stubClient([ok(10n ** 30n), fail()]);
      const promise = ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 700n }]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toThrow(/balanceOf succeeded while allowance failed/);
    });

    it('throws on a transport-shaped failure in a mixed batch, even though the whole pair failed', async () => {
      // A chunk that dies on transport stamps its rejection reason on every
      // call of that chunk (viem 2.48.8): the pair fails together, slipping
      // past the pair rule, but the chain never answered those reads.
      const transport = Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
      const { client } = stubClient([
        ok(1_000n),
        ok(1_000n),
        { status: 'failure', error: transport, result: undefined },
        { status: 'failure', error: transport, result: undefined },
      ]);
      const promise = ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 500n },
        { token: TOKEN_2, owner: OWNER, required: 500n },
      ]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toThrow(/transport-shaped error HttpRequestError/);
      await expect(promise).rejects.toThrow(TOKEN_2);
    });

    it('finds the transport shape down the cause chain (viem nests it under ContractFunctionExecutionError)', async () => {
      const nested = Object.assign(new Error('multicall failed'), {
        name: 'ContractFunctionExecutionError',
        cause: Object.assign(new Error('took too long'), { name: 'TimeoutError' }),
      });
      const { client } = stubClient([
        ok(1_000n),
        ok(1_000n),
        { status: 'failure', error: nested, result: undefined },
        { status: 'failure', error: nested, result: undefined },
      ]);
      const promise = ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 500n },
        { token: TOKEN_2, owner: OWNER, required: 500n },
      ]);
      await expect(promise).rejects.toThrow(/transport-shaped error TimeoutError/);
    });

    it('keeps zeroing a full-pair revert-shaped failure (the transport list is widening-only, not load-bearing)', async () => {
      // Plain revert-shaped errors on BOTH calls of the pair stay the
      // documented not-ready path; approvalNeeded then assumes nothing is
      // approved.
      const { client } = stubClient([ok(1_000n), ok(1_000n), fail(), fail()]);
      const results = await ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 500n },
        { token: TOKEN_2, owner: OWNER, required: 700n },
      ]);
      expect(results[1]?.ready).toBe(false);
      expect(results[1]?.balanceReadFailed).toBe(true);
      expect(results[1]?.allowanceReadFailed).toBe(true);
      expect(approvalNeeded(results[1] as OphisPreflightResult)).toBe(700n);
    });
  });

  describe('connected-chain guard (wrong-chain reads are fail-open and must throw)', () => {
    it('throws OphisPreflightError when the connected chain does not match chainId, without multicalling', async () => {
      // The concrete trap: a Base-connected client asked about Ink (57073).
      // Both chains resolve the canonical vault relayer and OP-stack WETH
      // shares 0x4200...0006, so the read would decode cleanly and report a
      // ready the user cannot fund on the chain the order targets.
      const multicall = vi.fn(async () => [ok(10n ** 30n), ok(10n ** 30n)]);
      const client: OphisMulticallClient = { multicall, getChainId: async () => 8453 };
      const promise = ophisPreflight(client, 57073, [
        { token: TOKEN_2, owner: OWNER, required: 1n },
      ]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toThrow(/chain mismatch/);
      expect(multicall).not.toHaveBeenCalled();
    });

    it('proceeds when the connected chain matches chainId', async () => {
      const { client } = stubClient([ok(10n), ok(10n)]);
      (client as { getChainId?: () => Promise<number> }).getChainId = async () => 10;
      const [result] = await ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 10n },
      ]);
      expect(result?.ready).toBe(true);
    });

    it('throws OphisPreflightError with the cause when getChainId itself fails', async () => {
      const probeFailure = new Error('RPC unreachable');
      const client: OphisMulticallClient = {
        multicall: async () => [ok(1n), ok(1n)],
        getChainId: async () => {
          throw probeFailure;
        },
      };
      const promise = ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]);
      await expect(promise).rejects.toBeInstanceOf(OphisPreflightError);
      await expect(promise).rejects.toMatchObject({ cause: probeFailure });
    });

    it('proceeds unchecked when the client has no getChainId (chainId argument is trusted)', async () => {
      // Documented degradation for minimal clients: without a probe there is
      // nothing to verify against; the multicall path still applies.
      const { client } = stubClient([ok(10n), ok(10n)]);
      expect((client as { getChainId?: unknown }).getChainId).toBeUndefined();
      const [result] = await ophisPreflight(client, 10, [
        { token: TOKEN, owner: OWNER, required: 10n },
      ]);
      expect(result?.ready).toBe(true);
    });
  });

  describe('input guards', () => {
    it('rejects an empty checks array (a preflight of nothing would read as ready)', async () => {
      const { client } = stubClient([]);
      await expect(ophisPreflight(client, 10, [])).rejects.toThrow(TypeError);
    });

    it('rejects a client without a multicall method', async () => {
      await expect(
        ophisPreflight({} as OphisMulticallClient, 10, [
          { token: TOKEN, owner: OWNER, required: 1n },
        ]),
      ).rejects.toThrow(TypeError);
    });

    it('rejects a non-positive or non-bigint required amount', async () => {
      const { client } = stubClient([ok(1n), ok(1n)]);
      await expect(
        ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 0n }]),
      ).rejects.toThrow(TypeError);
      await expect(
        ophisPreflight(client, 10, [
          { token: TOKEN, owner: OWNER, required: 100 as unknown as bigint },
        ]),
      ).rejects.toThrow(TypeError);
    });

    it('rejects malformed addresses and an invalid chainId', async () => {
      const { client } = stubClient([ok(1n), ok(1n)]);
      await expect(
        ophisPreflight(client, 10, [
          { token: '0xnope' as `0x${string}`, owner: OWNER, required: 1n },
        ]),
      ).rejects.toThrow(TypeError);
      await expect(
        ophisPreflight(client, 0, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(TypeError);
    });

    it('rejects an unsupported chain when the default spender cannot be resolved', async () => {
      const { client } = stubClient([ok(1n), ok(1n)]);
      await expect(
        ophisPreflight(client, 424242, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(/vault relayer/);
    });
  });
});

describe('isPreflightReady', () => {
  const readyResult = { ready: true } as OphisPreflightResult;
  const notReadyResult = { ready: false } as OphisPreflightResult;

  it('is true only when every check in a batch is ready', () => {
    expect(isPreflightReady([readyResult, readyResult])).toBe(true);
    expect(isPreflightReady([readyResult, notReadyResult])).toBe(false);
  });

  it('accepts a single result', () => {
    expect(isPreflightReady(readyResult)).toBe(true);
    expect(isPreflightReady(notReadyResult)).toBe(false);
  });

  it('an empty batch is NOT ready (nothing was verified)', () => {
    expect(isPreflightReady([])).toBe(false);
  });
});
