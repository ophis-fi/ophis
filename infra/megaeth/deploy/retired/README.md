# Retired deploy scripts

Scripts here were superseded by Spec-level design changes. Kept for git-history convenience but no longer invoked.

## `seed-mainnet-pool.sh`

Retired 2026-05-12 as part of Spec 3 finalization. The original plan was to seed a Ophis-deployed UniswapV2 pool with WETH + USDT0 on MegaETH mainnet to bootstrap day-1 liquidity. Spec 3 switched to routing through Kumbaya (MegaETH's dominant UniswapV3-fork DEX, ~$53M TVL) instead, removing the need to provide our own liquidity.

If MegaETH's DEX ecosystem somehow regresses (Kumbaya dies, no replacement) and we need to bootstrap our own pool, this script is still functional — restore it from this folder and re-add the V2 deploy section to `deploy-mainnet-all.sh`.
