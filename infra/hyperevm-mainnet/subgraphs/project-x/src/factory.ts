// Factory event handler.
//
// On PoolCreated:
//   1. Create both Token entities (if not seen before) by reading
//      symbol/name/decimals from the ERC-20.
//   2. Create the Pool entity with feeTier + tickSpacing + zero state.
//   3. Spawn a Pool template data source so all the Pool's own events
//      are indexed going forward.
//
// We do NOT pre-populate liquidity/sqrtPrice/tick — those land later via
// Initialize and Swap events on the Pool template.

import { BigInt, Address, log } from "@graphprotocol/graph-ts";
import { PoolCreated } from "../generated/Factory/Factory";
import { Pool as PoolTemplate } from "../generated/templates";
import { Pool, Token } from "../generated/schema";
import { ERC20 } from "../generated/Factory/ERC20";

export function handlePoolCreated(event: PoolCreated): void {
  let token0 = getOrCreateToken(event.params.token0);
  let token1 = getOrCreateToken(event.params.token1);

  // Defensive: if either token failed all ERC-20 reads (very rare — broken
  // token contract), skip pool creation. Pool exists on-chain but is unsafe
  // to surface to the solver without decimals.
  if (token0 === null || token1 === null) {
    log.warning("skipping pool {} — token metadata unreadable for {} or {}", [
      event.params.pool.toHexString(),
      event.params.token0.toHexString(),
      event.params.token1.toHexString(),
    ]);
    return;
  }

  let pool = new Pool(event.params.pool.toHexString());
  pool.token0 = token0.id;
  pool.token1 = token1.id;
  pool.feeTier = BigInt.fromI32(event.params.fee);
  pool.tickSpacing = BigInt.fromI32(event.params.tickSpacing);
  pool.liquidity = BigInt.zero();
  pool.sqrtPrice = BigInt.zero();
  // pool.tick deliberately not set — kept null until Initialize fires. The CoW
  // driver's query filters `tick_not: null` to skip uninitialized pools.
  pool.createdAtBlock = event.block.number;
  pool.save();

  // Spawn the Pool template so we start indexing per-pool events.
  PoolTemplate.create(event.params.pool);
}

function getOrCreateToken(addr: Address): Token | null {
  let id = addr.toHexString();
  let token = Token.load(id);
  if (token !== null) {
    return token;
  }

  let contract = ERC20.bind(addr);

  // symbol/name/decimals via try_ variants — some HL tokens return bytes32
  // instead of string for these (legacy MakerDAO-style); try_ catches the
  // revert/decode failure and we fall through to fallback strings.
  let symbolResult = contract.try_symbol();
  let nameResult = contract.try_name();
  let decimalsResult = contract.try_decimals();

  if (decimalsResult.reverted) {
    // No decimals is a real blocker — the solver can't safely scale amounts.
    return null;
  }

  token = new Token(id);
  token.symbol = symbolResult.reverted ? "UNKNOWN" : symbolResult.value;
  token.name = nameResult.reverted ? "Unknown Token" : nameResult.value;
  token.decimals = BigInt.fromI32(decimalsResult.value);
  token.save();
  return token;
}
