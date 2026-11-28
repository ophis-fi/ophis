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
  type SolanaTokenProgram,
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

type WalletRpc = Awaited<ReturnType<typeof matchingRpc>>;

/** Account extensions initialized by SPL Token-2022 for the corresponding mint extensions. */
async function token2022AccountSize(
  rpc: WalletRpc,
  mint: Address,
  minContextSlot: bigint,
  associated: boolean,
): Promise<number> {
  const { context, value } = await rpc
    .getAccountInfo(mint, { commitment: 'confirmed', minContextSlot, encoding: 'jsonParsed' })
    .send();
  const parsed = value && 'parsed' in value.data ? value.data.parsed : undefined;
  const info = parsed?.info;
  if (
    context.slot < minContextSlot ||
    value?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
    parsed?.type !== 'mint' ||
    !info ||
    !('isInitialized' in info) ||
    info.isInitialized !== true
  )
    throw Error('Could not verify the Token-2022 mint size.');
  const entries = 'extensions' in info ? info.extensions : [];
  if (!Array.isArray(entries)) throw Error('Could not read Token-2022 mint extensions.');
  const mintExtensions = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.extension !== 'string' || entry.extension === 'unparseableExtension')
      throw Error('Could not read Token-2022 mint extensions.');
    mintExtensions.add(entry.extension);
  }
  // SPL's get_required_init_account_extensions. ATAs additionally request ImmutableOwner.
  const lengths: number[] = [];
  if (associated || mintExtensions.has('nonTransferable')) lengths.push(0);
  if (mintExtensions.has('nonTransferable')) lengths.push(0);
  if (mintExtensions.has('transferFeeConfig')) lengths.push(8);
  if (mintExtensions.has('transferHook')) lengths.push(1);
  if (mintExtensions.has('pausableConfig')) lengths.push(0);
  // Extended accounts have a one-byte account type and four-byte type/length per extension.
  return getTokenSize() + (lengths.length ? 1 + lengths.reduce((sum, len) => sum + 4 + len, 0) : 0);
}

/** Peak wallet SOL needed, including the wallet minimum and transient storage during execution. */
export async function fetchOphisWalletSwapCosts(
  endpoint: string,
  genesis: string,
  owner: Address,
  buyMint: Address,
  sellFromNativeSol: boolean,
  signatures: 1 | 2,
  solverInput?: {
    solver: Address;
    sellMint: Address;
    sellProgram?: SolanaTokenProgram;
    buyProgram?: SolanaTokenProgram;
  },
) {
  const rpc = await matchingRpc(endpoint, genesis);
  const ata = async (owner: Address, mint: Address, tokenProgram: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
  const nativeBuy = buyMint === SOLANA_NATIVE_ASSET;
  const atomicWrap = sellFromNativeSol && signatures === 2;
  const persistentWrap = sellFromNativeSol && !atomicWrap;
  const accounts: Address[] = [
    address('SysvarRent111111111111111111111111111111111'),
    address('SysvarRecentB1ockHashes11111111111111111111'),
  ];
  const tokenAccounts = async (owner: Address, mint: Address) => [
    mint,
    ...(await Promise.all([
      ata(owner, mint, TOKEN_PROGRAM_ADDRESS),
      ata(owner, mint, TOKEN_2022_PROGRAM_ADDRESS),
    ])),
  ];
  if (!nativeBuy) accounts.push(...(await tokenAccounts(owner, buyMint)));
  const wrapIndex = accounts.length;
  if (persistentWrap) accounts.push(await ata(owner, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ADDRESS));
  const solverIndex = accounts.length;
  const sellMint =
    solverInput?.sellMint === SOLANA_NATIVE_ASSET ? WRAPPED_SOL_MINT : solverInput?.sellMint;
  if (solverInput && sellMint)
    accounts.push(...(await tokenAccounts(solverInput.solver, sellMint)));
  const { value, context } = await rpc
    .getMultipleAccounts(accounts, {
      commitment: 'confirmed',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 48 },
    })
    .send();
  if (value.length !== accounts.length) throw Error('Incomplete Solana order account data.');
  const [rent, hashes] = value;
  const wrappedAccount = persistentWrap ? value[wrapIndex] : null;
  const sysvarOwner = 'Sysvar1111111111111111111111111111111111111';
  if (rent?.owner !== sysvarOwner || hashes?.owner !== sysvarOwner)
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
  if (wrappedAccount && wrappedAccount.owner !== TOKEN_PROGRAM_ADDRESS)
    throw Error('Unexpected Solana token account owner.');
  const missingAccountRent = async (
    mint: Address,
    index: number,
    associated: boolean,
    expectedProgram?: SolanaTokenProgram,
  ) => {
    const program = value[index]?.owner;
    if (
      (program !== TOKEN_PROGRAM_ADDRESS && program !== TOKEN_2022_PROGRAM_ADDRESS) ||
      (expectedProgram !== undefined && program !== expectedProgram)
    )
      throw Error('Could not verify the token mint owner.');
    const account = value[index + (program === TOKEN_PROGRAM_ADDRESS ? 1 : 2)];
    if (account?.owner === program) return 0n;
    // A prefunded system account at the solver's ATA is never a usable token source.
    if (account && (associated || account.owner !== SOLANA_NATIVE_ASSET))
      throw Error('Unexpected Solana token account owner.');
    const size =
      program === TOKEN_PROGRAM_ADDRESS
        ? getTokenSize()
        : await token2022AccountSize(rpc, mint, context.slot, associated);
    return rentPerByte * BigInt(storageOverhead + size);
  };
  const storageOverhead = 128;
  const orderRent = rentPerByte * BigInt(storageOverhead + getOrderAccountSize());
  const classicTokenAccountRent = rentPerByte * BigInt(storageOverhead + getTokenSize());
  const [buyAccountRent, solverInputRent] = await Promise.all([
    nativeBuy ? 0n : missingAccountRent(buyMint, 2, true, solverInput?.buyProgram),
    sellMint ? missingAccountRent(sellMint, solverIndex, false, solverInput?.sellProgram) : 0n,
  ]);
  const tokenAccountRent =
    buyAccountRent + (persistentWrap && !wrappedAccount ? classicTokenAccountRent : 0n);
  const nativeWrapRent = atomicWrap ? classicTokenAccountRent : 0n;
  const networkFee = recent.getBigUint64(40, true) * BigInt(signatures);
  const reserve =
    rentPerByte * BigInt(storageOverhead) +
    orderRent +
    nativeWrapRent +
    solverInputRent +
    tokenAccountRent +
    networkFee;
  if (reserve > 0xffff_ffff_ffff_ffffn) throw Error('Invalid Solana order costs.');
  return {
    orderRent,
    nativeWrapRent,
    solverInputRent,
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
