import { address, lamports, type Address } from '@solana/kit';
import { localWalletRpc, matchingRpc, waitForLocalConfirmation } from './local-rpc.js';
import { readHoldingLabels } from './holding-labels.js';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  SOLANA_NATIVE_ASSET,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from './tokens.js';

export interface OphisWalletHolding {
  mint: Address;
  decimals: number;
  name?: string;
  symbol?: string;
  atoms: bigint;
}

export async function fetchOphisWalletHoldings(
  endpoint: string,
  genesis: string,
  owner: Address,
): Promise<OphisWalletHolding[]> {
  const rpc = await matchingRpc(endpoint, genesis);
  const commitment = 'confirmed';
  const [native, ...accounts] = await Promise.all([
    rpc.getBalance(owner, { commitment }).send(),
    ...[TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map(async (tokenProgram) => {
      const { value } = await rpc
        .getTokenAccountsByOwner(
          owner,
          { programId: tokenProgram },
          { encoding: 'jsonParsed', commitment },
        )
        .send();
      const holdings = await Promise.all(
        value.map(async ({ pubkey, account }): Promise<OphisWalletHolding | null> => {
          if (account.owner !== tokenProgram || !('parsed' in account.data)) return null;
          const { parsed } = account.data;
          if (parsed.type !== 'account') return null;
          const info = parsed.info;
          if (
            info.owner !== owner ||
            info.state !== 'initialized' ||
            info.tokenAmount.amount === '0'
          )
            return null;
          const mint = address(info.mint);
          // Orders debit the associated account. Other accounts with the same mint cannot fund this order.
          const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
          if (ata !== pubkey) return null;
          return {
            mint,
            decimals: Number(info.tokenAmount.decimals),
            atoms: BigInt(info.tokenAmount.amount),
          };
        }),
      );
      return holdings.filter((entry): entry is OphisWalletHolding => entry !== null);
    }),
  ] as const);
  const tokens = accounts.flat();
  const labels = await readHoldingLabels(
    rpc,
    tokens.map((token) => token.mint),
  ).catch(() => undefined);
  return [
    { mint: SOLANA_NATIVE_ASSET, decimals: 9, atoms: native.value },
    ...tokens.map((token) => ({ ...token, ...labels?.get(token.mint) })),
  ];
}

export async function requestOphisLocalTestSol(genesis: string, owner: Address): Promise<void> {
  const rpc = await localWalletRpc(genesis);
  const signature = await rpc
    .requestAirdrop(owner, lamports(100_000_000n), { commitment: 'confirmed' })
    .send();
  await waitForLocalConfirmation(rpc, signature);
}
