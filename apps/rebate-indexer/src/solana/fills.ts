import { createHash } from 'node:crypto';
import { base58 } from '@scure/base';
import postgres from 'postgres';
import { historicalCoinUsd } from '../pricer.js';
import { logger } from '../logger.js';

// Mainnet deployment manifest and one public settlement from the beginning of its history.
// The anchor prevents using a devnet, test or freshly truncated orderbook as a coverage source.
const PROGRAM = 'BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h';
const STATE = '4Wk6R1t1KWEAKRZsFnJgdrWgoDjavFSBZwkm7RJHiyKg';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ANCHOR =
  '4cwtwkbLYEKqRvDvtsna3hFf8gUPRjsuHNBWoFWuxRKGNrTFjqBYuuQyqo2DyfTBTFDrFQcWE182uGE1CBZdwp8a';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const PAGE = 12;
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const NATIVE_FEE_BUFFER = 'ALB46a7mLYBb6UGsp8FJ3JM9p1ZZyyFRdwzbAavBjGij';

type Cursor = { slot: string; sig: string; ix: number; uid: string };
type Fill = {
  auction_id: string | null;
  slot: string;
  tx_signature: Buffer;
  instruction_index: number;
  order_uid: Buffer;
  wallet: Buffer;
  order_pda: Buffer;
  sell_mint: Buffer;
  buy_mint: Buffer;
  sell_atoms: string;
  buy_atoms: string;
  kind: 'sell' | 'buy';
  user_source: Buffer;
  user_destination: Buffer;
  fee_mint: Buffer | null;
  actual_gross: string | null;
  execution_cost: string | null;
  actual_base_fee: string | null;
  actual_improvement_fee: string | null;
  protocol_fee: string | null;
  base_fee_atoms: string | null;
};
type TokenBalance = { accountIndex: number; mint: string; owner?: string };
type CompiledIx = {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
};
type Receipt = {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    returnData?: { programId: string; data: [string, string] };
    innerInstructions?: { index: number; instructions: CompiledIx[] }[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: CompiledIx[];
    };
  };
};
export type SolanaRpc = <T>(method: string, params: unknown[]) => Promise<T>;
export function reportingRpc(url: string): SolanaRpc {
  return async <T>(method: string, params: unknown[]) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw Error(`Solana reporting RPC ${method} returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number } };
    if (body.error || body.result === undefined)
      throw Error(
        `Solana reporting RPC ${method} failed (${body.error?.code ?? 'missing result'})`,
      );
    return body.result;
  };
}

// The finalized program already validated the canonical bump. Match the
// receipt PDA against this UID so another database order cannot claim the fill.
function orderPdaMatches(uid: Buffer, pda: Buffer): boolean {
  const prefix = createHash('sha256').update('settlement v0.5    ').update(uid).update('order');
  const program = base58.decode(PROGRAM);
  for (let bump = 255; bump >= 0; bump--) {
    const derived = prefix
      .copy()
      .update(Buffer.from([bump]))
      .update(program)
      .update('ProgramDerivedAddress')
      .digest();
    if (derived.equals(pda)) return true;
  }
  return false;
}

function verifyMarketPlacement(
  row: Fill,
  instructions: CompiledIx[],
  keys: string[],
  end: CompiledIx,
  finish: Buffer,
  pulled: bigint,
) {
  const a = end.accounts;
  const flags = finish[20] ?? 0;
  const nativeFee = (flags & 8) !== 0;
  const sell = base58.encode(row.sell_mint),
    buy = base58.encode(row.buy_mint);
  if (
    a[8] !== 0 ||
    keys[0] !== base58.encode(row.wallet) ||
    ((flags & 1) !== 0 && sell !== WSOL) ||
    (buy === SOL && a[6] !== a[8])
  )
    throw Error('Market wallet or native mint mismatch');
  const placed = instructions.slice(0, row.instruction_index).some((ix, i) => {
    if (keys[ix.programIdIndex] !== PROGRAM || ix.accounts[0] !== a[8] || ix.accounts[2] !== a[3])
      return false;
    const data = Buffer.from(base58.decode(ix.data));
    if (data[0] === 2 && !nativeFee) {
      const intent = data.subarray(1);
      return (
        ix.accounts[1] === a[8] &&
        intent.length === 213 &&
        createHash('sha256').update(intent).digest().equals(row.order_uid) &&
        intent.subarray(0, 32).equals(row.wallet) &&
        intent.subarray(32, 64).equals(row.user_source) &&
        intent.subarray(64, 96).equals(row.sell_mint) &&
        intent.subarray(96, 128).equals(row.user_destination) &&
        intent.subarray(128, 160).equals(row.buy_mint) &&
        intent.readBigUInt64LE(160) === pulled
      );
    }
    return (
      data[0] === 17 &&
      i + 1 === row.instruction_index &&
      ix.accounts.length === 13 &&
      data.length === (nativeFee ? 62 : 54) &&
      data[1] === (flags | (buy === SOL ? 4 : 0)) &&
      data.readBigUInt64LE(2) === pulled &&
      ix.accounts[1] === a[7] &&
      ix.accounts[3] === a[10] &&
      ix.accounts[4] === a[9] &&
      ix.accounts[6] === a[6] &&
      ix.accounts[8] === a[4] &&
      keys[ix.accounts[5]!] === sell &&
      keys[ix.accounts[7]!] === (buy === SOL ? WSOL : buy) &&
      (!nativeFee ||
        (data.readBigUInt64LE(18) === finish.readBigUInt64LE(21) &&
          data.readBigUInt64LE(54) === finish.readBigUInt64LE(37)))
    );
  });
  if (!placed) throw Error('Missing signed market placement');
}

function verifyActual(
  row: Fill,
  receipt: Receipt,
  keys: string[],
  begin: Buffer,
  ix: CompiledIx,
): void {
  const finishIndex = begin.readUInt16LE(1);
  const message = receipt.transaction.message;
  const end = message.instructions[finishIndex];
  const nPulls = begin[12];
  const meta = receipt.meta!;
  const result = meta.returnData;
  if (
    row.kind !== 'sell' ||
    nPulls === undefined ||
    nPulls === 0 ||
    begin.readBigInt64LE(3).toString() !== row.auction_id ||
    begin[11] !== 1 ||
    begin.length !== 13 + 8 * nPulls ||
    ix.accounts.length !== 9 + nPulls ||
    finishIndex <= row.instruction_index ||
    finishIndex !== message.instructions.length - 1 ||
    !end ||
    keys[end.programIdIndex] !== PROGRAM ||
    keys[end.accounts[1]!] !== STATE ||
    end.accounts[0] !== ix.accounts[1] ||
    end.accounts[3] !== ix.accounts[5] ||
    end.accounts[4] !== ix.accounts.at(-1) ||
    end.accounts[7] !== ix.accounts[0] ||
    !row.user_source ||
    !row.user_destination ||
    keys[ix.accounts[6]!] !== base58.encode(row.user_source) ||
    keys[end.accounts[6]!] !== base58.encode(row.user_destination) ||
    keys[end.accounts[3]!] !== base58.encode(row.order_pda) ||
    !orderPdaMatches(row.order_uid, row.order_pda) ||
    result?.programId !== PROGRAM ||
    result.data[1] !== 'base64'
  )
    throw Error('Unverified actual-output settlement');
  const finish = Buffer.from(base58.decode(end.data));
  const proof = Buffer.from(result.data[0], 'base64');
  const a = end.accounts;
  const market = a.length !== 8;
  const nativeFee = a.length === 12 || a.length === 15;
  const checked = a.length === 14 || a.length === 15;
  const flags = finish[20] ?? 0;
  const buy = base58.encode(row.buy_mint),
    sell = base58.encode(row.sell_mint);
  const buyProgram = keys[a[2]!];
  const sellProgram = checked ? keys[a[13]!] : SPL_TOKEN;
  if (
    ![8, 11, 12, 14, 15].includes(a.length) ||
    (nativeFee
      ? finish.length !== 45 || flags < 8 || flags > 11
      : !(finish.length === 20 || (market && finish.length === 21 && flags >= 1 && flags <= 3))) ||
    finish[0] !== 14 ||
    finish.readUInt16LE(1) !== row.instruction_index ||
    proof.length !== (nativeFee ? 96 : market ? 88 : 80) ||
    !proof
      .subarray(0, 8)
      .equals(Buffer.from(nativeFee ? 'OPHISRC5' : market ? 'OPHISRC4' : 'OPHISRC3')) ||
    (buyProgram !== SPL_TOKEN && !(checked && buyProgram === TOKEN_2022)) ||
    (sellProgram !== SPL_TOKEN && sellProgram !== TOKEN_2022) ||
    (checked && (keys[a[11]!] !== sell || keys[a[12]!] !== (buy === SOL ? WSOL : buy))) ||
    (nativeFee && (keys[a.at(-1)!] !== SOL || keys[a[5]!] !== NATIVE_FEE_BUFFER)) ||
    !row.fee_mint ||
    base58.encode(row.fee_mint) !== (nativeFee ? SOL : buy) ||
    !proof.subarray(8, 40).equals(row.order_pda)
  )
    throw Error('Unpaired actual-output receipt');
  const gross = proof.readBigUInt64LE(40),
    cost = proof.readBigUInt64LE(48),
    base = proof.readBigUInt64LE(56),
    improvement = proof.readBigUInt64LE(64),
    payout = proof.readBigUInt64LE(72);
  let pulled = 0n;
  for (let pull = 0; pull < nPulls; pull++) pulled += begin.readBigUInt64LE(13 + 8 * pull);
  const sold = market ? proof.readBigUInt64LE(80) : pulled;
  if (market) {
    if (
      nPulls !== 1 ||
      cost !== 0n ||
      sold === 0n ||
      sold > pulled ||
      a[10] !== ix.accounts[6] ||
      a[9] !== ix.accounts[8]
    )
      throw Error('Invalid wallet market settlement');
    verifyMarketPlacement(row, message.instructions, keys, end, finish, pulled);
  }
  let paidBase = base,
    paidTotal = base + improvement;
  if (nativeFee) {
    const quoteBuy = finish.readBigUInt64LE(21),
      quoteSol = finish.readBigUInt64LE(29),
      cap = finish.readBigUInt64LE(37);
    if (
      quoteBuy === 0n ||
      quoteSol === 0n ||
      ((buy === SOL || buy === WSOL) && quoteSol !== quoteBuy) ||
      (sell === WSOL && quoteSol !== pulled)
    )
      throw Error('Invalid SOL fee valuation');
    const total = (paidTotal * quoteSol) / quoteBuy;
    paidTotal = total < cap ? total : cap;
    const convertedBase = (base * quoteSol) / quoteBuy;
    paidBase = convertedBase < paidTotal ? convertedBase : paidTotal;
    if (proof.readBigUInt64LE(88) !== paidTotal) throw Error('SOL fee differs from receipt');
  }
  if (
    gross !== (nativeFee ? payout : cost + base + improvement + payout) ||
    payout < finish.readBigUInt64LE(4) ||
    cost !== finish.readBigUInt64LE(12) ||
    gross.toString() !== row.actual_gross ||
    cost.toString() !== row.execution_cost ||
    paidBase.toString() !== row.actual_base_fee ||
    paidBase.toString() !== row.base_fee_atoms ||
    (paidTotal - paidBase).toString() !== row.actual_improvement_fee ||
    payout.toString() !== row.buy_atoms ||
    sold.toString() !== row.sell_atoms ||
    paidTotal.toString() !== row.protocol_fee
  )
    throw Error('Realized amounts differ from finalized settlement');
  const source = meta.preTokenBalances?.find((b) => b.accountIndex === ix.accounts[6]);
  if (
    ((source || !(flags & 1)) &&
      (source?.owner !== base58.encode(row.wallet) || source.mint !== sell)) ||
    (buy !== SOL &&
      meta.postTokenBalances?.find((b) => b.accountIndex === end.accounts[6])?.mint !== buy)
  )
    throw Error('On-chain actual-output owner or mint mismatch');
  const inner = meta.innerInstructions?.find((group) => group.index === finishIndex);
  const actions = (inner?.instructions ?? []).filter((action) => (action.stackHeight ?? 2) === 2);
  let next = 0;
  // Positions below refer to FinishActual's account list, including the two mint slots for checked transfers.
  function take(program: string, ...positions: number[]) {
    const action = actions[next++];
    if (
      !action ||
      keys[action.programIdIndex] !== program ||
      action.accounts.length !== positions.length ||
      positions.some((position, i) => action.accounts[i] !== a[position])
    )
      throw Error('Settlement transfer accounts differ from receipt');
    return Buffer.from(base58.decode(action.data));
  }
  function transfer(
    program: string,
    from: number,
    to: number,
    authority: number,
    mint: number,
    amount: bigint,
  ) {
    const data = checked
      ? take(program, from, mint, to, authority)
      : take(program, from, to, authority);
    if (
      data.length !== (checked ? 10 : 9) ||
      data[0] !== (checked ? 12 : 3) ||
      data.readBigUInt64LE(1) !== amount
    )
      throw Error('Settlement token transfer differs from receipt');
  }
  function close(program: string, from: number, to: number, authority: number) {
    if (!take(program, from, to, authority).equals(Buffer.from([9])))
      throw Error('Missing token account close');
  }
  function transferSol(to: number, amount?: bigint) {
    const data = take(SOL, 8, to);
    if (
      data.length !== 12 ||
      data.readUInt32LE() !== 2 ||
      (amount === undefined ? data.readBigUInt64LE(4) === 0n : data.readBigUInt64LE(4) !== amount)
    )
      throw Error('Settlement SOL transfer differs from receipt');
  }
  if (sold < pulled) transfer(sellProgram!, 9, 10, 7, 11, pulled - sold);
  if (flags & 2) close(sellProgram!, 9, 8, 7);
  if (flags & 1) close(SPL_TOKEN, 10, 8, 8);
  if (buy === SOL) {
    close(SPL_TOKEN, 4, nativeFee ? 8 : 5, 3);
    if (nativeFee) transferSol(7); // Rent returned to the solver after unwrapping gross SOL into the wallet.
  } else {
    transfer(buyProgram!, 4, 6, 3, 12, payout);
    // Earlier bought-token settlements also emitted a transfer when the fee rounded to zero.
    if (gross > payout || (!nativeFee && actions.length - next === 2))
      transfer(buyProgram!, 4, 5, 3, 12, gross - payout);
    close(buyProgram!, 4, 7, 3);
  }
  if (nativeFee && paidTotal > 0n) transferSol(5, paidTotal);
  if (next !== actions.length) throw Error('Unexpected settlement transfer');
}

function receiptTime(row: Fill, receipt: Receipt | null): number {
  if (
    !receipt ||
    !receipt.meta ||
    receipt.meta.err !== null ||
    receipt.slot !== Number(row.slot) ||
    !receipt.blockTime ||
    !Number.isSafeInteger(receipt.blockTime) ||
    receipt.transaction.signatures[0] !== base58.encode(row.tx_signature)
  )
    throw Error('Unverified Solana reporting receipt');
  const { message } = receipt.transaction;
  const loaded = receipt.meta.loadedAddresses;
  const keys = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const ix = message.instructions[row.instruction_index];
  if (!ix || keys[ix.programIdIndex] !== PROGRAM || keys[ix.accounts[2]!] !== STATE)
    throw Error('Mainnet BeginSettle program/state mismatch');
  const begin = Buffer.from(base58.decode(ix.data));
  if (begin[0] === 13) {
    if (begin.length < 13) throw Error('Invalid BeginActual layout');
    verifyActual(row, receipt, keys, begin, ix);
    return receipt.blockTime;
  }
  if (
    [row.actual_gross, row.execution_cost, row.actual_base_fee, row.actual_improvement_fee].some(
      (v) => v !== null,
    )
  )
    throw Error('Actual-output amounts require a finalized V3 receipt');
  const n = begin[11] ?? 0;
  if (begin[0] !== 0 || n === 0 || begin.length < 12 + n) throw Error('Invalid BeginSettle layout');
  const finishIx = message.instructions[begin.readUInt16LE(1)];
  if (
    !finishIx ||
    keys[finishIx.programIdIndex] !== PROGRAM ||
    keys[finishIx.accounts[1]!] !== STATE
  )
    throw Error('Mainnet FinalizeSettle program/state mismatch');
  const finish = Buffer.from(base58.decode(finishIx.data));
  if (
    finish.length !== 3 + 9 * n ||
    finish[0] !== 1 ||
    finish.readUInt16LE(1) !== row.instruction_index
  )
    throw Error('Unpaired FinalizeSettle');
  // The on-chain ABI sorts PDAs. Each order has three fixed accounts plus one per
  // pull; FinalizeSettle has one output push for each order at the same position.
  const balances = [
    ...(receipt.meta.preTokenBalances ?? []),
    ...(receipt.meta.postTokenBalances ?? []),
  ];
  let account = 5,
    amountOffset = 12 + n;
  const orderAddress = base58.encode(row.order_pda);
  for (let i = 0; i < n; i++) {
    const count = begin[12 + i]!;
    if (keys[ix.accounts[account]!] === orderAddress) {
      const source = balances.find((b) => b.accountIndex === ix.accounts[account + 1] && b.owner);
      const destIndex = finishIx.accounts[4 + 3 * i + 1];
      const dest = balances.find((b) => b.accountIndex === destIndex);
      if (
        source?.owner !== base58.encode(row.wallet) ||
        source.mint !== base58.encode(row.sell_mint) ||
        (dest ? dest.mint !== base58.encode(row.buy_mint) : base58.encode(row.buy_mint) !== SOL)
      )
        throw Error('On-chain owner or mint mismatch');
      let sold = 0n;
      for (let j = 0; j < count; j++) sold += begin.readBigUInt64LE(amountOffset + 8 * j);
      if (
        sold !== BigInt(row.sell_atoms) ||
        finish.readBigUInt64LE(3 + n + 8 * i) !== BigInt(row.buy_atoms)
      )
        throw Error('On-chain settled amounts differ from orderbook');
      return receipt.blockTime;
    }
    account += 3 + count;
    amountOffset += 8 * count;
  }
  throw Error('Order PDA missing from settlement');
}

async function readPage(
  source: postgres.Sql,
  from: Cursor | null,
  until: string,
  hasActual: boolean,
): Promise<Fill[]> {
  // V21 predates these four columns. Never request the whole row from the column-scoped reader.
  const realized = hasActual
    ? source`t.actual_gross::text, t.execution_cost::text, t.actual_base_fee::text, t.actual_improvement_fee::text`
    : source`NULL::text AS actual_gross, NULL::text AS execution_cost, NULL::text AS actual_base_fee, NULL::text AS actual_improvement_fee`;
  return source<Fill[]>`
    WITH page AS MATERIALIZED (
      SELECT t.slot,t.tx_signature,t.instruction_index,t.order_uid,t.sell_amount,t.buy_amount,
             ${realized},
             o.sell_token_account AS user_source,o.buy_token_account AS user_destination,o.owner AS wallet, o.order_pda, o.sell_token AS sell_mint, o.buy_token AS buy_mint, o.kind, s.auction_id
      FROM solana.trades t LEFT JOIN solana.orders o ON o.uid=t.order_uid
      LEFT JOIN solana.settlements s USING (tx_signature,instruction_index)
      WHERE t.slot <= ${until} AND o.owner IS DISTINCT FROM ${Buffer.from(base58.decode(STATE))}
        AND (t.slot,t.tx_signature,t.instruction_index,t.order_uid) >
            (${from?.slot ?? '-1'}::bigint,decode(${from?.sig ?? ''},'hex'),${from?.ix ?? -1},decode(${from?.uid ?? ''},'hex'))
      ORDER BY t.slot,t.tx_signature,t.instruction_index,t.order_uid LIMIT ${PAGE}
    )
    SELECT t.auction_id::text,t.slot::text,t.tx_signature,t.instruction_index,t.order_uid,t.wallet,t.order_pda,t.sell_mint,t.buy_mint,t.kind,
      t.actual_gross,t.execution_cost,t.actual_base_fee,t.actual_improvement_fee,t.user_source,t.user_destination,f.fee_mint,
      t.sell_amount::text AS sell_atoms,t.buy_amount::text AS buy_atoms,f.protocol_fee::text,
      CASE WHEN t.actual_gross IS NOT NULL THEN t.actual_base_fee
        WHEN p.base_amount <= f.protocol_fee AND q.signed_fee_reference AND p.rate IN (0.0001,0.0005) AND f.protocol_fee >= 0
        AND f.fee_mint = CASE t.kind WHEN 'sell' THEN t.buy_mint ELSE t.sell_mint END
        AND p.policy_count = 2 AND p.volume_order < p.improvement_order
        AND (t.kind='sell' OR t.sell_amount >= f.protocol_fee)
        THEN p.base_amount::text
        END AS base_fee_atoms
    FROM page t LEFT JOIN solana.executed_protocol_fees f USING (tx_signature,instruction_index,order_uid)
    LEFT JOIN solana.order_quotes q ON q.order_uid=t.order_uid
    LEFT JOIN LATERAL (
      SELECT trunc(max(volume_factor::numeric) FILTER (WHERE kind='volume') *
               (CASE t.kind WHEN 'sell' THEN t.buy_amount+f.protocol_fee ELSE t.sell_amount-f.protocol_fee END)) AS base_amount,
             count(*) policy_count, max(volume_factor::numeric) FILTER (WHERE kind='volume') rate,
             max(application_order) FILTER (WHERE kind='volume') volume_order,
             max(application_order) FILTER (WHERE kind='priceimprovement' AND price_improvement_factor=0.5 AND price_improvement_max_volume_factor IN (0.002,0.0099)) improvement_order
      FROM solana.fee_policies WHERE auction_id=t.auction_id AND order_uid=t.order_uid
    ) p ON true
    ORDER BY t.slot,t.tx_signature,t.instruction_index,t.order_uid`;
}

const isStable = (token: string) => token === USDC || token === USDT;
type Price = typeof historicalCoinUsd;
async function prices(row: Fill, timestamp: number, price: Price) {
  const sell = base58.encode(row.sell_mint),
    buy = base58.encode(row.buy_mint);
  const sellAtoms = BigInt(row.sell_atoms),
    buyAtoms = BigInt(row.buy_atoms);
  const tradeFeeMint = row.kind === 'sell' ? buy : sell;
  const feeMint = row.fee_mint ? base58.encode(row.fee_mint) : tradeFeeMint;
  const quote = (mint: string, atoms: bigint) =>
    price(`solana:${mint === SOL ? WSOL : mint}`, atoms, timestamp).catch(() => null);
  let pricedSell = true;
  let valueUsd: number | null;
  if (isStable(sell)) valueUsd = Number(sellAtoms) / 1e6;
  else if (isStable(buy)) {
    pricedSell = false;
    valueUsd = Number(buyAtoms) / 1e6;
  } else {
    valueUsd = await quote(sell, sellAtoms);
    if (valueUsd === null) {
      pricedSell = false;
      valueUsd = await quote(buy, buyAtoms);
    }
  }
  let baseFeeUsd: number | null = null;
  if (row.base_fee_atoms !== null) {
    if (isStable(feeMint)) baseFeeUsd = Number(row.base_fee_atoms) / 1e6;
    else if (row.base_fee_atoms === '0') baseFeeUsd = 0;
    else if (feeMint !== tradeFeeMint)
      baseFeeUsd = await quote(feeMint, BigInt(row.base_fee_atoms));
    else if (valueUsd !== null) {
      // A cross-mint valuation uses the realized exchange rate before Ophis fees.
      // The indexed sell amount is gross and the buy amount is net.
      const fee = BigInt(row.protocol_fee!);
      const grossBuy = row.actual_gross === null ? buyAtoms + fee : BigInt(row.actual_gross);
      const feeSideAtoms =
        row.kind === 'sell'
          ? pricedSell
            ? grossBuy
            : buyAtoms
          : sellAtoms - (pricedSell ? 0n : fee);
      if (feeSideAtoms > 0n)
        baseFeeUsd = (valueUsd * Number(row.base_fee_atoms)) / Number(feeSideAtoms);
    }
  }
  return { valueUsd, baseFeeUsd };
}

type Sync = {
  tail: Cursor | null;
  repair: Cursor | null;
  covered_slot: string | null;
  covered_block_timestamp: Date | string | null;
};
export async function importSolanaFills(
  source: postgres.Sql,
  target: postgres.Sql,
  rpc: SolanaRpc,
  price = historicalCoinUsd,
) {
  return target.begin(async (tx) => {
    const [sync] = await tx<
      Sync[]
    >`SELECT * FROM solana_fill_sync WHERE singleton FOR UPDATE SKIP LOCKED`;
    if (!sync) return false;
    const [head] = await source<{ slot: string; has_actual: boolean }[]>`
      SELECT least(slot,finalized_slot)::text AS slot,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='solana.trades'::regclass
          AND attname='actual_gross' AND NOT attisdropped) AS has_actual
      FROM solana.indexer_state WHERE singleton
        AND EXISTS (SELECT 1 FROM solana.trades WHERE slot=473270143 AND tx_signature=${Buffer.from(base58.decode(ANCHOR))})`;
    if (!head || BigInt(head.slot) < BigInt(sync.covered_slot ?? 0))
      throw Error('Solana reporting source has incomplete mainnet history');
    const hasNewCoverage = head.slot !== sync.covered_slot;
    const hasActual = head.has_actual;
    const receipts = new Map<string, Receipt | null>();
    let verifiedGenesis = false;
    async function verifyCluster() {
      if (!verifiedGenesis && (await rpc('getGenesisHash', [])) !== GENESIS)
        throw Error('Wrong Solana reporting network');
      verifiedGenesis = true;
    }
    async function processPage(from: Cursor | null, until: string) {
      let cursor = from;
      const rows = await readPage(source, from, until, hasActual);
      for (const row of rows) {
        if (!row.order_pda || !row.wallet || row.auction_id === null)
          return { cursor, complete: false, stalled: true };
        const [known] = await tx<
          {
            block_timestamp: Date;
            value_usd: string | null;
            base_fee_atoms: string | null;
            base_fee_usd: string | null;
          }[]
        >`
          SELECT block_timestamp,value_usd,base_fee_atoms,base_fee_usd FROM solana_settled_fills
          WHERE tx_signature=${row.tx_signature} AND instruction_index=${row.instruction_index} AND order_uid=${row.order_uid}`;
        let timestamp = known ? Math.floor(new Date(known.block_timestamp).getTime() / 1000) : 0;
        const needsPricing =
          !known ||
          known.value_usd === null ||
          known.base_fee_atoms !== row.base_fee_atoms ||
          (row.base_fee_atoms !== null && known.base_fee_usd === null);
        if (
          !known ||
          (needsPricing &&
            (row.actual_gross !== null || known.base_fee_atoms !== row.base_fee_atoms))
        ) {
          try {
            await verifyCluster();
            const sig = base58.encode(row.tx_signature);
            if (!receipts.has(sig))
              receipts.set(
                sig,
                await rpc('getTransaction', [
                  sig,
                  { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 1 },
                ]),
              );
            timestamp = receiptTime(row, receipts.get(sig)!);
          } catch (err) {
            // Keep prior verified rows and retry from this exact point next tick.
            logger.warn(
              { slot: row.slot, reason: err instanceof Error ? err.message : 'RPC unavailable' },
              'Solana fill awaiting verification',
            );
            return { cursor, complete: false, stalled: true };
          }
        }
        if (needsPricing) {
          const { valueUsd, baseFeeUsd } = await prices(row, timestamp, price);
          await tx`INSERT INTO solana_settled_fills
            (tx_signature,instruction_index,order_uid,slot,block_timestamp,wallet,sell_mint,buy_mint,sell_atoms,buy_atoms,value_usd,base_fee_atoms,base_fee_usd)
            VALUES (${row.tx_signature},${row.instruction_index},${row.order_uid},${row.slot},to_timestamp(${timestamp}),${row.wallet},
                    ${row.sell_mint},${row.buy_mint},${row.sell_atoms},${row.buy_atoms},${valueUsd},${row.base_fee_atoms},${baseFeeUsd})
            ON CONFLICT (tx_signature,instruction_index,order_uid) DO UPDATE SET
              value_usd=COALESCE(solana_settled_fills.value_usd,excluded.value_usd),
              base_fee_atoms=excluded.base_fee_atoms,base_fee_usd=excluded.base_fee_usd`;
        }
        cursor = {
          slot: row.slot,
          sig: row.tx_signature.toString('hex'),
          ix: row.instruction_index,
          uid: row.order_uid.toString('hex'),
        };
      }
      return { cursor, complete: rows.length < PAGE, stalled: false };
    }

    const tail = await processPage(sync.tail, head.slot);
    const repair =
      sync.covered_slot && tail.complete
        ? await processPage(sync.repair, sync.covered_slot)
        : { complete: false, cursor: sync.repair, stalled: false };
    // The shared Drizzle client uses transparent JSON/time serializers. Bind text
    // explicitly so a stopped page commits the same cursor in the service and on replay.
    await tx`UPDATE solana_fill_sync SET tail=${tail.cursor && JSON.stringify(tail.cursor)}::text::jsonb,
      repair=${!repair.complete && repair.cursor ? JSON.stringify(repair.cursor) : null}::text::jsonb`;
    if (tail.stalled || repair.stalled) return false;
    if (!tail.complete) return true;
    let coveredTime = sync.covered_block_timestamp;
    if (hasNewCoverage) {
      try {
        await verifyCluster();
        const finalized = await rpc<number>('getSlot', [{ commitment: 'finalized' }]);
        if (!Number.isSafeInteger(finalized) || finalized < Number(head.slot))
          throw Error('Solana reporting RPC behind source');
        // An indexed boundary may be a skipped slot. Use the latest produced block at or below it.
        const headNumber = Number(head.slot);
        const blocks = await rpc<number[]>('getBlocks', [
          Math.max(0, headNumber - 64),
          headNumber,
          { commitment: 'finalized' },
        ]);
        const last = blocks.at(-1);
        if (last === undefined || last > headNumber || last < headNumber - 64)
          throw Error('No finalized block at boundary');
        const unix = await rpc<number | null>('getBlockTime', [last]);
        if (!unix || !Number.isSafeInteger(unix)) throw Error('Finalized slot time unavailable');
        coveredTime = new Date(unix * 1000);
      } catch (err) {
        logger.warn(
          { slot: head.slot, reason: err instanceof Error ? err.message : 'RPC unavailable' },
          'Solana coverage awaiting verification',
        );
        return false;
      }
    }
    await tx`UPDATE solana_fill_sync SET covered_slot=${head.slot},covered_block_timestamp=${coveredTime && new Date(coveredTime).toISOString()}::text::timestamptz,checked_at=now()`;
    return false;
  });
}

export function startSolanaReporting() {
  const url = process.env.SOLANA_REPORTING_DATABASE_URL;
  if (!url) return;
  const source = postgres(url, {
    path: process.env.SOLANA_REPORTING_SOCKET || undefined,
    max: 1,
    connect_timeout: 5,
    idle_timeout: 30,
    connection: { default_transaction_read_only: true, statement_timeout: 8000 },
  });
  const rpc = reportingRpc(
    process.env.SOLANA_REPORTING_RPC_URL || 'https://api.mainnet-beta.solana.com',
  );
  async function tick() {
    let next = 60_000;
    try {
      const { sql } = await import('../db/index.js');
      if (await importSolanaFills(source, sql, rpc)) next = 250;
    } catch (err) {
      // A connection error can contain the private DSN. Log only the error class and SQLSTATE.
      logger.error(
        { kind: err instanceof Error ? err.name : 'Error', code: (err as { code?: string }).code },
        'Solana reporting failed',
      );
    } finally {
      setTimeout(() => void tick(), next).unref();
    }
  }
  void tick();
}
