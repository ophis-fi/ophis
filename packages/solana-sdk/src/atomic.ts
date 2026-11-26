import {
  blockhash,
  decompileTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
  type AddressesByLookupTableAddress,
  type TransactionMessageBytesBase64,
  type V0CompiledTransactionMessage,
} from '@solana/kit';
import { atoms, key, record, request } from './api.js';
import { checkAtomicInstructions, sameBytes } from './atomic-instructions.js';
import { checkedQuoteOrderInput } from './checked-quote-order.js';
import { fetchOphisWalletSwapCosts } from './holdings.js';
import { prepareOphisSolanaOrder } from './index.js';
import { matchingRpc } from './local-rpc.js';

import { TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from './tokens.js';
import { sendWalletBytes } from './wallet.js';

type Rpc = Awaited<ReturnType<typeof matchingRpc>>;
const confirmed = { commitment: 'confirmed' } as const;

async function resolveTables(
  rpc: Rpc,
  message: V0CompiledTransactionMessage,
): Promise<AddressesByLookupTableAddress> {
  const tables = (message.addressTableLookups ?? []).map((lookup) => lookup.lookupTableAddress);
  if (tables.length === 0) return {};
  if (tables.length > 16 || new Set(tables).size !== tables.length)
    throw Error('Invalid swap lookup tables');
  const accounts = await rpc
    .getMultipleAccounts(tables, {
      ...confirmed,
      encoding: 'base64',
      dataSlice: { offset: 0, length: 8248 },
    })
    .send();
  const result: Record<string, Address[]> = {};
  for (const [index, table] of tables.entries()) {
    const account = accounts.value[index];
    if (!account || account.owner !== 'AddressLookupTab1e1111111111111111111111111')
      throw Error('Invalid lookup table owner');
    const raw = getBase64Encoder().encode(account.data[0]);
    if (
      raw.length < 56 ||
      raw.length > 8248 ||
      (raw.length - 56) % 32 !== 0 ||
      !sameBytes(raw.slice(0, 4), Uint8Array.of(1, 0, 0, 0)) ||
      !raw.slice(4, 12).every((byte) => byte === 255)
    )
      throw Error('Invalid lookup table data');
    const keys: Address[] = [];
    for (let offset = 56; offset < raw.length; offset += 32)
      keys.push(getAddressDecoder().decode(raw.slice(offset, offset + 32)));
    result[table] = keys;
  }
  return result;
}

type Review = Parameters<typeof checkedQuoteOrderInput>[0];

export async function prepareOphisWalletAtomicSwap(
  input: Review & { api: string; rpc: string; genesis: string },
) {
  const { quote, programAddress, api, genesis } = input;
  const { solver, routeProgram } = quote;
  const owner = input.owner.address;
  const nativeSell = input.sellFromNativeSol ?? quote.sellFromNativeSol ?? false;
  if (
    quote.executionMode !== 'walletAtomic' ||
    (quote.sellFromNativeSol !== undefined && nativeSell !== quote.sellFromNativeSol) ||
    !solver ||
    !routeProgram ||
    solver === owner ||
    quote.id === null ||
    input.payer ||
    quote.quote.kind !== 'sell' ||
    quote.quote.partiallyFillable ||
    (quote.quote.receiver && quote.quote.receiver !== owner)
  )
    throw Error('Request a fresh wallet-paid swap quote.');
  const [costs, rpc] = await Promise.all([
    fetchOphisWalletSwapCosts(input.rpc, genesis, owner, quote.quote.buyToken, nativeSell, 2),
    matchingRpc(input.rpc, genesis),
  ]);
  const order = await prepareOphisSolanaOrder({
    ...checkedQuoteOrderInput({ ...input, sellFromNativeSol: nativeSell }),
    temporaryNativeRent: nativeSell ? costs.nativeWrapRent : undefined,
  });
  const app = Uint8Array.from(order.intent.appData);
  const fields = new DataView(app.buffer);
  if (
    new TextDecoder().decode(app.subarray(0, 8)) !== 'OPHISPI3' ||
    fields.getBigUint64(8, true) !== BigInt(quote.quote.buyAmount) ||
    fields.getBigUint64(16, true) !== 0n ||
    quote.quote.costs.networkFees !== '0' ||
    quote.quote.costs.buyTokenAtaCosts !== '0' ||
    quote.quote.feeAmount !== '0' ||
    quote.quote.costs.total !== quote.quote.costs.protocolFee
  )
    throw Error('Invalid wallet-paid swap fee terms.');
  const response = await request(api, 'api/v1/market/prepare', {
    quoteId: quote.id,
    owner,
    minimumBuyAmount: String(order.intent.buyAmount),
    appData: quote.quote.appData,
  });
  const packet = record(response);
  if (
    packet.executionMode !== 'walletAtomic' ||
    packet.quoteId !== quote.id ||
    packet.orderUid !== order.uid ||
    packet.solver !== solver ||
    typeof packet.transaction !== 'string' ||
    packet.transaction.length > 1644
  )
    throw Error('Prepared swap does not match the reviewed quote.');
  const lastValidBlockHeight = BigInt(atoms(packet.lastValidBlockHeight, true));
  const hash = blockhash(key(packet.blockhash));
  const bytes = Uint8Array.from(getBase64Encoder().encode(packet.transaction));
  const tx = getTransactionDecoder().decode(bytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const signature = tx.signatures[solver];
  if (
    bytes.length > 1232 ||
    !sameBytes(bytes, getTransactionEncoder().encode(tx)) ||
    compiled.version !== 0 ||
    compiled.lifetimeToken !== hash ||
    compiled.header.numSignerAccounts !== 2 ||
    compiled.header.numReadonlySignerAccounts !== 0 ||
    compiled.staticAccounts[0] !== owner ||
    compiled.staticAccounts[1] !== solver ||
    tx.signatures[owner] !== null ||
    !signature
  )
    throw Error('Unexpected swap payer, solver, or transaction format.');
  const signer = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(getAddressEncoder().encode(solver)),
    'Ed25519',
    false,
    ['verify'],
  );
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      signer,
      Uint8Array.from(signature),
      Uint8Array.from(tx.messageBytes),
    ))
  )
    throw Error('The winning solver signature is invalid.');
  const [tables, fee, tip, walletAccounts] = await Promise.all([
    resolveTables(rpc, compiled),
    rpc
      .getFeeForMessage(
        getBase64Decoder().decode(tx.messageBytes) as TransactionMessageBytesBase64,
        confirmed,
      )
      .send(),
    rpc.getEpochInfo(confirmed).send(),
    Promise.all(
      [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map((programId) =>
        rpc
          .getTokenAccountsByOwner(owner, { programId }, { ...confirmed, encoding: 'jsonParsed' })
          .send(),
      ),
    ),
  ]);
  if (
    tip.blockHeight == null ||
    lastValidBlockHeight <= tip.blockHeight ||
    lastValidBlockHeight > tip.blockHeight + 300n
  )
    throw Error('This swap expired. Get a fresh quote.');
  if (
    fee.value === null ||
    BigInt(atoms(packet.networkFeeLamports, true)) !== fee.value ||
    fee.value !== costs.networkFee ||
    BigInt(atoms(packet.orderRentLamports)) !== costs.orderRent ||
    BigInt(atoms(packet.nativeWrapRentLamports)) !== costs.nativeWrapRent ||
    BigInt(atoms(packet.tokenAccountRentLamports)) !== costs.tokenAccountRent
  )
    throw Error('Wallet network fees or account deposits changed. Get a fresh quote.');
  const message = decompileTransactionMessage(compiled, {
    addressesByLookupTableAddress: tables,
    lastValidBlockHeight,
  });
  const walletTokenAccounts = new Set(
    walletAccounts.flatMap((list) => list.value.map((account) => account.pubkey)),
  );
  await checkAtomicInstructions({
    program: programAddress,
    solver,
    routeProgram,
    order,
    instructions: message.instructions,
    walletTokenAccounts,
    stageRent: costs.classicTokenAccountRent,
    temporaryNativeSource: nativeSell,
    requiredReceiveAta: costs.tokenAccountRent > 0n ? order.intent.buyTokenAccount : undefined,
  });
  return {
    order,
    costs,
    lastValidBlockHeight,
    async send(connection: Parameters<typeof sendWalletBytes>[0]) {
      if (
        connection.account.address !== owner ||
        Date.now() >= Date.parse(quote.expiration) ||
        !(await rpc.isBlockhashValid(hash, confirmed).send()).value
      )
        throw Error('This swap expired or the wallet changed. Get a fresh quote.');
      return sendWalletBytes(connection, bytes.slice());
    },
  };
}
