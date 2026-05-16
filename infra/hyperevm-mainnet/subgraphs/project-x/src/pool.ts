// Pool template event handlers.
//
// Maintains the pool's slot0-equivalent state (sqrtPrice, tick, liquidity)
// + per-tick liquidityNet/Gross aggregates. The CoW driver reads slot0
// from on-chain at swap time, so this subgraph just maintains the data
// it needs for *pool discovery and offline tick analysis* — not real-time
// state guarantees.

import { BigInt, Address, log } from "@graphprotocol/graph-ts";
import {
  Initialize,
  Swap,
  Mint,
  Burn,
} from "../generated/templates/Pool/Pool";
import { Pool, Tick } from "../generated/schema";

export function handleInitialize(event: Initialize): void {
  let pool = Pool.load(event.address.toHexString());
  if (pool === null) {
    log.warning("Initialize on unknown pool {}", [event.address.toHexString()]);
    return;
  }
  pool.sqrtPrice = event.params.sqrtPriceX96;
  pool.tick = BigInt.fromI32(event.params.tick);
  pool.save();
}

export function handleSwap(event: Swap): void {
  let pool = Pool.load(event.address.toHexString());
  if (pool === null) {
    log.warning("Swap on unknown pool {}", [event.address.toHexString()]);
    return;
  }
  pool.sqrtPrice = event.params.sqrtPriceX96;
  pool.tick = BigInt.fromI32(event.params.tick);
  pool.liquidity = event.params.liquidity;
  pool.save();
}

export function handleMint(event: Mint): void {
  let pool = Pool.load(event.address.toHexString());
  if (pool === null) {
    log.warning("Mint on unknown pool {}", [event.address.toHexString()]);
    return;
  }

  // If the mint touches the active tick range, bump the pool-level liquidity.
  // The CoW driver uses pool.liquidity for the active-tick depth; this keeps
  // it consistent between Swap-driven updates.
  let amount = event.params.amount;
  if (
    pool.tick !== null &&
    BigInt.fromI32(event.params.tickLower).le(pool.tick as BigInt) &&
    pool.tick !== null &&
    (pool.tick as BigInt).lt(BigInt.fromI32(event.params.tickUpper))
  ) {
    pool.liquidity = pool.liquidity.plus(amount);
    pool.save();
  }

  // Update tick entities: liquidityGross goes up at both endpoints;
  // liquidityNet goes +amount at the lower bound and -amount at the upper.
  upsertTick(
    pool,
    event.params.tickLower,
    amount, // +liquidityNet on the lower bound
    amount, // +liquidityGross on both
  );
  upsertTick(pool, event.params.tickUpper, amount.neg(), amount);
}

export function handleBurn(event: Burn): void {
  let pool = Pool.load(event.address.toHexString());
  if (pool === null) {
    log.warning("Burn on unknown pool {}", [event.address.toHexString()]);
    return;
  }

  let amount = event.params.amount;
  if (
    pool.tick !== null &&
    BigInt.fromI32(event.params.tickLower).le(pool.tick as BigInt) &&
    pool.tick !== null &&
    (pool.tick as BigInt).lt(BigInt.fromI32(event.params.tickUpper))
  ) {
    pool.liquidity = pool.liquidity.minus(amount);
    pool.save();
  }

  upsertTick(pool, event.params.tickLower, amount.neg(), amount.neg());
  upsertTick(pool, event.params.tickUpper, amount, amount.neg());
}

// Atomically upsert tick liquidity. Ticks that net out to zero stay in the
// store (we don't delete) — the CoW driver filters `liquidityNet_not: "0"`
// in its query so they cost only a row but no query overhead.
function upsertTick(
  pool: Pool,
  tickIdx: i32,
  netDelta: BigInt,
  grossDelta: BigInt,
): void {
  let id = pool.id + "#" + tickIdx.toString();
  let tick = Tick.load(id);
  if (tick === null) {
    tick = new Tick(id);
    tick.pool = pool.id;
    tick.poolAddress = pool.id;
    tick.tickIdx = BigInt.fromI32(tickIdx);
    tick.liquidityNet = BigInt.zero();
    tick.liquidityGross = BigInt.zero();
  }
  tick.liquidityNet = tick.liquidityNet.plus(netDelta);
  tick.liquidityGross = tick.liquidityGross.plus(grossDelta);
  tick.save();
}
