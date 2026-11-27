import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createAddressWithSeed,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getCreateAccountWithSeedInstruction } from '@solana-program/system';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getInitializeAccount3Instruction,
} from '@solana-program/token';
import { checkedQuoteOrderInput } from '../dist/checked-quote-order.js';
import { findNativeSolBufferPda } from '../dist/settlement/generated/pdas/nativeSolBuffer.js';
import {
  fetchOphisSolanaQuote,
  getOphisNativeSellFeeCap,
  prepareOphisSolanaOrderFromQuote,
  prepareOphisSolanaOrder,
  prepareOphisWalletAtomicSwap,
  SOLANA_NATIVE_ASSET,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  WRAPPED_SOL_MINT,
} from '../dist/index.js';

const program = 'BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h';
const mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const routeProgram = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const ixSysvar = 'Sysvar1nstructions1111111111111111111111111';
const genesis = '6xBWwnJVYS5MkXhAYGDCDzoApx1hnCKxg89b1Q3Tnwqg';
const endpoint = 'http://127.0.0.1:18899';
const networkFee = 10000n;
function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { address: getAddressDecoder().decode(bytes), bytes, privateKey };
}

async function fixture(
  change,
  useTable = false,
  nativeSale = false,
  createReceiver = false,
  newSolverInput = false,
  {
    sellProgram = TOKEN_PROGRAM_ADDRESS,
    buyProgram = TOKEN_PROGRAM_ADDRESS,
    newBuyMint = false,
    compact = true,
  } = {},
) {
  const user = keypair(),
    solverKey = keypair(),
    solver = createNoopSigner(solverKey.address);
  const app = Buffer.alloc(32);
  app.write('OPHISPI5');
  app.writeBigUInt64LE(10000n, 8);
  app.writeBigUInt64LE(100n, 24);
  const sellMint = nativeSale ? WRAPPED_SOL_MINT : newSolverInput ? keypair().address : mint;
  const buyMint = newBuyMint ? keypair().address : nativeSale ? mint : SOLANA_NATIVE_ASSET;
  const nativeBuy = buyMint === SOLANA_NATIVE_ASSET;
  const baseBps = newBuyMint || (newSolverInput && !nativeSale) ? 5 : 1;
  const rate = nativeSale ? 3000n : nativeBuy ? 10000n : 58420n;
  const max = ((BigInt(baseBps) + ((10000n - BigInt(baseBps)) * 99n) / 10000n) * rate) / 10000n;
  const nativeProtocolFee = {
    rateBuyAtoms: '10000',
    rateLamports: String(rate),
    estimatedLamports: String((BigInt(baseBps) * rate) / 10000n),
    maxLamports: String(max),
  };
  app.writeBigUInt64LE(max, 16);
  const quote = {
    verified: true,
    id: 1,
    executionMode: 'walletAtomic',
    from: user.address,
    solver: solver.address,
    routeProgram,
    funder: null,
    expiration: new Date(Date.now() + 90_000).toISOString(),
    quote: {
      sellToken: sellMint,
      buyToken: buyMint,
      receiver: null,
      sellAmount: '3000',
      buyAmount: '10000',
      feeAmount: '0',
      costs: {
        token: buyMint,
        networkFees: '0',
        buyTokenAtaCosts: '0',
        protocolFee: '0',
        total: '0',
      },
      nativeProtocolFee,
      feeTerms: { baseBps, improvementShareBps: 5000, improvementCapBps: 99 },
      appData: '0x' + app.toString('hex'),
      validTo: Math.floor(Date.now() / 1000) + 120,
      kind: 'sell',
      partiallyFillable: false,
    },
  };
  const input = {
    rpc: endpoint,
    api: endpoint,
    genesis,
    programAddress: program,
    owner: createNoopSigner(user.address),
    quote,
    sellProgram,
    slippageBps: 50,
    sellFromNativeSol: nativeSale,
    ...(!nativeBuy && { buyProgram }),
  };
  const order = await prepareOphisSolanaOrder({
    ...checkedQuoteOrderInput(input),
    ...(nativeSale && { temporaryNativeRent: 1488440n }),
  });
  const walletPrefix = order.instructions.filter(
    (ix) =>
      ix.programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS ||
      (createReceiver && ix.accounts?.[1].address === order.intent.buyTokenAccount),
  );
  const limit = {
    programAddress: 'ComputeBudget111111111111111111111111111111',
    accounts: [],
    data: Uint8Array.of(2, 192, 92, 21, 0),
  };
  const stageSeed = compact ? '00112233445566778899aabbccddeeff' : 'stage';
  const stage = await createAddressWithSeed({
    baseAddress: solver.address,
    seed: stageSeed,
    programAddress: buyProgram,
  });
  const create = getCreateAccountWithSeedInstruction({
    payer: solver,
    baseAccount: solver,
    newAccount: stage,
    base: solver.address,
    seed: stageSeed,
    amount: 1488440n,
    space: 165n,
    programAddress: buyProgram,
  });
  const init = getInitializeAccount3Instruction(
    {
      account: stage,
      mint: nativeBuy ? WRAPPED_SOL_MINT : buyMint,
      owner: order.orderPda,
    },
    { programAddress: buyProgram },
  );
  const [buffer, bump] = await findNativeSolBufferPda({ programAddress: program });
  const [canonicalSolverAta] = await findAssociatedTokenPda({
    owner: solver.address,
    mint: order.intent.sellMint,
    tokenProgram: sellProgram,
  });
  const inputSeed = 'i' + app.subarray(24).toString('hex');
  const solverAta = newSolverInput
    ? await createAddressWithSeed({
        baseAddress: user.address,
        seed: inputSeed,
        programAddress: sellProgram,
      })
    : canonicalSolverAta;
  const keys = (...items) => items.map(([address, role = 0]) => ({ address, role }));
  const setupInput = {
    programAddress: program,
    data: Uint8Array.of(16, ...app.subarray(24)),
    accounts: keys(
      [user.address, 3],
      [solverAta, 1],
      [solver.address],
      [order.intent.sellMint],
      [sellProgram],
      [SOLANA_NATIVE_ASSET],
      [ixSysvar],
    ),
  };
  const placement = {
    programAddress: program,
    data: Buffer.alloc(62),
    accounts: keys(
      [user.address, 3],
      [solver.address, 3],
      [order.orderPda, 1],
      [order.intent.sellTokenAccount, 1],
      [solverAta, 1],
      [sellMint],
      [order.intent.buyTokenAccount],
      [nativeBuy ? WRAPPED_SOL_MINT : buyMint],
      [stage, 1],
      [sellProgram],
      [buyProgram],
      [SOLANA_NATIVE_ASSET],
      [ixSysvar],
    ),
  };
  placement.data.set([
    17,
    8 | (nativeSale ? 1 : 0) | (newSolverInput ? 2 : 0) | (nativeBuy ? 4 : 0),
  ]);
  placement.data.writeBigUInt64LE(max, 54);
  placement.data.writeBigUInt64LE(order.intent.sellAmount, 2);
  placement.data.writeBigUInt64LE(order.intent.buyAmount, 10);
  placement.data.set(app.subarray(8, 16), 18);
  placement.data.writeUInt32LE(order.intent.validTo, 26);
  placement.data.set(app.subarray(24), 30);
  if (compact) placement.data.set(Buffer.from(stageSeed, 'hex'), 38);
  const before = compact
    ? [limit, ...walletPrefix.slice(0, -1), placement]
    : [limit, ...walletPrefix, ...(newSolverInput ? [setupInput] : []), create, init];
  const beginData = Buffer.alloc(21);
  beginData[0] = 13;
  beginData.writeUInt16LE(before.length + 2, 1);
  beginData[11] = 1;
  beginData[12] = 1;
  beginData.writeBigUInt64LE(3000n, 13);
  const begin = {
    programAddress: program,
    data: beginData,
    accounts: keys(
      [solver.address, 3],
      [ixSysvar],
      [order.statePda],
      [TOKEN_PROGRAM_ADDRESS],
      [TOKEN_2022_PROGRAM_ADDRESS],
      [order.orderPda, 1],
      [order.intent.sellTokenAccount, 1],
      [sellProgram === TOKEN_2022_PROGRAM_ADDRESS ? sellMint : ixSysvar],
      [solverAta, 1],
      [stage, 1],
    ),
  };
  const route = {
    programAddress: routeProgram,
    data: Uint8Array.of(1),
    accounts: keys([solver.address, 3], [solverAta, 1], [stage, 1]),
  };
  const cleanup = (nativeSale ? 1 : 0) | (newSolverInput ? 2 : 0);
  const finishData = Buffer.alloc(45);
  finishData[20] = cleanup | 8;
  finishData.writeBigUInt64LE(10000n, 21);
  finishData.writeBigUInt64LE(rate, 29);
  finishData.writeBigUInt64LE(max, 37);
  finishData[0] = 14;
  finishData.writeUInt16LE(before.length, 1);
  finishData[3] = bump;
  finishData.writeBigUInt64LE(order.intent.buyAmount, 4);
  const finish = {
    programAddress: program,
    data: finishData,
    accounts: keys(
      [ixSysvar],
      [order.statePda],
      [buyProgram],
      [order.orderPda, 1],
      [stage, 1],
      [buffer, 1],
      [order.intent.buyTokenAccount, 1],
      [solver.address, 3],
      [user.address, 3],
      [solverAta, 1],
      [order.intent.sellTokenAccount, 1],
    ),
  };
  if (sellProgram === TOKEN_2022_PROGRAM_ADDRESS || buyProgram === TOKEN_2022_PROGRAM_ADDRESS)
    finish.accounts.push(
      ...keys([sellMint], [nativeBuy ? WRAPPED_SOL_MINT : buyMint], [sellProgram]),
    );
  finish.accounts.push(...keys([SOLANA_NATIVE_ASSET]));
  const instructions = [...before, begin, route, finish];
  change?.({
    instructions,
    begin,
    route,
    finish,
    user,
    solver,
    order,
    setupInput,
    placement,
    quote,
  });
  const msg = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: genesis, lastValidBlockHeight: 150n },
      setTransactionMessageFeePayer(user.address, createTransactionMessage({ version: 0 })),
    ),
  );
  const table = keypair().address;
  const tableKeys =
    nativeSale || newSolverInput
      ? [
          solverAta,
          stage,
          order.orderPda,
          order.intent.sellTokenAccount,
          order.intent.buyTokenAccount,
          order.statePda,
          buffer,
          ixSysvar,
          TOKEN_2022_PROGRAM_ADDRESS,
          ...(route.accounts.length === 20
            ? [...new Set(route.accounts.slice(2).map((a) => a.address))].filter(
                (a) => a !== solverAta && a !== stage,
              )
            : []),
        ]
      : [solverAta];
  const tx = compileTransaction(
    useTable
      ? compressTransactionMessageUsingAddressLookupTables(msg, { [table]: tableKeys })
      : msg,
  );
  const bytes = getTransactionEncoder().encode({
    ...tx,
    signatures: {
      ...tx.signatures,
      [solver.address]: sign(null, tx.messageBytes, solverKey.privateKey),
    },
  });
  const packet = {
    executionMode: 'walletAtomic',
    quoteId: 1,
    nativeProtocolFee,
    orderUid: order.uid,
    solver: solver.address,
    blockhash: genesis,
    lastValidBlockHeight: '150',
    orderRentLamports: '1991360',
    nativeWrapRentLamports: nativeSale ? '1488440' : '0',
    ...(newSolverInput && { solverInputRentLamports: '1488440' }),
    tokenAccountRentLamports: createReceiver
      ? buyProgram === TOKEN_2022_PROGRAM_ADDRESS
        ? '1513840'
        : '1488440'
      : '0',
    networkFeeLamports: String(networkFee),
    transaction: Buffer.from(bytes).toString('base64'),
  };
  return {
    input,
    packet,
    user,
    order,
    table,
    tableKeys,
    solverAta,
    canonicalSolverAta,
    newSolverInput,
    receiverExists: !createReceiver,
  };
}

function rpcMock(
  t,
  {
    packet,
    input,
    table,
    tableKeys,
    lookupEntries,
    receiverExists,
    newSolverInput,
    solverPrefunded = false,
    rentPerByte = 5080n,
  },
  change,
) {
  const rent = Buffer.alloc(17),
    hashes = Buffer.alloc(48);
  rent.writeBigUInt64LE(rentPerByte);
  rent.writeDoubleLE(1, 8);
  hashes.writeBigUInt64LE(1n);
  hashes.writeBigUInt64LE(5000n, 40);
  const sysvar = (data) => ({
    owner: 'Sysvar1111111111111111111111111111111111111',
    data: [data.toString('base64'), 'base64'],
  });
  const spy = t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/api/v1/market/prepare')) {
      assert.deepEqual(body, {
        quoteId: 1,
        owner: input.owner.address,
        minimumBuyAmount: String(
          (BigInt(input.quote.quote.buyAmount) * BigInt(10_000 - input.slippageBps)) / 10_000n,
        ),
        appData: input.quote.quote.appData,
      });
      return Response.json(packet);
    }
    const values = {
      getGenesisHash: genesis,
      getMultipleAccounts: {
        context: { slot: 1 },
        value: [
          sysvar(rent),
          sysvar(hashes),
          ...(input.quote.quote.buyToken !== SOLANA_NATIVE_ASSET
            ? [
                { owner: input.buyProgram },
                receiverExists && input.buyProgram === TOKEN_PROGRAM_ADDRESS
                  ? { owner: TOKEN_PROGRAM_ADDRESS }
                  : null,
                receiverExists && input.buyProgram === TOKEN_2022_PROGRAM_ADDRESS
                  ? { owner: TOKEN_2022_PROGRAM_ADDRESS }
                  : null,
              ]
            : []),
          { owner: input.sellProgram },
          input.sellProgram !== TOKEN_PROGRAM_ADDRESS
            ? null
            : newSolverInput
              ? solverPrefunded
                ? { owner: SOLANA_NATIVE_ASSET }
                : null
              : { owner: TOKEN_PROGRAM_ADDRESS },
          input.sellProgram === TOKEN_2022_PROGRAM_ADDRESS && !newSolverInput
            ? { owner: TOKEN_2022_PROGRAM_ADDRESS }
            : null,
        ],
      },
      getTokenAccountsByOwner: { context: { slot: 1 }, value: [] },
      getAccountInfo: {
        context: { slot: 1 },
        value: {
          owner: TOKEN_2022_PROGRAM_ADDRESS,
          data: {
            program: 'spl-token-2022',
            parsed: { type: 'mint', info: { isInitialized: true, extensions: [] } },
          },
        },
      },
      getEpochInfo: { blockHeight: 100 },
      getFeeForMessage: { context: { slot: 1 }, value: Number(networkFee) },
      isBlockhashValid: { context: { slot: 2 }, value: true },
    };
    if (
      body.method === 'getMultipleAccounts' &&
      (body.params[0][0] === table || lookupEntries?.[body.params[0][0]])
    ) {
      const value = body.params[0].map((address) => {
        const entries =
          address === table ? Object.entries(tableKeys) : Object.entries(lookupEntries[address]);
        const raw = Buffer.alloc(56 + 32 * (1 + Math.max(...entries.map(([i]) => Number(i)))));
        raw.writeUInt32LE(1);
        raw.writeBigUInt64LE(0xffffffffffffffffn, 4);
        for (const [i, key] of entries)
          raw.set(getAddressEncoder().encode(key), 56 + 32 * Number(i));
        return {
          owner: 'AddressLookupTab1e1111111111111111111111111',
          data: [raw.toString('base64'), 'base64'],
        };
      });
      values.getMultipleAccounts = {
        context: { slot: 1 },
        value,
      };
    }
    assert.ok(Object.hasOwn(values, body.method), body.method);
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: change?.(body) ?? values[body.method],
    });
  });
  return spy;
}

test('full atomic wallet packet is reviewed independently and sent with one wallet approval', async (t) => {
  const f = await fixture();
  rpcMock(t, f);
  const prepared = await prepareOphisWalletAtomicSwap(f.input);
  assert.equal(prepared.order.uid, f.order.uid);
  assert.equal(prepared.costs.orderRent, 1991360n);
  assert.equal(prepared.costs.networkFee, networkFee);
  const chain = 'solana:localnet';
  const account = {
    address: f.user.address,
    publicKey: f.user.bytes,
    chains: [chain],
    features: ['solana:signAndSendTransaction'],
  };
  let approvals = 0,
    persistent = false;
  const wallet = {
    chains: [chain],
    accounts: [account],
    features: {
      'standard:connect': { connect() {} },
      'standard:events': { on() {} },
      'solana:signAndSendTransaction': {
        supportedTransactionVersions: [0],
        signAndSendTransaction: async ({ transaction }) => {
          approvals++;
          assert.ok(persistent);
          const tx = getTransactionDecoder().decode(transaction);
          assert.deepEqual(Buffer.from(transaction), Buffer.from(f.packet.transaction, 'base64'));
          return [{ signature: sign(null, tx.messageBytes, f.user.privateKey) }];
        },
      },
    },
  };
  assert.ok(
    await prepared.send({
      wallet,
      account,
      chain,
      onBeforeBroadcast: () => {
        persistent = true;
      },
    }),
  );
  assert.equal(approvals, 1);
});

for (const [name, change] of [
  [
    'unexpected route wallet account',
    ({ route, user }) => route.accounts.push({ address: user.address, role: 0 }),
  ],
  ['changed minimum', ({ finish }) => finish.data.writeBigUInt64LE(9000n, 4)],
  ['additional reimbursement', ({ finish }) => finish.data.writeBigUInt64LE(1n, 12)],
  ['legacy finish without refund', ({ finish }) => finish.accounts.splice(9)],
  [
    'wrong source refund account',
    ({ finish }) => {
      finish.accounts[10] = finish.accounts[9];
    },
  ],
  [
    'wrong win program',
    ({ route }) => {
      route.programAddress = keypair().address;
    },
  ],
])
  test('rejects ' + name + ' before requesting a wallet signature', async (t) => {
    const f = await fixture(change);
    rpcMock(t, f);
    await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
  });

test('native SOL uses an isolated temporary input, refunds its deposit and leaves existing wSOL intact', async (t) => {
  const f = await fixture(undefined, true, true);
  rpcMock(t, f);
  f.input.quote.sellFromNativeSol = true;
  const { sellFromNativeSol: _nativeFlag, ...fromQuote } = f.input;
  const prepared = await prepareOphisWalletAtomicSwap(fromQuote);
  await assert.rejects(
    prepareOphisWalletAtomicSwap({ ...fromQuote, sellFromNativeSol: false }),
    /fresh wallet-paid/,
  );
  const [walletWsol] = await findAssociatedTokenPda({
    owner: f.user.address,
    mint: WRAPPED_SOL_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  assert.notEqual(prepared.order.intent.sellTokenAccount, walletWsol);
  const nonce = Buffer.from(f.input.quote.quote.appData.slice(2), 'hex').subarray(24);
  const expectedSource = await createAddressWithSeed({
    baseAddress: f.user.address,
    seed: 'o' + nonce.toString('hex'),
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });
  assert.equal(prepared.order.intent.sellTokenAccount, expectedSource);
  assert.equal(prepared.costs.nativeWrapRent, 1488440n);
  assert.equal(prepared.costs.tokenAccountRent, 0n);
  assert.equal(prepared.costs.reserve, 650240n + 1991360n + 1488440n + networkFee);
  const first = prepared.order.instructions[0];
  assert.equal(first.programAddress, program);
  assert.equal(first.data.length, 17);
  assert.equal(first.data[0], 15);
  assert.deepEqual(first.data.slice(1, 9), Uint8Array.from(nonce));
  assert.equal(Buffer.from(first.data).readBigUInt64LE(9), 3000n);
  assert.deepEqual(
    first.accounts.map((account) => account.address),
    [
      f.user.address,
      expectedSource,
      WRAPPED_SOL_MINT,
      TOKEN_PROGRAM_ADDRESS,
      SOLANA_NATIVE_ASSET,
      ixSysvar,
    ],
  );
  f.packet.nativeWrapRentLamports = '0';
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /fees or account deposits changed/);
});

test('compact market placement binds the complete reviewed order, token programs and staging account', async (t) => {
  for (const [nativeSale, newBuyMint, newInput, tokenProgram] of [
    [false, true, true, TOKEN_PROGRAM_ADDRESS],
    [false, true, true, TOKEN_2022_PROGRAM_ADDRESS],
    [true, true, false, TOKEN_PROGRAM_ADDRESS],
    [false, false, false, TOKEN_PROGRAM_ADDRESS],
  ]) {
    const f = await fixture(undefined, true, nativeSale, newBuyMint, newInput, {
      compact: true,
      newBuyMint,
      buyProgram: tokenProgram,
    });
    const fetch = rpcMock(t, f);
    assert.equal((await prepareOphisWalletAtomicSwap(f.input)).order.uid, f.order.uid);
    fetch.mock.restore();
  }
  for (const mutate of [
    (ix) => {
      ix.accounts[6] = ix.accounts[1];
    },
    ...[1, 2, 10, 18, 26, 30, 38, 54].map((offset) => (ix) => {
      ix.data[offset] ^= 1;
    }),
  ]) {
    const f = await fixture(({ placement }) => mutate(placement), true, false, true, true, {
      compact: true,
      newBuyMint: true,
    });
    const fetch = rpcMock(t, f);
    await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
    fetch.mock.restore();
  }
});

test('Orca two-hop packets spend the reviewed input and forward the full intermediary through one account', async (t) => {
  for (const [first, second, mutation] of [
    [0, 1],
    [1, 0],
    [1, 1, 'hub'],
    [0, 0, 'output'],
    [1, 0, 'amount'],
  ]) {
    const f = await fixture(
      ({ route, quote }) => {
        const [solver, source, stage] = route.accounts;
        const hub = { address: keypair().address, role: 1 };
        route.programAddress = quote.routeProgram = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
        route.accounts = Array.from({ length: 20 }, () => ({
          address: keypair().address,
          role: 1,
        }));
        route.accounts[0] = { address: TOKEN_PROGRAM_ADDRESS, role: 0 };
        route.accounts[1] = solver;
        route.accounts[first ? 4 : 6] = source;
        route.accounts[first ? 6 : 4] = hub;
        if (mutation !== 'hub') route.accounts[second ? 8 : 10] = hub;
        route.accounts[second ? 10 : 8] = mutation === 'output' ? source : stage;
        route.data = Buffer.alloc(59);
        route.data.set([195, 96, 237, 108, 68, 162, 219, 230]);
        route.data.writeBigUInt64LE(mutation === 'amount' ? 2999n : 3000n, 8);
        route.data.writeBigUInt64LE(10000n, 16);
        route.data.set([1, first, second], 24);
      },
      true,
      false,
      false,
      true,
      { newBuyMint: true },
    );
    const mock = rpcMock(t, f);
    if (mutation) await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
    else assert.equal((await prepareOphisWalletAtomicSwap(f.input)).order.uid, f.order.uid);
    mock.mock.restore();
  }
});

test('a first-time recipient must receive precisely its own canonical token account', async (t) => {
  const f = await fixture(undefined, true, true, true);
  rpcMock(t, f);
  const prepared = await prepareOphisWalletAtomicSwap(f.input);
  assert.equal(prepared.costs.tokenAccountRent, 1488440n);
  assert.equal(prepared.costs.nativeWrapRent, 1488440n);
});

for (const nativeSale of [false, true]) {
  test(
    'first-use solver account returns the signed deposit for ' +
      (nativeSale ? 'native SOL' : 'a previously unseen mint'),
    async (t) => {
      const f = await fixture(undefined, true, nativeSale, false, true);
      assert.notEqual(f.solverAta, f.canonicalSolverAta);
      rpcMock(t, { ...f, solverPrefunded: true });
      const prepared = await prepareOphisWalletAtomicSwap(f.input);
      assert.equal(prepared.costs.solverInputRent, 1488440n);
      assert.equal(prepared.costs.nativeWrapRent, nativeSale ? 1488440n : 0n);
      f.packet.solverInputRentLamports = '0';
      await assert.rejects(
        prepareOphisWalletAtomicSwap(f.input),
        /fees or account deposits changed/,
      );
    },
  );
}

for (const [name, change] of [
  [
    'wrong token authority',
    ({ placement, user }) => {
      placement.accounts[1].address = user.address;
    },
  ],
  [
    'wrong rent destination',
    ({ placement, user }) => {
      placement.accounts[4].address = user.address;
    },
  ],
  [
    'wrong signed nonce',
    ({ placement }) => {
      placement.data[30] ^= 1;
    },
  ],
  [
    'missing automatic refund',
    ({ finish }) => {
      finish.data[20] = 0;
    },
  ],
]) {
  test('a first-use solver input rejects ' + name + ' before wallet approval', async (t) => {
    const f = await fixture(change, true, false, false, true);
    rpcMock(t, f);
    await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
  });
}

test('cannot charge for creating a new receiving ATA then omit its creation', async (t) => {
  const f = await fixture(undefined, true, true);
  f.packet.tokenAccountRentLamports = '1488440';
  f.receiverExists = false;
  rpcMock(t, f);
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
});

for (const sellProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
  for (const buyProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    test(
      'review two fresh mints and a separate native SOL fee ' + [sellProgram, buyProgram].join('/'),
      async (t) => {
        const f = await fixture(undefined, true, false, true, true, {
          sellProgram,
          buyProgram,
          newBuyMint: true,
        });
        rpcMock(t, f);
        const packet = await prepareOphisWalletAtomicSwap(f.input);
        assert.equal(packet.order.uid, f.order.uid);
        assert.equal(packet.costs.solverInputRent, 1488440n);
        assert.equal(
          packet.costs.tokenAccountRent,
          buyProgram === TOKEN_2022_PROGRAM_ADDRESS ? 1513840n : 1488440n,
        );
        assert.equal(packet.costs.networkFee, networkFee);
      },
    );
  }
}

for (const [name, change] of [
  [
    'a substituted native fee recipient',
    ({ finish }) => {
      finish.accounts[5].address = keypair().address;
    },
  ],
  [
    'an unreviewed fee cap',
    ({ finish }) => {
      finish.data.writeBigUInt64LE(999999n, 37);
    },
  ],
  [
    'another SOL valuation',
    ({ finish }) => {
      finish.data.writeBigUInt64LE(1n, 29);
    },
  ],
  [
    'a changed rate denominator',
    ({ finish }) => {
      finish.data.writeBigUInt64LE(1n, 21);
    },
  ],
  [
    'a missing system program',
    ({ finish }) => {
      finish.accounts.pop();
    },
  ],
]) {
  test('reject ' + name, async (t) => {
    const f = await fixture(change, true, false, true, true, {
      newBuyMint: true,
    });
    rpcMock(t, f);
    await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
  });
}

test('an existing receiver cannot cost a deposit even if the wallet closes it before signing', async (t) => {
  const f = await fixture(undefined, true, true, true);
  f.receiverExists = true;
  rpcMock(t, f);
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /fees or account deposits changed/);
  f.packet.tokenAccountRentLamports = '0';
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
});

test('the packet must grant required accounts their writable role', async (t) => {
  const f = await fixture(({ instructions, order }) => {
    for (const [index, ix] of instructions.entries()) {
      instructions[index] = {
        ...ix,
        accounts: ix.accounts?.map((meta) =>
          meta.address === order.orderPda ? { ...meta, role: 0 } : meta,
        ),
      };
    }
  });
  rpcMock(t, f);
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
});

test('a late blockhash check cannot pass an expired quote to the wallet', async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  rpcMock(t, f, (body) => {
    if (body.method === 'isBlockhashValid') {
      t.mock.timers.tick(91_000);
      return { context: { slot: 2 }, value: true };
    }
  });
  const reviewed = await prepareOphisWalletAtomicSwap(f.input);
  await assert.rejects(reviewed.send({ account: { address: f.user.address } }), /expired/);
});

test('the native wrapper cannot fund a different amount', async (t) => {
  const f = await fixture(
    ({ instructions }) => {
      const setup = instructions.find((ix) => ix.programAddress === program && ix.data[0] === 15);
      new DataView(setup.data.buffer).setBigUint64(9, 3001n, true);
    },
    true,
    true,
  );
  rpcMock(t, f);
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
});

test('cannot close a wallet ATA as if it were a newly funded native source', async (t) => {
  const f = await fixture(({ finish }) => {
    finish.data = Uint8Array.from([...finish.data, 1]);
  });
  rpcMock(t, f);
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
});

test('the durable-order builder refuses an atomic quote', async () => {
  const f = await fixture();
  await assert.rejects(prepareOphisSolanaOrderFromQuote(f.input), /wallet-paid market quote/);
});

test('rejects a legacy quote when the wallet requested an atomic trade', async (t) => {
  const { input } = await fixture();
  const { executionMode, solver, ...legacy } = input.quote;
  t.mock.method(globalThis, 'fetch', async () => Response.json(legacy));
  await assert.rejects(
    fetchOphisSolanaQuote(endpoint, {
      from: input.owner.address,
      sellToken: mint,
      buyToken: SOLANA_NATIVE_ASSET,
      executionMode: 'walletAtomic',
      side: { kind: 'sell', sellAmountBeforeFee: 3000n },
    }),
    /execution mode/,
  );
});

test('resolves route lookup entries on the trusted RPC and checks wallet-owned token accounts', async (t) => {
  const f = await fixture(undefined, true);
  const tableData = Buffer.alloc(88);
  tableData.writeUInt32LE(1);
  tableData.writeBigUInt64LE(0xffffffffffffffffn, 4);
  tableData.set(getAddressEncoder().encode(f.solverAta), 56);
  let ownerProgram;
  rpcMock(t, f, (body) => {
    if (body.method === 'getMultipleAccounts' && body.params[0][0] === f.table) {
      assert.deepEqual(body.params[1].dataSlice, { offset: 0, length: 8248 });
      return {
        context: { slot: 1 },
        value: [
          {
            owner: 'AddressLookupTab1e1111111111111111111111111',
            data: [tableData.toString('base64'), 'base64'],
          },
        ],
      };
    }
    if (body.method === 'getTokenAccountsByOwner' && body.params[1].programId === ownerProgram)
      return { context: { slot: 1 }, value: [{ pubkey: f.solverAta }] };
  });
  assert.equal((await prepareOphisWalletAtomicSwap(f.input)).order.uid, f.order.uid);
  for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    ownerProgram = tokenProgram;
    await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
  }
});

test('rejects altered solver signatures and unexpected fees before wallet approval', async (t) => {
  const f = await fixture();
  rpcMock(t, f);
  f.packet.networkFeeLamports = '5000';
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /fees or account deposits changed/);
  f.packet.networkFeeLamports = '10000';
  const bytes = Buffer.from(f.packet.transaction, 'base64');
  bytes[70] ^= 1;
  f.packet.transaction = bytes.toString('base64');
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /winning solver signature/);
});

for (const [name, filename, firstUse] of [
  ['legacy Rust Raydium packet', './rust-wallet-atomic.json', false],
  [
    'compact Rust packet from a settled trade between two non-SOL mints',
    './rust-wallet-market-mints.json',
    true,
  ],
])
  test(`wallet preparation applies current fee terms to the ${name}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1795700000000 });
    const { default: f } = await import(filename, { with: { type: 'json' } });
    const owner = createNoopSigner(f.owner);
    const input = {
      rpc: endpoint,
      api: endpoint,
      genesis,
      programAddress: f.program,
      owner,
      sellProgram: TOKEN_PROGRAM_ADDRESS,
      buyProgram: TOKEN_PROGRAM_ADDRESS,
      slippageBps: 50,
      quote: {
        verified: true,
        id: 1,
        executionMode: 'walletAtomic',
        from: f.owner,
        solver: f.solver,
        routeProgram: f.routeProgram,
        expiration: new Date(1795700090000).toISOString(),
        quote: {
          kind: 'sell',
          sellToken: f.sell,
          buyToken: f.buy,
          sellAmount: f.sellAmount,
          buyAmount: f.benchmark,
          feeAmount: '0',
          validTo: f.validTo,
          appData: f.appData,
          ...(firstUse && { nativeProtocolFee: f.nativeProtocolFee }),
          partiallyFillable: false,
          costs: {
            token: f.buy,
            networkFees: '0',
            buyTokenAtaCosts: '0',
            protocolFee: firstUse ? '0' : '27',
            total: firstUse ? '0' : '27',
          },
          feeTerms: {
            baseBps: firstUse ? 5 : 1,
            improvementShareBps: 5000,
            improvementCapBps: firstUse ? 99 : 20,
          },
        },
      },
    };
    const packet = {
      executionMode: 'walletAtomic',
      quoteId: 1,
      orderUid: f.orderUid,
      solver: f.solver,
      transaction: f.transaction,
      ...(firstUse && { nativeProtocolFee: f.nativeProtocolFee }),
      blockhash: f.blockhash,
      lastValidBlockHeight: '150',
      networkFeeLamports: '10000',
      orderRentLamports: '2728320',
      nativeWrapRentLamports: '0',
      ...(firstUse && { solverInputRentLamports: '2039280' }),
      tokenAccountRentLamports: '2039280',
    };
    rpcMock(t, {
      packet,
      input,
      table: f.lookupTable?.address,
      tableKeys: f.lookupTable?.addresses,
      lookupEntries: f.lookupEntries,
      newSolverInput: firstUse,
      rentPerByte: 6960n,
      receiverExists: false,
    });
    if (!firstUse) {
      await assert.rejects(prepareOphisWalletAtomicSwap(input), /protocol fee in SOL/);
      return;
    }
    const result = await prepareOphisWalletAtomicSwap(input);
    assert.equal(result.order.uid, f.orderUid);
    assert.equal(result.order.intent.buyAmount, BigInt(f.minimum));
    assert.equal(result.blockhash, f.blockhash);
  });

test('the quoted native SOL fee binds the estimate, upper limit and denomination', async (t) => {
  const f = await fixture(undefined, true, true);
  const q = f.input.quote;
  const request = {
    from: q.from,
    sellToken: SOLANA_NATIVE_ASSET,
    buyToken: q.quote.buyToken,
    executionMode: 'walletAtomic',
    slippageBps: 50,
    side: { kind: 'sell', sellAmountBeforeFee: 3000n },
  };
  const response = structuredClone(q);
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(init.body).slippageBps, 50);
    return Response.json(response);
  });
  const verified = await fetchOphisSolanaQuote(endpoint, request);
  assert.deepEqual(verified.quote.nativeProtocolFee, q.quote.nativeProtocolFee);
  for (const slippageBps of [-1, 5001, 0.5]) {
    await assert.rejects(fetchOphisSolanaQuote(endpoint, { ...request, slippageBps }), /Slippage/);
  }
  const cap = getOphisNativeSellFeeCap(3000n, request.buyToken);
  assert.ok(cap >= BigInt(q.quote.nativeProtocolFee.maxLamports));
  for (const changed of [
    { maxLamports: '500' },
    { estimatedLamports: '1' },
    { rateBuyAtoms: '9999' },
    { rateLamports: '2999' },
    { rateLamports: '0' },
    { maxLamports: '18446744073709551616' },
  ]) {
    response.quote.nativeProtocolFee = { ...q.quote.nativeProtocolFee, ...changed };
    await assert.rejects(fetchOphisSolanaQuote(endpoint, request));
  }
  delete response.quote.nativeProtocolFee;
  await assert.rejects(fetchOphisSolanaQuote(endpoint, request));
});

test('native fee settlement requires the wallet-funded compact placement', async (t) => {
  const f = await fixture(undefined, true, false, false, false, { compact: false });
  rpcMock(t, f);
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
});
