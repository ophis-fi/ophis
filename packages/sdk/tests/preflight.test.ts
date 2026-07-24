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
const stubClient = (results: readonly { status: 'success' | 'failure'; result?: unknown; error?: unknown }[]) => {
  const multicall = vi.fn(async (_args: MulticallArgs) => results);
  return { client: { multicall } as OphisMulticallClient, multicall };
};

const ok = (result: bigint) => ({ status: 'success', result }) as const;
const fail = () => ({ status: 'failure', error: new Error('execution reverted'), result: undefined }) as const;

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
    const [result] = await ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 500n }]);
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

    // One batched call: balanceOf + allowance against the pinned Multicall3.
    expect(multicall).toHaveBeenCalledTimes(1);
    const args = multicall.mock.calls[0]?.[0] as MulticallArgs;
    expect(args.allowFailure).toBe(true);
    expect(args.multicallAddress).toBe(MULTICALL3_ADDRESS);
    expect(args.contracts).toEqual([
      { address: TOKEN, abi: ERC20_PREFLIGHT_ABI, functionName: 'balanceOf', args: [OWNER] },
      { address: TOKEN, abi: ERC20_PREFLIGHT_ABI, functionName: 'allowance', args: [OWNER, OP_RELAYER] },
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
    const [result] = await ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 800n }]);
    expect(result?.ready).toBe(false);
    expect(result?.sufficientBalance).toBe(true);
    expect(result?.sufficientAllowance).toBe(false);
    expect(approvalNeeded(result as OphisPreflightResult)).toBe(500n);
  });

  it('flags an insufficient balance', async () => {
    const { client } = stubClient([ok(100n), ok(10_000n)]);
    const [result] = await ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 800n }]);
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
      await expect(ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }])).rejects.toBeInstanceOf(
        OphisPreflightError,
      );
    });

    it('throws when the result count does not match the request (truncated batch)', async () => {
      const { client } = stubClient([ok(1n)]); // 1 entry for 2 calls
      await expect(ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }])).rejects.toThrow(
        /expected 2/,
      );
    });

    it('throws when entries lack allowFailure statuses (client ignored the contract)', async () => {
      const flat = [1_000n, 500n]; // allowFailure:false shape
      const client: OphisMulticallClient = { multicall: async () => flat };
      await expect(ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }])).rejects.toThrow(
        /allowFailure/,
      );
    });

    it('throws when a successful read decodes to a non-bigint (refuses to coerce)', async () => {
      const { client } = stubClient([{ status: 'success', result: '1000' }, ok(1n)]);
      await expect(ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }])).rejects.toThrow(
        /expected bigint/,
      );
    });

    it('zeroes a failed balance read and can never report ready off it', async () => {
      const { client } = stubClient([fail(), ok(10n ** 30n)]);
      const [result] = await ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]);
      expect(result?.balance).toBe(0n);
      expect(result?.balanceReadFailed).toBe(true);
      expect(result?.sufficientBalance).toBe(false);
      expect(result?.ready).toBe(false);
    });

    it('zeroes a failed allowance read; approvalNeeded then assumes nothing is approved', async () => {
      const { client } = stubClient([ok(10n ** 30n), fail()]);
      const [result] = await ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 700n }]);
      expect(result?.allowance).toBe(0n);
      expect(result?.allowanceReadFailed).toBe(true);
      expect(result?.sufficientAllowance).toBe(false);
      expect(result?.ready).toBe(false);
      expect(approvalNeeded(result as OphisPreflightResult)).toBe(700n);
    });
  });

  describe('input guards', () => {
    it('rejects an empty checks array (a preflight of nothing would read as ready)', async () => {
      const { client } = stubClient([]);
      await expect(ophisPreflight(client, 10, [])).rejects.toThrow(TypeError);
    });

    it('rejects a client without a multicall method', async () => {
      await expect(
        ophisPreflight({} as OphisMulticallClient, 10, [{ token: TOKEN, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(TypeError);
    });

    it('rejects a non-positive or non-bigint required amount', async () => {
      const { client } = stubClient([ok(1n), ok(1n)]);
      await expect(ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 0n }])).rejects.toThrow(
        TypeError,
      );
      await expect(
        ophisPreflight(client, 10, [{ token: TOKEN, owner: OWNER, required: 100 as unknown as bigint }]),
      ).rejects.toThrow(TypeError);
    });

    it('rejects malformed addresses and an invalid chainId', async () => {
      const { client } = stubClient([ok(1n), ok(1n)]);
      await expect(
        ophisPreflight(client, 10, [{ token: '0xnope' as `0x${string}`, owner: OWNER, required: 1n }]),
      ).rejects.toThrow(TypeError);
      await expect(ophisPreflight(client, 0, [{ token: TOKEN, owner: OWNER, required: 1n }])).rejects.toThrow(
        TypeError,
      );
    });

    it('rejects an unsupported chain when the default spender cannot be resolved', async () => {
      const { client } = stubClient([ok(1n), ok(1n)]);
      await expect(ophisPreflight(client, 424242, [{ token: TOKEN, owner: OWNER, required: 1n }])).rejects.toThrow(
        /vault relayer/,
      );
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
