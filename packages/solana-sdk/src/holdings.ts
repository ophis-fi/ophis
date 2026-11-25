import { address, lamports, getBase64Encoder, type Address } from '@solana/kit';
import { localWalletRpc, matchingRpc, waitForLocalConfirmation } from './local-rpc.js';
import type { OphisSolanaMintMetadata } from './api.js';
import { readHoldingLabels } from './holding-labels.js';
import { findAssociatedTokenPda } from '@solana-program/token';
import {
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
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

export async function verifyOphisMintMetadata(
  endpoint: string,
  genesis: string,
  metadata: OphisSolanaMintMetadata[],
) {
  const mints = metadata.filter((info) => info.address !== SOLANA_NATIVE_ASSET);
  if (!mints.length) return;
  const rpc = await matchingRpc(endpoint, genesis);
  const { value } = await rpc
    .getMultipleAccounts(
      mints.map((info) => info.address),
      {
        encoding: 'base64',
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 82 },
      },
    )
    .send();
  for (const [index, mint] of mints.entries()) {
    const account = value[index];
    const bytes = account && getBase64Encoder().encode(account.data[0]);
    if (
      !account ||
      account.owner !== mint.tokenProgram ||
      !bytes ||
      bytes.length < 82 ||
      bytes[45] !== 1 ||
      bytes[44] !== mint.decimals
    )
      throw Error('Mint decimals or token program disagree with Solana.');
  }
}

/** SPL grants one delegate allowance per token account, shared across open orders. */
export async function readOphisSellAllowance(
  endpoint: string,
  genesis: string,
  owner: Address,
  sell: OphisSolanaMintMetadata,
): Promise<{ delegate: Address; atoms: bigint } | null> {
  const mint = sell.address === SOLANA_NATIVE_ASSET ? WRAPPED_SOL_MINT : sell.address;
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: sell.tokenProgram });
  const rpc = await matchingRpc(endpoint, genesis);
  const { value } = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: sell.tokenProgram },
      {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
      },
    )
    .send();
  const source = value.find((entry) => entry.pubkey === ata);
  if (!source) return null;
  const data = source.account.data;
  if (
    source.account.owner !== sell.tokenProgram ||
    !('parsed' in data) ||
    data.parsed.type !== 'account' ||
    data.parsed.info.owner !== owner ||
    data.parsed.info.mint !== mint
  )
    throw Error('Could not verify the sell token account.');
  const { delegate, delegatedAmount } = data.parsed.info;
  if (!delegate) return null;
  if (!delegatedAmount || !/^\d+$/.test(delegatedAmount.amount))
    throw Error('Invalid token spending allowance.');
  const atoms = BigInt(delegatedAmount.amount);
  return atoms > 0n ? { delegate: address(delegate), atoms } : null;
}
