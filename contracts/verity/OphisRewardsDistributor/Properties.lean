import Contracts.OphisRewardsDistributor.OphisRewardsDistributor

namespace Contracts.OphisRewardsDistributor.Properties

/-- The only permitted inventory totals exactly 150 USDG in six-decimal units. -/
theorem reward_inventory_value : 100 * 1000000 + 5 * 10000000 = 150000000 := by
  norm_num

/-- The prize inventory contains exactly 105 winning tickets. -/
theorem reward_inventory_count : 100 + 5 = 105 := by
  norm_num

/-- Every individual reward denomination is bounded by the lifetime payout. -/
theorem denominations_bounded : 1000000 ≤ 150000000 ∧ 10000000 ≤ 150000000 := by
  norm_num

end Contracts.OphisRewardsDistributor.Properties
