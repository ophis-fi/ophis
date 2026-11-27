import {
  address,
  createAddressWithSeed,
  isSignerRole,
  isWritableRole,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
} from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import type { prepareOphisSolanaOrder } from './index.js';
import type { NativeProtocolFee } from './api.js';
import { findNativeSolBufferPda } from './settlement/generated/pdas/nativeSolBuffer.js';
import {
  SOLANA_NATIVE_ASSET,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  WRAPPED_SOL_MINT,
} from './tokens.js';

type Order = Awaited<ReturnType<typeof prepareOphisSolanaOrder>>;
const sysvar = address('Sysvar1nstructions1111111111111111111111111');
const computeBudget = 'ComputeBudget111111111111111111111111111111';
const whirlpools = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

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
    (b.accounts ?? []).every((expected, index) => {
      const actual = a.accounts?.[index];
      return (
        actual?.address === expected.address && (actual.role & expected.role) === expected.role
      );
    })
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

function seedHex(bytes: ReadonlyUint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Untrusted route instructions may inherit the solver signer only. Solana privileges are transaction-wide. */
export async function checkAtomicInstructions(input: {
  program: Address;
  solver: Address;
  routeProgram: Address;
  order: Order;
  instructions: readonly Instruction[];
  walletTokenAccounts: ReadonlySet<Address>;
  nativeFee: NativeProtocolFee;
  sellProgram: Address;
  buyProgram: Address;
  temporaryNativeSource?: boolean;
  temporarySolverInput?: boolean;
  requiredReceiveAta?: Address;
}): Promise<void> {
  const { program, order, solver, instructions, sellProgram, buyProgram } = input;
  const { intent, orderPda, statePda, payer } = order;
  const end = instructions.length - 1;
  const finish = instructions[end];
  const cleanup = (input.temporaryNativeSource ? 1 : 0) | (input.temporarySolverInput ? 2 : 0);
  const fee = input.nativeFee;
  if (
    !finish ||
    finish.programAddress !== program ||
    finish.data?.length !== 45 ||
    finish.data[20] !== (cleanup | 8) ||
    finish.data[0] !== 14
  )
    reject();
  const terms = data(finish);
  const pos = terms.getUint16(1, true);
  const begin = instructions[pos];
  const placement = instructions[pos - 1];

  if (
    !begin ||
    begin.programAddress !== program ||
    begin.data?.[0] !== 13 ||
    begin.data.length < 21 ||
    data(begin).getUint16(1, true) !== end ||
    pos < 2 ||
    placement?.programAddress !== program ||
    placement.data?.[0] !== 17 ||
    end !== pos + 2 ||
    instructions[pos + 1]?.programAddress !== input.routeProgram ||
    terms.getBigUint64(4, true) < intent.buyAmount ||
    terms.getBigUint64(12, true) !== 0n ||
    terms.getBigUint64(21, true) !== BigInt(fee.rateBuyAtoms) ||
    terms.getBigUint64(29, true) !== BigInt(fee.rateLamports) ||
    terms.getBigUint64(37, true) !== BigInt(fee.maxLamports)
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
  // Only account deposits verified in the review may be fronted by the wallet.
  const prefix = order.instructions.slice(0, -1);
  for (const expected of prefix) {
    if (
      expected.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS &&
      expected.accounts?.[1]?.address !== input.requiredReceiveAta
    )
      continue;
    if (!sameInstruction(instructions[cursor], expected)) reject();
    cursor++;
  }
  let solverInput: Address;
  if (input.temporarySolverInput) {
    const nonce = intent.appData.slice(24);
    const seed = 'i' + seedHex(nonce);
    solverInput = await createAddressWithSeed({
      baseAddress: payer,
      seed,
      programAddress: sellProgram,
    });
  } else {
    [solverInput] = await findAssociatedTokenPda({
      owner: solver,
      mint: intent.sellMint,
      tokenProgram: sellProgram,
    });
  }
  if (cursor !== pos - 1) reject();

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
    metas[7] !== (sellProgram === TOKEN_2022_PROGRAM_ADDRESS ? intent.sellMint : sysvar) ||
    refs(begin, payer)
  )
    reject();
  if (data(begin).getBigUint64(13, true) !== intent.sellAmount || metas[8] !== solverInput)
    reject();

  const routeBuyMint = intent.buyMint === SOLANA_NATIVE_ASSET ? WRAPPED_SOL_MINT : intent.buyMint;
  const wire = placement.data;
  if (!wire || wire.length !== 62) reject();
  const fields = data(placement);
  const expectedKeys = [
    payer,
    solver,
    orderPda,
    intent.sellTokenAccount,
    solverInput,
    intent.sellMint,
    intent.buyTokenAccount,
    routeBuyMint,
    stage,
    sellProgram,
    buyProgram,
    SOLANA_NATIVE_ASSET,
    sysvar,
  ];
  if (
    wire[1] !== (cleanup | 8 | (intent.buyMint === SOLANA_NATIVE_ASSET ? 4 : 0)) ||
    fields.getBigUint64(54, true) !== BigInt(fee.maxLamports) ||
    fields.getBigUint64(2, true) !== intent.sellAmount ||
    fields.getBigUint64(10, true) !== intent.buyAmount ||
    !sameBytes(wire.slice(18, 26), intent.appData.slice(8, 16)) ||
    fields.getUint32(26, true) !== intent.validTo ||
    !sameBytes(wire.slice(30, 38), intent.appData.slice(24)) ||
    placement.accounts?.length !== expectedKeys.length ||
    expectedKeys.some((key, i) => placement.accounts?.[i]?.address !== key) ||
    [0, 1].some((i) => !isSignerRole(placement.accounts?.[i]?.role ?? 0)) ||
    [0, 1, 2, 3, 4, 8].some((i) => !isWritableRole(placement.accounts?.[i]?.role ?? 0)) ||
    (await createAddressWithSeed({
      baseAddress: solver,
      seed: seedHex(wire.slice(38, 54)),
      programAddress: buyProgram,
    })) !== stage
  )
    reject();

  const [buffer, bump] = await findNativeSolBufferPda({ programAddress: program });
  const finishMetas = [
    sysvar,
    statePda,
    buyProgram,
    orderPda,
    stage,
    buffer,
    intent.buyTokenAccount,
    solver,
    payer,
    solverInput,
    intent.sellTokenAccount,
  ];
  if (sellProgram === TOKEN_2022_PROGRAM_ADDRESS || buyProgram === TOKEN_2022_PROGRAM_ADDRESS) {
    finishMetas.push(intent.sellMint, routeBuyMint, sellProgram);
  }
  finishMetas.push(SOLANA_NATIVE_ASSET);
  if (
    finish.data[3] !== bump ||
    finish.accounts?.length !== finishMetas.length ||
    finishMetas.some((account, index) => finish.accounts?.[index]?.address !== account) ||
    finish.accounts.slice(3, 11).some((account) => !isWritableRole(account.role))
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
  if (route.programAddress === whirlpools) {
    const accounts = route.accounts ?? [];
    const bytes = route.data;
    if (
      !bytes ||
      accounts[0]?.address !== TOKEN_PROGRAM_ADDRESS ||
      accounts[1]?.address !== solver ||
      !isSignerRole(accounts[1].role) ||
      sellProgram !== TOKEN_PROGRAM_ADDRESS ||
      buyProgram !== TOKEN_PROGRAM_ADDRESS
    )
      reject();
    const field = data(route);
    let source: number, destination: number;
    if (
      bytes.length === 59 &&
      sameBytes(bytes.slice(0, 8), Uint8Array.of(195, 96, 237, 108, 68, 162, 219, 230))
    ) {
      const first = field.getUint8(25),
        second = field.getUint8(26);
      if (
        accounts.length !== 20 ||
        accounts[2]?.address === accounts[3]?.address ||
        bytes[24] !== 1 ||
        first > 1 ||
        second > 1 ||
        bytes.slice(27).some(Boolean)
      )
        reject();
      source = first ? 4 : 6;
      destination = second ? 10 : 8;
      const hub = accounts[first ? 6 : 4];
      if (
        !hub ||
        !isWritableRole(hub.role) ||
        hub.address !== accounts[second ? 8 : 10]?.address ||
        hub.address === solverInput ||
        hub.address === stage
      )
        reject();
    } else if (
      bytes.length === 42 &&
      sameBytes(bytes.slice(0, 8), Uint8Array.of(248, 198, 158, 145, 225, 117, 135, 200))
    ) {
      if (bytes[40] !== 1 || field.getUint8(41) > 1) reject();
      source = bytes[41] ? 3 : 5;
      destination = bytes[41] ? 5 : 3;
    } else reject();
    if (
      field.getBigUint64(8, true) !== intent.sellAmount ||
      field.getBigUint64(16, true) < intent.buyAmount ||
      accounts[source]?.address !== solverInput ||
      !isWritableRole(accounts[source]?.role ?? 0) ||
      accounts[destination]?.address !== stage ||
      !isWritableRole(accounts[destination]?.role ?? 0)
    )
      reject();
  }
}
