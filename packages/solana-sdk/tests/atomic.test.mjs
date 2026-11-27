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
import { findBufferPda } from '../dist/settlement/generated/pdas/buffer.js';
import { findNativeSolBufferPda } from '../dist/settlement/generated/pdas/nativeSolBuffer.js';
import {
  fetchOphisSolanaQuote,
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

async function fixture(change, useTable = false, nativeSale = false, createReceiver = false) {
  const user = keypair(),
    solverKey = keypair(),
    solver = createNoopSigner(solverKey.address);
  const app = Buffer.alloc(32);
  app.write('OPHISPI3');
  app.writeBigUInt64LE(10000n, 8);
  app.writeBigUInt64LE(100n, 24);
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
      sellToken: nativeSale ? WRAPPED_SOL_MINT : mint,
      buyToken: nativeSale ? mint : SOLANA_NATIVE_ASSET,
      receiver: null,
      sellAmount: '3000',
      buyAmount: '10000',
      feeAmount: '0',
      costs: {
        token: nativeSale ? mint : SOLANA_NATIVE_ASSET,
        networkFees: '0',
        buyTokenAtaCosts: '0',
        protocolFee: '1',
        total: '1',
      },
      feeTerms: { baseBps: 1, improvementShareBps: 5000, improvementCapBps: 99 },
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
    sellProgram: TOKEN_PROGRAM_ADDRESS,
    slippageBps: 50,
    sellFromNativeSol: nativeSale,
    ...(nativeSale && { buyProgram: TOKEN_PROGRAM_ADDRESS }),
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
  const stage = await createAddressWithSeed({
    baseAddress: solver.address,
    seed: 'stage',
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });
  const create = getCreateAccountWithSeedInstruction({
    payer: solver,
    baseAccount: solver,
    newAccount: stage,
    base: solver.address,
    seed: 'stage',
    amount: 1488440n,
    space: 165n,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });
  const init = getInitializeAccount3Instruction({
    account: stage,
    mint: nativeSale ? mint : WRAPPED_SOL_MINT,
    owner: order.orderPda,
  });
  const before = [limit, ...walletPrefix, create, init];
  const [buffer, bump] = nativeSale
    ? await findBufferPda({ mint0: mint }, { programAddress: program })
    : await findNativeSolBufferPda({ programAddress: program });
  const [solverAta] = await findAssociatedTokenPda({
    owner: solver.address,
    mint: order.intent.sellMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const keys = (...items) => items.map(([address, role = 0]) => ({ address, role }));
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
      [ixSysvar],
      [solverAta, 1],
      [stage, 1],
    ),
  };
  const route = {
    programAddress: routeProgram,
    data: Uint8Array.of(1),
    accounts: keys([solver.address, 3], [solverAta, 1], [stage, 1]),
  };
  const finishData = Buffer.alloc(nativeSale ? 21 : 20);
  if (nativeSale) finishData[20] = 1;
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
      [TOKEN_PROGRAM_ADDRESS],
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
  const instructions = [...before, begin, route, finish];
  change?.({ instructions, begin, route, finish, user, solver, order });
  const msg = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: genesis, lastValidBlockHeight: 150n },
      setTransactionMessageFeePayer(user.address, createTransactionMessage({ version: 0 })),
    ),
  );
  const table = keypair().address;
  const tableKeys = nativeSale
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
    orderUid: order.uid,
    solver: solver.address,
    blockhash: genesis,
    lastValidBlockHeight: '150',
    orderRentLamports: '1991360',
    nativeWrapRentLamports: nativeSale ? '1488440' : '0',
    tokenAccountRentLamports: createReceiver ? '1488440' : '0',
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
    receiverExists: !createReceiver,
  };
}

function rpcMock(
  t,
  { packet, input, table, tableKeys, receiverExists, rentPerByte = 5080n },
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
                { owner: TOKEN_PROGRAM_ADDRESS },
                receiverExists ? { owner: TOKEN_PROGRAM_ADDRESS } : null,
                null,
              ]
            : []),
        ],
      },
      getTokenAccountsByOwner: { context: { slot: 1 }, value: [] },
      getEpochInfo: { blockHeight: 100 },
      getFeeForMessage: { context: { slot: 1 }, value: Number(networkFee) },
      isBlockhashValid: { context: { slot: 2 }, value: true },
    };
    if (body.method === 'getMultipleAccounts' && body.params[0][0] === table) {
      const raw = Buffer.alloc(56 + 32 * tableKeys.length);
      raw.writeUInt32LE(1);
      raw.writeBigUInt64LE(0xffffffffffffffffn, 4);
      tableKeys.forEach((key, index) => raw.set(getAddressEncoder().encode(key), 56 + 32 * index));
      values.getMultipleAccounts = {
        context: { slot: 1 },
        value: [
          {
            owner: 'AddressLookupTab1e1111111111111111111111111',
            data: [raw.toString('base64'), 'base64'],
          },
        ],
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

test('a first-time recipient must receive precisely its own canonical token account', async (t) => {
  const f = await fixture(undefined, true, true, true);
  rpcMock(t, f);
  const prepared = await prepareOphisWalletAtomicSwap(f.input);
  assert.equal(prepared.costs.tokenAccountRent, 1488440n);
  assert.equal(prepared.costs.nativeWrapRent, 1488440n);
});

test('cannot charge for creating a new receiving ATA then omit its creation', async (t) => {
  const f = await fixture(undefined, true, true);
  f.packet.tokenAccountRentLamports = '1488440';
  f.receiverExists = false;
  rpcMock(t, f);
  await assert.rejects(prepareOphisWalletAtomicSwap(f.input), /does not match/);
});

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

test('the public wallet preparation path verifies the signed Rust Raydium packet', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1795700000000 });
  const { default: f } = await import('./rust-wallet-atomic.json', { with: { type: 'json' } });
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
        partiallyFillable: false,
        costs: {
          token: f.buy,
          networkFees: '0',
          buyTokenAtaCosts: '0',
          protocolFee: '27',
          total: '27',
        },
        feeTerms: { baseBps: 1, improvementShareBps: 5000, improvementCapBps: 20 },
      },
    },
  };
  const packet = {
    executionMode: 'walletAtomic',
    quoteId: 1,
    orderUid: f.orderUid,
    solver: f.solver,
    transaction: f.transaction,
    blockhash: f.blockhash,
    lastValidBlockHeight: '150',
    networkFeeLamports: '10000',
    orderRentLamports: '2728320',
    nativeWrapRentLamports: '0',
    tokenAccountRentLamports: '2039280',
  };
  rpcMock(t, {
    packet,
    input,
    table: f.lookupTable.address,
    tableKeys: f.lookupTable.addresses,
    rentPerByte: 6960n,
    receiverExists: false,
  });
  const result = await prepareOphisWalletAtomicSwap(input);
  assert.equal(result.order.uid, f.orderUid);
  assert.equal(result.order.intent.buyAmount, BigInt(f.minimum));
  assert.equal(result.blockhash, f.blockhash);
});
