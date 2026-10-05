import { Dispatch, SetStateAction, useEffect, useState } from 'react'

import { BY, FEE, SETS, units, usd, Coin } from './AssetSwap.demo.const'

export interface AssetSwapDemoState {
  coins: [string, string]
  pick: number | null
  lifted: number | null
  turns: number
  payer: number
  set: { list: Coin[]; start: [string, string] }
  setPick: Dispatch<SetStateAction<number | null>>
  setLifted: Dispatch<SetStateAction<number | null>>
  setTurns: Dispatch<SetStateAction<number>>
  shown: (index: number) => { amount: string; fiat: string }
  open: (index: number) => void
  choose: (symbol: string) => void
}

export function useAssetSwapDemo(assets: string): AssetSwapDemoState {
  /* the coin in each slab, top then bottom */
  const set = SETS[assets] ?? SETS.Crypto
  const [coins, setCoins] = useState<[string, string]>(set.start)
  /* how many presses so far: even, the arrow points down */
  const [turns, setTurns] = useState(0)
  /* which slab is open as the picker */
  const [pick, setPick] = useState<number | null>(null)
  /* which slab is drawn over everything: the open one, and it stays
     on top until it has finished shrinking back, or it would slip
     under its neighbour halfway home */
  const [lifted, setLifted] = useState<number | null>(null)
  /* a new set is a new start: its own pair, the picker shut */
  useEffect(() => {
    setCoins(set.start)
    setPick(null)
    setLifted(null)
  }, [set])
  const payer = turns % 2 === 1 ? 1 : 0
  /* what each slab reads: the payer its coin's lot, the other what
     that lot buys after the fee, each with its own dollar value */
  const paid = BY[coins[payer]]
  const value = paid.lot * paid.price
  const shown = (i: number): { amount: string; fiat: string } => {
    const c = BY[coins[i]]
    const v = i === payer ? value : value * (1 - FEE)
    return { amount: units(i === payer ? c.lot : v / c.price, c), fiat: usd(v) }
  }

  const open = (slot: number): void => {
    setPick(slot)
    setLifted(slot)
  }

  const choose = (sym: string): void => {
    if (pick === null) return
    const slot = pick,
      other = 1 - pick
    setCoins((c) => {
      const next: [string, string] = [c[0], c[1]]
      /* the coin already on the other slab trades places with this one */
      if (c[other] === sym) next[other] = c[slot]
      next[slot] = sym
      return next
    })
    setPick(null)
  }

  return { coins, pick, lifted, turns, payer, set, setPick, setLifted, setTurns, shown, open, choose }
}
