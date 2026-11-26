import {
  createAddressWithSeed,
  getAddressEncoder,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTokenSize,
} from '@solana-program/token';
import { getCreateAccountWithSeedInstructionDataCodec } from '@solana-program/system';
import type { prepareOphisSolanaOrder } from './index.js';
import { findBufferPda } from './settlement/generated/pdas/buffer.js';
import { findNativeSolBufferPda } from './settlement/generated/pdas/nativeSolBuffer.js';
import {
  SOLANA_NATIVE_ASSET,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  WRAPPED_SOL_MINT,
} from './tokens.js';

type Order = Awaited<ReturnType<typeof prepareOphisSolanaOrder>>;
const sysvar = 'Sysvar1nstructions1111111111111111111111111';
const computeBudget = 'ComputeBudget111111111111111111111111111111';

export function sameBytes(left?: ReadonlyUint8Array, right?: ReadonlyUint8Array): boolean {
  return (
    left?.length === right?.length &&
    (!left || left.every((value, index) => value === right?.[index]))
  );
}

function sameInstruction(a: Instruction | undefined, b: Instruction): boolean {
  return (
    a?.programAddress === b.programAddress &&
    sameBytes(a.data, b.data) &&
    a.accounts?.length === b.accounts?.length &&
    (b.accounts ?? []).every((key, index) => key.address === a.accounts?.[index]?.address)
  );
}

function reject(): never {
  throw Error('The transaction does not match the swap you reviewed. Get a fresh quote.');
}

function data(ix: Instruction): DataView {
  const bytes = Uint8Array.from(ix.data ?? []);
  return new DataView(bytes.buffer);
}

function refs(ix: Instruction, address: Address): boolean {
  return ix.programAddress === address || !!ix.accounts?.some((meta) => meta.address === address);
}

/** Untrusted route instructions may inherit the solver signer only. Solana privileges are transaction-wide. */
export async function checkAtomicInstructions(input: {
  program: Address;
  solver: Address;
  routeProgram: Address;
  order: Order;
  instructions: readonly Instruction[];
  walletTokenAccounts: ReadonlySet<Address>;
  stageRent: bigint;
  temporaryNativeSource?: boolean;
  requiredReceiveAta?: Address;
}): Promise<void> {
  const { program, order, solver, instructions } = input;
  const { intent, orderPda, statePda, payer } = order;
  const end = instructions.length - 1;
  const finish = instructions[end];
  if (
    !finish ||
    finish.programAddress !== program ||
    finish.data?.length !== (input.temporaryNativeSource ? 21 : 20) ||
    (input.temporaryNativeSource && finish.data?.[20] !== 1) ||
    finish.data[0] !== 14
  )
    reject();
  const terms = data(finish);
  const pos = terms.getUint16(1, true);
  const begin = instructions[pos];
  if (
    !begin ||
    begin.programAddress !== program ||
    begin.data?.[0] !== 13 ||
    begin.data.length < 21 ||
    data(begin).getUint16(1, true) !== end ||
    pos < 3 ||
    end !== pos + 2 ||
    instructions[pos + 1]?.programAddress !== input.routeProgram ||
    terms.getBigUint64(4, true) < intent.buyAmount ||
    terms.getBigUint64(12, true) !== 0n
  )
    reject();

  let cursor = 0;
  if (instructions[0]?.programAddress === computeBudget) {
    const limit = instructions[0];
    if (
      limit.accounts?.length ||
      limit.data?.length !== 5 ||
      limit.data[0] !== 2 ||
      !data(limit).getUint32(1, true) ||
      data(limit).getUint32(1, true) > 1_400_000
    )
      reject();
    cursor++;
  }
  // Compilers can omit idempotent creation when the ATA exists. Every other wallet instruction is mandatory.
  for (const expected of order.instructions) {
    if (sameInstruction(instructions[cursor], expected)) cursor++;
    else if (
      expected.programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS ||
      (input.requiredReceiveAta && expected.accounts?.[1]?.address === input.requiredReceiveAta)
    )
      reject();
  }
  if (cursor !== pos - 2) reject();

  const metas = begin.accounts?.map((account) => account.address) ?? [];
  const pulls = begin.data[12];
  const stage = metas.at(-1);
  if (
    !stage ||
    begin.data[11] !== 1 ||
    pulls !== 1 ||
    begin.data.length !== 13 + pulls * 8 ||
    metas.length !== 9 + pulls ||
    metas[0] !== solver ||
    metas[1] !== sysvar ||
    metas[2] !== statePda ||
    metas[3] !== TOKEN_PROGRAM_ADDRESS ||
    metas[4] !== TOKEN_2022_PROGRAM_ADDRESS ||
    metas[5] !== orderPda ||
    metas[6] !== intent.sellTokenAccount ||
    metas[7] !== sysvar ||
    refs(begin, payer)
  )
    reject();
  const [solverInput] = await findAssociatedTokenPda({
    owner: solver,
    mint: intent.sellMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  if (data(begin).getBigUint64(13, true) !== intent.sellAmount || metas[8] !== solverInput)
    reject();

  const [create, init] = instructions.slice(cursor, pos);
  const addressBytes = getAddressEncoder();
  if (
    !create ||
    !init ||
    refs(create, payer) ||
    refs(init, payer) ||
    create.programAddress !== SOLANA_NATIVE_ASSET ||
    create.data === undefined ||
    create.data.length < 36 ||
    data(create).getUint32(0, true) !== 3 ||
    !sameBytes(create.data.slice(4, 36), addressBytes.encode(solver)) ||
    create.accounts?.[0]?.address !== solver ||
    create.accounts?.[1]?.address !== stage ||
    create.accounts.slice(2).some((meta) => meta.address !== solver) ||
    init.programAddress !== TOKEN_PROGRAM_ADDRESS ||
    init.accounts?.length !== 2 ||
    init.data?.[0] !== 18 ||
    !sameBytes(init.data.slice(1), addressBytes.encode(orderPda)) ||
    init.accounts[0]?.address !== stage ||
    init.accounts[1]?.address !==
      (intent.buyMint === SOLANA_NATIVE_ASSET ? WRAPPED_SOL_MINT : intent.buyMint)
  )
    reject();

  const codec = getCreateAccountWithSeedInstructionDataCodec();
  const setup = codec.decode(create.data);
  if (
    !sameBytes(codec.encode(setup), create.data) ||
    setup.base !== solver ||
    setup.programAddress !== TOKEN_PROGRAM_ADDRESS ||
    setup.amount !== input.stageRent ||
    setup.space !== BigInt(getTokenSize()) ||
    (await createAddressWithSeed({
      baseAddress: solver,
      seed: setup.seed,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    })) !== stage
  )
    reject();

  const [buffer, bump] =
    intent.buyMint === SOLANA_NATIVE_ASSET
      ? await findNativeSolBufferPda({ programAddress: program })
      : await findBufferPda({ mint0: intent.buyMint }, { programAddress: program });
  const finishMetas = [
    sysvar,
    statePda,
    TOKEN_PROGRAM_ADDRESS,
    orderPda,
    stage,
    buffer,
    intent.buyTokenAccount,
    solver,
    payer,
    solverInput,
    intent.sellTokenAccount,
  ];
  if (
    finish.data[3] !== bump ||
    finish.accounts?.length !== finishMetas.length ||
    finishMetas.some((account, index) => finish.accounts?.[index]?.address !== account)
  )
    reject();
  const protectedKeys = new Set([
    program,
    payer,
    intent.sellTokenAccount,
    intent.buyTokenAccount,
    orderPda,
    statePda,
    buffer,
    ...input.walletTokenAccounts,
  ]);
  const route = instructions[pos + 1];
  if (
    !route ||
    route.programAddress === computeBudget ||
    protectedKeys.has(route.programAddress) ||
    route.accounts?.some((meta) => protectedKeys.has(meta.address)) ||
    !refs(route, solverInput) ||
    !refs(route, stage) ||
    !refs(route, solver)
  )
    reject();
}
