import { address, type Address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { matchingRpc } from './local-rpc.js';
import { TOKEN_PROGRAM_ADDRESS, type SolanaTokenProgram } from './tokens.js';
import type { OphisWalletHolding } from './holdings.js';

export async function readAssociatedHoldings(
  rpc: Awaited<ReturnType<typeof matchingRpc>>,
  owner: Address,
  tokenProgram: SolanaTokenProgram,
  includeEmpty: boolean,
): Promise<OphisWalletHolding[]> {
  const { value } = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: tokenProgram },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    )
    .send();
  const holdings = await Promise.all(
    value.map(async ({ pubkey, account }) => {
      if (account.executable || account.owner !== tokenProgram || !('parsed' in account.data))
        return null;
      const { type, info } = account.data.parsed;
      if (type !== 'account' || info.owner !== owner || info.state !== 'initialized') return null;
      if (!includeEmpty && info.tokenAmount.amount === '0') return null;
      const mint = address(info.mint);
      const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
      if (ata !== pubkey) return null;
      return {
        mint,
        decimals: Number(info.tokenAmount.decimals),
        atoms: BigInt(info.tokenAmount.amount),
      };
    }),
  );
  return holdings.filter((holding) => holding !== null);
}

/** Wallet-paid market settlements use the solver's classic SPL input account, even when its balance is zero. */
export async function fetchOphisMarketSellMints(
  endpoint: string,
  genesis: string,
  solver: Address,
): Promise<Address[]> {
  const rpc = await matchingRpc(endpoint, genesis);
  const accounts = await readAssociatedHoldings(rpc, solver, TOKEN_PROGRAM_ADDRESS, true);
  return accounts.map(({ mint }) => mint);
}
