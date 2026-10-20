import Verity.Stdlib.Math

/-!
Numeric specification of the direct-liquidity output floors. This is not a
translation proof of Rust or external pool bytecode. Rust rejects overflowing
clearing-price products before applying the ceiling formula modeled here.
-/
namespace Ophis.DirectLiquidity

open Verity

/-- The connectors' integer floor, after the 2000 bps cap. -/
def quoteFloor (quote : Uint256) (bps : Nat) : Nat :=
  quote.val * (10000 - min bps 2000) / 10000

theorem quoteFloor_never_exceeds_quote (quote : Uint256) (bps : Nat) :
    quoteFloor quote bps ≤ quote.val := by
  have h := Nat.mul_le_mul_left quote.val (Nat.sub_le 10000 (min bps 2000))
  have hd := Nat.div_le_div_right (c := 10000) h
  simpa [quoteFloor, Nat.mul_div_cancel _ (by decide : 0 < 10000)] using hd

theorem quoteFloor_respects_twenty_percent_cap (quote : Uint256) (bps : Nat) :
    quote.val * 8000 / 10000 ≤ quoteFloor quote bps := by
  have hm : min bps 2000 ≤ 2000 := Nat.min_le_right _ _
  have hs : 8000 ≤ 10000 - min bps 2000 := by omega
  exact Nat.div_le_div_right (Nat.mul_le_mul_left quote.val hs)

theorem quoteFloor_zero_slippage (quote : Uint256) :
    quoteFloor quote 0 = quote.val := by
  simp [quoteFloor]

theorem quoteFloor_fits_u256 (quote : Uint256) (bps : Nat) :
    quoteFloor quote bps < Verity.Core.UINT256_MODULUS :=
  Nat.lt_of_le_of_lt (quoteFloor_never_exceeds_quote quote bps) quote.isLt

set_option maxRecDepth 4096 in
set_option exponentiation.threshold 1024 in
theorem quote_numerator_fits_u512 (quote : Uint256) :
    quote.val * 10000 < 2 ^ 512 := by
  have h := Nat.mul_lt_mul_of_pos_right quote.isLt (by decide : 0 < 10000)
  exact Nat.lt_trans h (by decide)

/-- Metric rejects quotes above uint128 before its checked uint256 multiply. -/
theorem metric_numerator_fits_u256 (quote : Uint256) (h : quote.val < 2 ^ 128) :
    quote.val * 10000 < Verity.Core.UINT256_MODULUS := by
  have hm := Nat.mul_lt_mul_of_pos_right h (by decide : 0 < 10000)
  exact Nat.lt_trans hm (by decide)

/-- Driver `required_custom_amounts`: quotient plus one for a nonzero remainder. -/
def requiredOutput (numerator denominator : Nat) : Nat :=
  numerator / denominator + if numerator % denominator = 0 then 0 else 1

/-- Settlement's ceil payout is fully covered, with less than one denominator
    unit of over-rounding. No fixed-rate assumption about either token is used. -/
theorem requiredOutput_is_ceiling (numerator denominator : Nat) (hd : 0 < denominator) :
    numerator ≤ requiredOutput numerator denominator * denominator ∧
    requiredOutput numerator denominator * denominator < numerator + denominator := by
  have heq := Nat.mod_add_div numerator denominator
  rw [Nat.mul_comm denominator (numerator / denominator)] at heq
  have hmod := Nat.mod_lt numerator hd
  by_cases hz : numerator % denominator = 0
  · simp only [requiredOutput, hz, ite_true, Nat.add_zero]
    omega
  · simp only [requiredOutput, hz, ite_false, Nat.add_mul, Nat.one_mul]
    omega

/-- Once the driver binds its minimum to the ceiling, a pool meeting that
    minimum covers the actual clearing-price payout. Delivery itself is checked
    by swap simulation and onchain minimum output, not proved by this model. -/
theorem guarded_output_covers_clearing (numerator denominator minimum received : Nat)
    (hd : 0 < denominator)
    (hmin : requiredOutput numerator denominator ≤ minimum)
    (hreceived : minimum ≤ received) :
    numerator ≤ received * denominator := by
  exact Nat.le_trans (requiredOutput_is_ceiling numerator denominator hd).1
    (Nat.mul_le_mul_right denominator (Nat.le_trans hmin hreceived))

#print axioms quoteFloor_never_exceeds_quote
#print axioms quoteFloor_respects_twenty_percent_cap
#print axioms quoteFloor_zero_slippage
#print axioms quoteFloor_fits_u256
#print axioms quote_numerator_fits_u512
#print axioms metric_numerator_fits_u256
#print axioms requiredOutput_is_ceiling
#print axioms guarded_output_covers_clearing

end Ophis.DirectLiquidity
