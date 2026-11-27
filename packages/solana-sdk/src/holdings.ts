import { address, lamports, getBase64Encoder, type Address } from '@solana/kit';
import { localWalletRpc, matchingRpc, waitForLocalConfirmation } from './local-rpc.js';
import type { OphisSolanaMintMetadata } from './api.js';
import { readHoldingLabels } from './holding-labels.js';
import { readAssociatedHoldings } from './token-accounts.js';
import { findAssociatedTokenPda, getTokenSize } from '@solana-program/token';
import { getOrderAccountSize } from './settlement/generated/accounts/orderAccount.js';
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
    ...[TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map((tokenProgram) =>
      readAssociatedHoldings(rpc, owner, tokenProgram, false),
    ),
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

/** The order builder pays one signature, keeps the payer rent-exempt, and creates missing ATAs. */
export async function fetchOphisOrderSolReserve(
  endpoint: string,
  genesis: string,
  owner: Address,
  buyMint: Address,
  sellFromNativeSol = true,
): Promise<bigint> {
  return (await fetchOphisWalletSwapCosts(endpoint, genesis, owner, buyMint, sellFromNativeSol, 1))
    .reserve;
}

/** Peak wallet SOL needed, including the wallet minimum and transient storage during execution. */
export async function fetchOphisWalletSwapCosts(
  endpoint: string,
  genesis: string,
  owner: Address,
  buyMint: Address,
  sellFromNativeSol: boolean,
  signatures: 1 | 2,
) {
  const rpc = await matchingRpc(endpoint, genesis);
  const ata = async (mint: Address, tokenProgram: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
  const nativeBuy = buyMint === SOLANA_NATIVE_ASSET;
  const atomicWrap = sellFromNativeSol && signatures === 2;
  const persistentWrap = sellFromNativeSol && !atomicWrap;
  const accounts: Address[] = [
    address('SysvarRent111111111111111111111111111111111'),
    address('SysvarRecentB1ockHashes11111111111111111111'),
  ];
  if (!nativeBuy)
    accounts.push(
      buyMint,
      ...(await Promise.all([
        ata(buyMint, TOKEN_PROGRAM_ADDRESS),
        ata(buyMint, TOKEN_2022_PROGRAM_ADDRESS),
      ])),
    );
  if (persistentWrap) accounts.push(await ata(WRAPPED_SOL_MINT, TOKEN_PROGRAM_ADDRESS));
  const { value } = await rpc
    .getMultipleAccounts(accounts, {
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 48 },
    })
    .send();
  if (value.length !== accounts.length) throw Error('Incomplete Solana order account data.');
  const [rent, hashes, mint, classicAccount, extendedAccount] = value;
  const wrappedAccount = persistentWrap ? value.at(-1) : null;
  const sysvarOwner = 'Sysvar1111111111111111111111111111111111111';
  if (
    rent?.owner !== sysvarOwner ||
    hashes?.owner !== sysvarOwner ||
    (!nativeBuy &&
      mint?.owner !== TOKEN_PROGRAM_ADDRESS &&
      mint?.owner !== TOKEN_2022_PROGRAM_ADDRESS)
  )
    throw Error('Order rent is unavailable.');
  const view = (data: string) => {
    const bytes = getBase64Encoder().encode(data);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const rentData = view(rent.data[0]),
    recent = view(hashes.data[0]);
  if (rentData.byteLength !== 17 || recent.byteLength < 48)
    throw Error('Invalid rent or fee sysvar.');
  const threshold = rentData.getFloat64(8, true);
  if ((threshold !== 1 && threshold !== 2) || !recent.getBigUint64(0, true))
    throw Error('Order rent or fee schedule is unavailable.');
  const rentPerByte = rentData.getBigUint64(0, true) * BigInt(threshold);
  const buyAccount = mint?.owner === TOKEN_PROGRAM_ADDRESS ? classicAccount : extendedAccount;
  if (
    (wrappedAccount && wrappedAccount.owner !== TOKEN_PROGRAM_ADDRESS) ||
    (buyAccount && buyAccount.owner !== mint?.owner)
  )
    throw Error('Unexpected Solana token account owner.');
  if (!buyAccount && mint?.owner === TOKEN_2022_PROGRAM_ADDRESS)
    throw Error('Cannot estimate rent for an unallocated Token-2022 account.');
  const storageOverhead = 128;
  const missing = Number(persistentWrap && !wrappedAccount) + Number(!nativeBuy && !buyAccount);
  const orderRent = rentPerByte * BigInt(storageOverhead + getOrderAccountSize());
  const classicTokenAccountRent = rentPerByte * BigInt(storageOverhead + getTokenSize());
  const tokenAccountRent = BigInt(missing) * classicTokenAccountRent;
  const nativeWrapRent = atomicWrap ? classicTokenAccountRent : 0n;
  const networkFee = recent.getBigUint64(40, true) * BigInt(signatures);
  const reserve =
    rentPerByte * BigInt(storageOverhead) +
    orderRent +
    nativeWrapRent +
    tokenAccountRent +
    networkFee;
  if (reserve > 0xffff_ffff_ffff_ffffn) throw Error('Invalid Solana order costs.');
  return {
    orderRent,
    nativeWrapRent,
    tokenAccountRent,
    classicTokenAccountRent,
    networkFee,
    reserve,
  };
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
