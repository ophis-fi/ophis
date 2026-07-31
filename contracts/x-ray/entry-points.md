# Ophis Mutating Entry Points

| Contract | Entry point | Effective caller | Value / authority effect |
|---|---|---|---|
| AllowListGuardian | `addSolver` | timelock | Adds Settlement execution capability |
| AllowListGuardian | `setManager` | timelock | Transfers authenticator management |
| AllowListGuardian | `setGuardian` | timelock | Rotates emergency remover |
| AllowListGuardian | `removeSolver` | guardian | Removes Settlement execution capability |
| GPv2AllowListAuthentication | `initializeManager` | first caller before initialization | Initializes manager |
| GPv2AllowListAuthentication | `setManager` | manager or proxy admin | Immediate manager transfer |
| GPv2AllowListAuthentication | `proposeManager` | manager or proxy admin | Starts two-step transfer |
| GPv2AllowListAuthentication | `acceptManagership` | pending manager | Completes two-step transfer |
| GPv2AllowListAuthentication | `cancelManagerTransfer` | manager or proxy admin | Cancels pending transfer |
| GPv2AllowListAuthentication | `addSolver` / `removeSolver` | manager | Changes solver capability |
| OphisFeeLiquidator | `setLiquidator` | owner | Rotates/pauses hot key |
| OphisFeeLiquidator | `setVenue` | owner | Changes callable venues |
| OphisFeeLiquidator | `setOutputToken` | owner | Changes allowed outputs |
| OphisFeeLiquidator | `sweep` | liquidator or owner | Settlement → immutable fee Safe |
| OphisFeeLiquidator | `consolidate` | owner | Exact approvals, venue call, output check |
| OphisVaultPolicyModuleFactory | `deploy` | permissionless | Deploys immutable policy module |
| OphisVaultPolicyModule | `rebalance` | curator plus dynamic no-owner/no-module gate | Safe allowance + CoW presignature |
| OphisVaultPolicyModule | `cancel` | curator plus dynamic no-owner/no-module gate | Revokes presignature and allowance |
| GPv2Settlement | `settle` / `swap` | authenticated solver | Moves user/Safe assets under signed orders |
| GPv2Settlement | `invalidateOrder` | UID owner | Permanently fills UID sentinel |
| GPv2Settlement | `setPreSignature` | UID owner | Toggles presignature |
| GPv2Settlement | `freeFilledAmountStorage` / `freePreSignatureStorage` | Settlement self-interaction | Clears expired storage |
| GPv2VaultRelayer | `transferFromAccounts` / `batchSwapWithFee` | immutable Settlement creator | Pulls funds / executes Vault swaps |

Permissionless simulation entry points are omitted from the table because their inner delegatecall always reverts and therefore cannot persist state.
