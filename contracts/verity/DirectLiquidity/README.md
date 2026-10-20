# Direct liquidity arithmetic

`Properties.lean` checks eight numeric properties using Verity's `Uint256` and
Lean's kernel: output floors do not inflate quotes, respect the 2000 bps cap,
preserve zero-slippage quotes, fit in uint256, use a numerator fitting uint512,
and cover the driver's rounded-up clearing-price payout when delivery meets
the enforced minimum. Metric's uint128 quote bound also keeps its checked
uint256 numerator within range.

The formulas correspond to Metric's inline checked uint256 floor, Curve's
`subtract_slippage`, Elfomo's U512 floor, and `required_custom_amounts` in the driver. Rust checks
overflow and a nonzero denominator before computing the ceiling. The model
does not prove Rust/model equivalence, ABI decoding, RPC honesty, pool behavior,
simulation correctness or bytecode compiler preservation. Those need the
implementation review and executable tests; success here is a numeric
specification check, not a formal proof of the whole integration.

Using the existing framework pinned in `../README.md` at
`98533b72d2c93546e135d6b9e3aac08c5dbc06a8` (Lean 4.31.0):

```sh
cd /path/to/verity
lake env lean /path/to/ophis/contracts/verity/DirectLiquidity/Properties.lean
```

The file prints each theorem's axiom dependencies. No `sorry`, `admit` or custom
axiom is permitted. The existing `AllowListGuardian` model remains a separate
access-control regression check.
