// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "src/contracts/libraries/GPv2Order.sol";
import {OphisChainlinkFloor} from "src/contracts/vault/OphisChainlinkFloor.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

import {MockERC20, MockFeed, MockSafe, MockSettlement, MockUSDT} from "./Mocks.sol";

contract OphisVaultPolicyModuleTest is Test {
    uint256 internal constant T0 = 1_000_000_000;
    bytes32 internal constant APP_DATA = keccak256("ophis-partner-fee-appdata");
    address internal constant RELAYER = address(0xBEEF00000000000000000000000000000000BEEf);
    address internal constant CURATOR = address(0xCA11);
    address internal constant SAFE_OWNER = address(0xA11CE);
    uint256 internal constant BIG_CAP = 1_000_000e18; // non-interfering default
    uint256 internal constant STALENESS = 3600;
    uint256 internal constant USD_MIN = 25e16;
    uint256 internal constant USD_MAX = 4e18;
    uint256 internal constant ETH_MIN = 500e18;
    uint256 internal constant ETH_MAX = 8000e18;

    MockSafe internal safe;
    MockSettlement internal settlement;
    MockERC20 internal usdc; // 6 dec, $1
    MockERC20 internal weth; // 18 dec, $2000
    MockUSDT internal usdt; // 6 dec, $1, USDT-style approve
    MockFeed internal usdcFeed;
    MockFeed internal wethFeed;
    MockFeed internal usdtFeed;
    OphisVaultPolicyModule internal module;

    // 1000 USDC -> WETH @ $2000, 50 bps band = 0.4975 WETH.
    uint256 internal constant EXPECTED_FLOOR = 4975e14;

    function setUp() public {
        vm.warp(T0);
        address[] memory owners = new address[](1);
        owners[0] = SAFE_OWNER;
        safe = new MockSafe(owners);
        settlement = new MockSettlement(keccak256("test domain"), RELAYER);
        usdc = new MockERC20(6);
        weth = new MockERC20(18);
        usdt = new MockUSDT(6);
        usdcFeed = new MockFeed(8, 1e8, T0);
        wethFeed = new MockFeed(8, 2000e8, T0);
        usdtFeed = new MockFeed(8, 1e8, T0);
        module = new OphisVaultPolicyModule(baseConfig());
        safe.setEnabledModule(address(module));
    }

    function tokenFeeds()
        internal
        view
        returns (OphisVaultPolicyModule.TokenFeed[] memory tokens)
    {
        tokens = new OphisVaultPolicyModule.TokenFeed[](3);
        tokens[0] = tokenFeed(address(usdc), usdcFeed, USD_MIN, USD_MAX);
        tokens[1] = tokenFeed(address(weth), wethFeed, ETH_MIN, ETH_MAX);
        tokens[2] = tokenFeed(address(usdt), usdtFeed, USD_MIN, USD_MAX);
    }

    function tokenFeed(
        address token,
        MockFeed feed,
        uint256 minPrice18,
        uint256 maxPrice18
    ) internal pure returns (OphisVaultPolicyModule.TokenFeed memory) {
        return
            OphisVaultPolicyModule.TokenFeed({
                token: token,
                feed: IAggregatorV3(address(feed)),
                maxStaleness: STALENESS,
                minPrice18: minPrice18,
                maxPrice18: maxPrice18
            });
    }

    function baseConfig()
        internal
        view
        returns (OphisVaultPolicyModule.ModuleConfig memory cfg)
    {
        cfg = OphisVaultPolicyModule.ModuleConfig({
            safe: ISafe(address(safe)),
            settlement: IGPv2Settlement(address(settlement)),
            curator: CURATOR,
            appDataHash: APP_DATA,
            maxSlippageBps: 50,
            maxTtl: 1800,
            dailyUsdTurnoverCap: BIG_CAP,
            sequencerUptimeFeed: IAggregatorV3(address(0)),
            allowNoSequencerFeed: true,
            sequencerGracePeriod: 0,
            tokens: tokenFeeds()
        });
    }

    function validOrder() internal view returns (GPv2Order.Data memory) {
        return GPv2Order.Data({
            sellToken: IERC20(address(usdc)),
            buyToken: IERC20(address(weth)),
            receiver: address(safe),
            sellAmount: 1000e6,
            buyAmount: 5e17,
            validTo: uint32(block.timestamp + 1800),
            appData: APP_DATA,
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
    }

    function rebalanceAsCurator(
        GPv2Order.Data memory order,
        uint256 minBuyOverride
    ) internal returns (bytes memory) {
        vm.prank(CURATOR);
        return module.rebalance(order, minBuyOverride);
    }

    function refreshFeeds() internal {
        usdcFeed.set(1e8, block.timestamp);
        wethFeed.set(2000e8, block.timestamp);
        usdtFeed.set(1e8, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Happy path (invariants B0/B5/B6 positive side)
    // ------------------------------------------------------------------

    function test_happy_path_presigns_with_exact_allowance() public {
        bytes memory uid = rebalanceAsCurator(validOrder(), 0);
        assertEq(uid.length, GPv2Order.UID_LENGTH);
        // MockSettlement enforces uid.owner == msg.sender (real GPv2
        // semantics), so this passing proves the uid embeds the Safe.
        assertEq(settlement.preSignature(uid), settlement.PRE_SIGNED());
        assertEq(usdc.allowance(address(safe), RELAYER), 1000e6); // exact, never MaxUint
        assertEq(module.moduleOrderSellToken(keccak256(uid)), address(usdc));
    }

    function test_uid_matches_local_derivation() public {
        GPv2Order.Data memory order = validOrder();
        bytes memory uid = rebalanceAsCurator(order, 0);
        bytes32 digest = GPv2Order.hash(order, settlement.domainSeparator());
        bytes memory expected = new bytes(GPv2Order.UID_LENGTH);
        GPv2Order.packOrderUidParams(expected, digest, address(safe), order.validTo);
        assertEq(uid, expected);
    }

    // ------------------------------------------------------------------
    // Oracle floor (B1, B8)
    // ------------------------------------------------------------------

    function test_floor_math_is_exact() public {
        GPv2Order.Data memory order = validOrder();
        order.buyAmount = EXPECTED_FLOOR; // exactly at the floor: accepted
        rebalanceAsCurator(order, 0);
    }

    function test_below_floor_reverts() public {
        GPv2Order.Data memory order = validOrder();
        order.buyAmount = EXPECTED_FLOOR - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.BelowFloor.selector,
                EXPECTED_FLOOR - 1,
                EXPECTED_FLOOR
            )
        );
        rebalanceAsCurator(order, 0);
    }

    function test_min_buy_override_tightens_but_never_loosens() public {
        GPv2Order.Data memory order = validOrder();
        order.buyAmount = 6e17;
        // Override above the buyAmount: rejected even though the oracle
        // floor alone would pass.
        vm.expectRevert(
            abi.encodeWithSelector(OphisVaultPolicyModule.BelowFloor.selector, 6e17, 7e17)
        );
        rebalanceAsCurator(order, 7e17);
        // Override below the oracle floor: the oracle floor still rules.
        order.buyAmount = EXPECTED_FLOOR - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.BelowFloor.selector,
                EXPECTED_FLOOR - 1,
                EXPECTED_FLOOR
            )
        );
        rebalanceAsCurator(order, 1);
        // Override between floor and buyAmount: accepted.
        order.buyAmount = 6e17;
        rebalanceAsCurator(order, 55e16);
    }

    function test_zero_oracle_floor_reverts_regardless_of_override() public {
        // Make a base-unit of the buy token worth more than the whole sell
        // order so oracleFloor truncates to 0. WBTC-style: 2 decimals, huge
        // price. Selling 1 unit of a 2-dec $1 token into that yields floor 0.
        MockERC20 bigUnit = new MockERC20(2); // 2 decimals
        MockFeed bigFeed = new MockFeed(8, 1_000_000e8, block.timestamp); // $1M/unit
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        cfg.tokens[0] = tokenFeed(address(usdc), usdcFeed, USD_MIN, USD_MAX);
        cfg.tokens[1] = tokenFeed(address(bigUnit), bigFeed, 250_000e18, 4_000_000e18);
        OphisVaultPolicyModule m = new OphisVaultPolicyModule(cfg);
        safe.setEnabledModule(address(m));

        GPv2Order.Data memory order = validOrder();
        order.buyToken = IERC20(address(bigUnit));
        order.sellAmount = 1e6; // $1 of USDC, << $1M/unit -> floor truncates to 0
        order.buyAmount = 1;
        // Even with minBuyOverride = 1 (which would make requiredFloor = 1),
        // the zero oracle floor fails closed.
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.ZeroOracleFloor.selector);
        m.rebalance(order, 1);
    }

    function test_stale_oracle_reverts() public {
        vm.warp(T0 + 3601); // usdcFeed.updatedAt == T0, per-token staleness 3600
        GPv2Order.Data memory order = validOrder(); // validTo re-derived after warp
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.StaleOraclePrice.selector,
                address(usdcFeed)
            )
        );
        rebalanceAsCurator(order, 0);
    }

    function test_stale_round_reverts() public {
        // answeredInRound < roundId: a carried-over answer from an earlier
        // round. updatedAt stays fresh, so ONLY the round guard can catch it.
        usdcFeed.setRounds(5, 4);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.StaleOraclePrice.selector,
                address(usdcFeed)
            )
        );
        rebalanceAsCurator(validOrder(), 0);
    }

    function test_incomplete_round_reverts() public {
        // updatedAt == 0: an in-progress round the aggregator has not answered.
        usdcFeed.set(1e8, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.StaleOraclePrice.selector,
                address(usdcFeed)
            )
        );
        rebalanceAsCurator(validOrder(), 0);
    }

    function test_invalid_oracle_price_reverts() public {
        wethFeed.set(0, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.InvalidOraclePrice.selector,
                address(wethFeed)
            )
        );
        rebalanceAsCurator(validOrder(), 0);
    }

    function test_oracle_price_below_bounds_reverts() public {
        usdcFeed.set(24e6, block.timestamp); // 0.24 at 8 feed decimals
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.OraclePriceOutOfBounds.selector,
                address(usdcFeed)
            )
        );
        rebalanceAsCurator(validOrder(), 0);
    }

    function test_oracle_price_above_bounds_reverts() public {
        wethFeed.set(8001e8, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.OraclePriceOutOfBounds.selector,
                address(wethFeed)
            )
        );
        rebalanceAsCurator(validOrder(), 0);
    }

    function test_oracle_price_inside_bounds_works() public {
        usdcFeed.set(26e6, block.timestamp); // 0.26 at 8 feed decimals
        GPv2Order.Data memory order = validOrder();
        order.buyAmount = 13e16; // above the resulting 0.12935 WETH floor
        rebalanceAsCurator(order, 0);
    }

    // ------------------------------------------------------------------
    // Leaky-bucket turnover cap (churn bound, no day-boundary burst)
    // ------------------------------------------------------------------

    function cappedModule(uint256 cap) internal returns (OphisVaultPolicyModule m) {
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.dailyUsdTurnoverCap = cap;
        m = new OphisVaultPolicyModule(cfg);
        safe.setEnabledModule(address(m));
    }

    function test_turnover_single_order_over_cap_reverts() public {
        OphisVaultPolicyModule m = cappedModule(500e18); // cap $500
        GPv2Order.Data memory order = validOrder(); // sells 1000 USDC = $1000
        vm.prank(CURATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.TurnoverCapExceeded.selector,
                0,
                1000e18,
                500e18
            )
        );
        m.rebalance(order, 0);
    }

    function test_turnover_leaky_bucket_bounds_any_rolling_window() public {
        // cap == exactly one order's USD value ($1000). One fill saturates it.
        OphisVaultPolicyModule m = cappedModule(1000e18);
        vm.prank(CURATOR);
        m.rebalance(validOrder(), 0);
        assertEq(m.turnoverSpentUsd(), 1000e18);

        // Immediately: a second fill overflows the bucket.
        vm.prank(CURATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.TurnoverCapExceeded.selector,
                1000e18,
                1000e18,
                1000e18
            )
        );
        m.rebalance(validOrder(), 0);

        // THE OLD BUG, NOW GONE: crossing what used to be a UTC-day boundary
        // no longer resets the bucket. Warp to the next UTC-midnight multiple
        // (+ a couple seconds); the leak is only ~seconds' worth, so a full
        // second cap still reverts (the fixed-window version would have let it
        // through, doubling the cap in ~2s).
        uint256 nextMidnight = ((block.timestamp / 1 days) + 1) * 1 days + 2;
        vm.warp(nextMidnight);
        refreshFeeds();
        vm.prank(CURATOR);
        vm.expectRevert(); // still TurnoverCapExceeded: leak ~= dust
        m.rebalance(validOrder(), 0);

        // Only after a FULL day of leak (from the last successful accrual at
        // T0) does the bucket drain enough for another full cap.
        vm.warp(T0 + 1 days);
        refreshFeeds();
        vm.prank(CURATOR);
        m.rebalance(validOrder(), 0);
        assertEq(m.turnoverSpentUsd(), 1000e18);
    }

    function test_turnover_partial_leak_allows_proportional_refill() public {
        OphisVaultPolicyModule m = cappedModule(1000e18);
        vm.prank(CURATOR);
        m.rebalance(validOrder(), 0); // spent 1000, lastTs T0

        // Half a day later the bucket has leaked ~500; a $400 order fits, a
        // $600 order does not.
        vm.warp(T0 + 43200);
        refreshFeeds();
        GPv2Order.Data memory small = validOrder();
        small.sellAmount = 400e6; // $400 -> floor 0.199 WETH
        small.buyAmount = 2e17; // above the 1.99e17 floor
        vm.prank(CURATOR);
        m.rebalance(small, 0); // 500 (leaked-down) + 400 = 900 <= 1000 ok
        assertEq(m.turnoverSpentUsd(), 900e18);
    }

    // ------------------------------------------------------------------
    // L2 sequencer-uptime gate
    // ------------------------------------------------------------------

    function sequencerModule(
        MockFeed uptime
    ) internal returns (OphisVaultPolicyModule seq) {
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.sequencerUptimeFeed = IAggregatorV3(address(uptime));
        cfg.allowNoSequencerFeed = false;
        cfg.sequencerGracePeriod = 900;
        seq = new OphisVaultPolicyModule(cfg);
        safe.setEnabledModule(address(seq));
    }

    function test_sequencer_down_reverts() public {
        MockFeed uptime = new MockFeed(0, 1, T0); // answer 1 = DOWN
        OphisVaultPolicyModule seq = sequencerModule(uptime);
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.SequencerDown.selector);
        seq.rebalance(validOrder(), 0);
    }

    function test_sequencer_startedAt_zero_reverts() public {
        // Uninitialized/genesis round: answer up (0) but startedAt == 0 would
        // let `block.timestamp - 0` sail past any grace; rejected explicitly.
        MockFeed uptime = new MockFeed(0, 0, 0);
        OphisVaultPolicyModule seq = sequencerModule(uptime);
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.SequencerStarting.selector);
        seq.rebalance(validOrder(), 0);
    }

    function test_sequencer_recovery_grace_period_enforced() public {
        // Sequencer back up 100s ago, grace is 900s: pre-outage prices could
        // still pass the staleness check, so oracle reads stay rejected.
        MockFeed uptime = new MockFeed(0, 0, T0 - 100);
        OphisVaultPolicyModule seq = sequencerModule(uptime);
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.SequencerStarting.selector);
        seq.rebalance(validOrder(), 0);

        // Once the grace period has elapsed, rebalancing resumes.
        uptime.set(0, T0 - 901);
        vm.prank(CURATOR);
        seq.rebalance(validOrder(), 0);
    }

    // ------------------------------------------------------------------
    // Policy checks (B0, B3-surface, B4, B7)
    // ------------------------------------------------------------------

    function test_non_curator_reverts() public {
        GPv2Order.Data memory order = validOrder();
        vm.prank(SAFE_OWNER);
        vm.expectRevert(OphisVaultPolicyModule.NotCurator.selector);
        module.rebalance(order, 0);
    }

    function test_foreign_receiver_reverts() public {
        GPv2Order.Data memory order = validOrder();
        order.receiver = address(0xBAD);
        vm.expectRevert(OphisVaultPolicyModule.ReceiverNotSafe.selector);
        rebalanceAsCurator(order, 0);
        // address(0) means "same as owner" to the settlement, but the
        // builder always pins the Safe explicitly - reject the marker too.
        order.receiver = address(0);
        vm.expectRevert(OphisVaultPolicyModule.ReceiverNotSafe.selector);
        rebalanceAsCurator(order, 0);
    }

    function test_non_zero_signed_fee_reverts() public {
        GPv2Order.Data memory order = validOrder();
        order.feeAmount = 1;
        vm.expectRevert(OphisVaultPolicyModule.NonZeroSignedFee.selector);
        rebalanceAsCurator(order, 0);
    }

    function test_wrong_app_data_reverts() public {
        GPv2Order.Data memory order = validOrder();
        order.appData = keccak256("attacker appdata: no ophis fee");
        vm.expectRevert(OphisVaultPolicyModule.WrongAppData.selector);
        rebalanceAsCurator(order, 0);
        // The zero appData a fee-less CoW order would carry is refused too.
        order.appData = bytes32(0);
        vm.expectRevert(OphisVaultPolicyModule.WrongAppData.selector);
        rebalanceAsCurator(order, 0);
    }

    function test_bad_order_flags_revert() public {
        GPv2Order.Data memory order = validOrder();
        order.kind = GPv2Order.KIND_BUY;
        vm.expectRevert(OphisVaultPolicyModule.BadOrderFlags.selector);
        rebalanceAsCurator(order, 0);

        order = validOrder();
        order.partiallyFillable = true;
        vm.expectRevert(OphisVaultPolicyModule.BadOrderFlags.selector);
        rebalanceAsCurator(order, 0);

        order = validOrder();
        order.sellTokenBalance = GPv2Order.BALANCE_EXTERNAL;
        vm.expectRevert(OphisVaultPolicyModule.BadOrderFlags.selector);
        rebalanceAsCurator(order, 0);

        order = validOrder();
        order.buyTokenBalance = GPv2Order.BALANCE_INTERNAL;
        vm.expectRevert(OphisVaultPolicyModule.BadOrderFlags.selector);
        rebalanceAsCurator(order, 0);
    }

    function test_valid_to_window() public {
        GPv2Order.Data memory order = validOrder();
        order.validTo = uint32(block.timestamp); // expired boundary
        vm.expectRevert(OphisVaultPolicyModule.BadValidTo.selector);
        rebalanceAsCurator(order, 0);

        order = validOrder();
        order.validTo = uint32(block.timestamp + 1801); // beyond maxTtl
        vm.expectRevert(OphisVaultPolicyModule.BadValidTo.selector);
        rebalanceAsCurator(order, 0);

        order = validOrder();
        order.validTo = uint32(block.timestamp + 1800); // at maxTtl: accepted
        rebalanceAsCurator(order, 0);
    }

    function test_non_allowlisted_token_reverts() public {
        MockERC20 rogue = new MockERC20(18);
        GPv2Order.Data memory order = validOrder();
        order.buyToken = IERC20(address(rogue));
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.TokenNotAllowed.selector,
                address(rogue)
            )
        );
        rebalanceAsCurator(order, 0);
    }

    function test_same_token_reverts() public {
        GPv2Order.Data memory order = validOrder();
        order.buyToken = order.sellToken;
        vm.expectRevert(OphisVaultPolicyModule.SameToken.selector);
        rebalanceAsCurator(order, 0);
    }

    function test_zero_sell_amount_reverts() public {
        GPv2Order.Data memory order = validOrder();
        order.sellAmount = 0;
        vm.expectRevert(OphisVaultPolicyModule.ZeroSellAmount.selector);
        rebalanceAsCurator(order, 0);
    }

    // ------------------------------------------------------------------
    // Approve semantics (B5)
    // ------------------------------------------------------------------

    function test_usdt_residual_allowance_is_reset_then_exact() public {
        // Leave a residual allowance: a direct nonzero -> nonzero approve
        // would revert on the USDT-style token, so passing proves the module
        // reset to zero first.
        vm.prank(address(safe));
        usdt.approve(RELAYER, 123);

        GPv2Order.Data memory order = validOrder();
        order.sellToken = IERC20(address(usdt));
        rebalanceAsCurator(order, 0);
        assertEq(usdt.allowance(address(safe), RELAYER), 1000e6);
    }

    function test_approve_returning_false_reverts() public {
        usdc.setApproveReturn(false);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.ApproveFailed.selector,
                address(usdc)
            )
        );
        rebalanceAsCurator(validOrder(), 0);
    }

    // ------------------------------------------------------------------
    // Cancel (risk-reducing only, scoped to module-created uids, resets approval)
    // ------------------------------------------------------------------

    function test_curator_can_cancel_and_it_zeroes_the_allowance() public {
        bytes memory uid = rebalanceAsCurator(validOrder(), 0);
        assertEq(settlement.preSignature(uid), settlement.PRE_SIGNED());
        assertEq(usdc.allowance(address(safe), RELAYER), 1000e6);
        vm.prank(CURATOR);
        module.cancel(uid);
        // presignature revoked AND the relayer allowance zeroed (hygiene).
        assertEq(settlement.preSignature(uid), 0);
        assertEq(usdc.allowance(address(safe), RELAYER), 0);
        assertEq(module.moduleOrderSellToken(keccak256(uid)), address(0));
    }

    function test_non_curator_cannot_cancel() public {
        bytes memory uid = rebalanceAsCurator(validOrder(), 0);
        vm.expectRevert(OphisVaultPolicyModule.NotCurator.selector);
        module.cancel(uid);
    }

    function test_supersede_revokes_prior_and_preserves_live_allowance() public {
        // Order A on USDC (owns the allowance), then order B on the SAME token.
        // Superseding A must (1) revoke A's presignature so it cannot linger
        // fillable at a stale floor, (2) drop A's record so it is no longer
        // cancellable, and (3) leave B's exact allowance untouched.
        GPv2Order.Data memory a = validOrder();
        a.sellAmount = 1000e6;
        a.validTo = uint32(block.timestamp + 1000);
        bytes memory uidA = rebalanceAsCurator(a, 0);
        assertEq(settlement.preSignature(uidA), settlement.PRE_SIGNED());

        GPv2Order.Data memory b = validOrder();
        b.sellAmount = 700e6;
        b.validTo = uint32(block.timestamp + 1200);
        bytes memory uidB = rebalanceAsCurator(b, 0);
        // B now owns the allowance (exact 700e6); A is REVOKED at supersede time.
        assertEq(usdc.allowance(address(safe), RELAYER), 700e6);
        assertEq(module.liveAllowanceUid(address(usdc)), keccak256(uidB));
        assertEq(module.liveAllowanceOrderUid(address(usdc)), uidB);
        assertEq(settlement.preSignature(uidA), 0, "superseded order left presigned");
        // A's record is gone, so cancelling it is a no-op that fails closed.
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.UnknownOrderUid.selector);
        module.cancel(uidA);
        // B's allowance was never starved by the supersede/revoke.
        assertEq(usdc.allowance(address(safe), RELAYER), 700e6, "supersede starved the live order");

        // Cancelling the LIVE B zeros the allowance and both bookkeeping maps.
        vm.prank(CURATOR);
        module.cancel(uidB);
        assertEq(usdc.allowance(address(safe), RELAYER), 0);
        assertEq(module.liveAllowanceUid(address(usdc)), bytes32(0));
        assertEq(module.liveAllowanceOrderUid(address(usdc)).length, 0);
    }

    function test_supersede_isolated_per_sell_token() public {
        // A sells USDC, B sells USDT (a DIFFERENT sell token). The supersede
        // path keys on the sell token, so B must leave A's USDC presignature,
        // bookkeeping, and allowance completely untouched.
        GPv2Order.Data memory a = validOrder(); // USDC -> WETH
        a.validTo = uint32(block.timestamp + 1000);
        bytes memory uidA = rebalanceAsCurator(a, 0);

        GPv2Order.Data memory b = validOrder();
        b.sellToken = IERC20(address(usdt));
        b.buyToken = IERC20(address(weth));
        b.sellAmount = 1000e6; // 1000 USDT
        b.buyAmount = 5e17; // 0.5 WETH — clears the 0.5% floor (0.4975 WETH)
        b.validTo = uint32(block.timestamp + 1100);
        bytes memory uidB = rebalanceAsCurator(b, 0);

        // A (USDC) is fully intact after B (USDT).
        assertEq(settlement.preSignature(uidA), settlement.PRE_SIGNED(), "cross-token rebalance revoked the USDC order");
        assertEq(module.liveAllowanceUid(address(usdc)), keccak256(uidA));
        assertEq(module.liveAllowanceOrderUid(address(usdc)), uidA);
        assertEq(usdc.allowance(address(safe), RELAYER), 1000e6);
        // B owns the USDT allowance independently.
        assertEq(module.liveAllowanceUid(address(usdt)), keccak256(uidB));
        assertEq(usdt.allowance(address(safe), RELAYER), 1000e6);
    }

    function test_supersede_of_same_uid_is_noop_not_self_revoke() public {
        // Re-presigning the EXACT same order (same uid) must not revoke itself:
        // the supersede branch is skipped when keccak(prevUid) == key.
        GPv2Order.Data memory a = validOrder();
        a.sellAmount = 500e6;
        a.validTo = uint32(block.timestamp + 900);
        bytes memory uidA = rebalanceAsCurator(a, 0);
        bytes memory uidA2 = rebalanceAsCurator(a, 0); // identical order → identical uid
        assertEq(uidA2, uidA);
        assertEq(settlement.preSignature(uidA), settlement.PRE_SIGNED(), "self-supersede wrongly revoked the order");
        assertEq(usdc.allowance(address(safe), RELAYER), 500e6);
    }

    function test_cancel_refuses_uids_not_created_by_this_module() public {
        // A presignature the OWNERS created directly (a hedge, a liquidation,
        // an order from another venue): the curator cannot cancel it through
        // this module, because rebalance never recorded that uid.
        bytes memory ownerUid = new bytes(GPv2Order.UID_LENGTH);
        GPv2Order.packOrderUidParams(
            ownerUid,
            keccak256("owner-authorized order"),
            address(safe),
            uint32(block.timestamp + 100)
        );
        vm.prank(address(safe));
        settlement.setPreSignature(ownerUid, true);

        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.UnknownOrderUid.selector);
        module.cancel(ownerUid);
        // The owner-authorized presignature is untouched.
        assertEq(settlement.preSignature(ownerUid), settlement.PRE_SIGNED());
    }

    // ------------------------------------------------------------------
    // Safe enablement
    // ------------------------------------------------------------------

    function test_module_not_enabled_fails() public {
        safe.setEnabledModule(address(0xDEAD)); // someone else, not us
        vm.prank(CURATOR);
        vm.expectRevert("MockSafe: module not enabled");
        module.rebalance(validOrder(), 0);
    }

    // ------------------------------------------------------------------
    // Constructor validation (B9 config immutability is by construction:
    // the module has no setters; these prove the write-once path is strict)
    // ------------------------------------------------------------------

    function test_constructor_rejects_bad_config() public {
        OphisVaultPolicyModule.ModuleConfig memory cfg;

        cfg = baseConfig();
        cfg.curator = address(0);
        vm.expectRevert(OphisVaultPolicyModule.ZeroAddress.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.appDataHash = bytes32(0); // would disable the fee invariant
        vm.expectRevert(OphisVaultPolicyModule.ZeroAppData.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.curator = address(safe); // curator == safe
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.maxSlippageBps = 1001; // over cap
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.maxTtl = 0;
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.maxTtl = 1 hours + 1; // TTL cap is deliberately tight (1 hour)
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.tokens[0].maxStaleness = 0; // per-token staleness must be > 0
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.tokens[0].maxStaleness = 2 days + 1; // over the staleness cap
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.dailyUsdTurnoverCap = 0; // unbounded churn is not a valid config
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.sequencerUptimeFeed = IAggregatorV3(address(usdcFeed));
        cfg.allowNoSequencerFeed = false;
        cfg.sequencerGracePeriod = 0; // feed without grace: incoherent
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.sequencerGracePeriod = 900; // grace without feed: incoherent
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        OphisVaultPolicyModule.TokenFeed[] memory single =
            new OphisVaultPolicyModule.TokenFeed[](1);
        single[0] = cfg.tokens[0];
        cfg.tokens = single; // fewer than 2 tokens
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        OphisVaultPolicyModule.TokenFeed[] memory dup =
            new OphisVaultPolicyModule.TokenFeed[](2);
        dup[0] = cfg.tokens[0];
        dup[1] = cfg.tokens[0];
        cfg.tokens = dup; // duplicate token
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        new OphisVaultPolicyModule(cfg);
    }

    function test_constructor_requires_explicit_no_sequencer_feed_opt_out() public {
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.allowNoSequencerFeed = false;
        vm.expectRevert(OphisVaultPolicyModule.SequencerFeedRequired.selector);
        new OphisVaultPolicyModule(cfg);
    }

    function test_constructor_allows_explicit_no_sequencer_feed_opt_out() public {
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        OphisVaultPolicyModule deployed = new OphisVaultPolicyModule(cfg);
        assertEq(address(deployed.sequencerUptimeFeed()), address(0));
    }

    function test_constructor_rejects_curator_that_is_a_safe_owner() public {
        // Defense in depth: even a direct deploy (bypassing the factory)
        // cannot ship a module whose curator is a current Safe owner.
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.curator = SAFE_OWNER;
        vm.expectRevert(OphisVaultPolicyModule.CuratorIsOwner.selector);
        new OphisVaultPolicyModule(cfg);
    }

    function test_constructor_rejects_curator_that_is_an_enabled_module() public {
        // A curator that is ALSO an enabled Safe module has unilateral
        // execTransactionFromModule power (no signature threshold) and bypasses
        // the policy gate entirely - strictly more dangerous than an owner.
        safe.setModuleEnabled(CURATOR, true);
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        vm.expectRevert(OphisVaultPolicyModule.CuratorIsModule.selector);
        new OphisVaultPolicyModule(cfg);
    }

    // ------------------------------------------------------------------
    // Runtime curator-drift guard: rebalance/cancel re-check the invariant,
    // not only the constructor. A curator that becomes an enabled Safe module
    // after deployment must fail closed.
    // ------------------------------------------------------------------

    function test_rebalance_reverts_when_curator_drifts_to_module() public {
        safe.setModuleEnabled(CURATOR, true);
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.CuratorIsModule.selector);
        module.rebalance(validOrder(), 0);
    }

    function test_cancel_reverts_when_curator_drifts_to_module() public {
        // The guard runs before the order-uid lookup, so any bytes argument
        // reverts CuratorIsModule once the curator is a module.
        safe.setModuleEnabled(CURATOR, true);
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.CuratorIsModule.selector);
        module.cancel(hex"1234");
    }

    function test_constructor_rejects_high_decimal_token() public {
        MockERC20 wild = new MockERC20(40); // > MAX_TOKEN_DECIMALS
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.tokens[2] = tokenFeed(address(wild), usdtFeed, USD_MIN, USD_MAX);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.UnsupportedTokenDecimals.selector,
                address(wild)
            )
        );
        new OphisVaultPolicyModule(cfg);
    }

    function test_constructor_rejects_bad_price_bounds() public {
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.tokens[0].minPrice18 = 0;
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.BadPriceBounds.selector,
                address(usdc)
            )
        );
        new OphisVaultPolicyModule(cfg);

        cfg = baseConfig();
        cfg.tokens[0].minPrice18 = 2e18;
        cfg.tokens[0].maxPrice18 = 2e18;
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.BadPriceBounds.selector,
                address(usdc)
            )
        );
        new OphisVaultPolicyModule(cfg);
    }

    function test_constructor_probes_feed_liveness() public {
        usdcFeed.set(1e8, T0 - 3601); // stale at deploy
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.StaleOraclePrice.selector,
                address(usdcFeed)
            )
        );
        new OphisVaultPolicyModule(baseConfig());

        usdcFeed.set(0, T0); // invalid price at deploy
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.InvalidOraclePrice.selector,
                address(usdcFeed)
            )
        );
        new OphisVaultPolicyModule(baseConfig());
    }

    function test_constructor_reads_settlement_wiring() public view {
        assertEq(module.relayer(), RELAYER);
        assertEq(module.domainSeparator(), settlement.domainSeparator());
    }

    // ------------------------------------------------------------------
    // Factory (B3 deploy-time gate)
    // ------------------------------------------------------------------

    function test_factory_rejects_curator_that_is_a_safe_owner() public {
        OphisVaultPolicyModuleFactory factory = new OphisVaultPolicyModuleFactory();
        OphisVaultPolicyModule.ModuleConfig memory cfg = baseConfig();
        cfg.curator = SAFE_OWNER; // curator IS an owner: refused
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModuleFactory.CuratorIsSafeOwner.selector,
                SAFE_OWNER
            )
        );
        factory.deploy(cfg);
    }

    function test_factory_rejects_curator_that_is_an_enabled_module() public {
        OphisVaultPolicyModuleFactory factory = new OphisVaultPolicyModuleFactory();
        safe.setModuleEnabled(CURATOR, true); // curator already a module: refused
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModuleFactory.CuratorIsSafeModule.selector,
                CURATOR
            )
        );
        factory.deploy(baseConfig());
    }

    function test_factory_deploys_configured_module() public {
        OphisVaultPolicyModuleFactory factory = new OphisVaultPolicyModuleFactory();
        OphisVaultPolicyModule deployed = factory.deploy(baseConfig());
        assertEq(deployed.curator(), CURATOR);
        assertEq(address(deployed.safe()), address(safe));
        assertEq(deployed.relayer(), RELAYER);
        assertEq(deployed.dailyUsdTurnoverCap(), BIG_CAP);
        (
            bool allowed,
            ,
            ,
            uint8 tokenDecimals,
            uint256 maxStaleness,
            uint256 minPrice18,
            uint256 maxPrice18
        ) = deployed.tokenPolicy(address(weth));
        assertTrue(allowed);
        assertEq(tokenDecimals, 18);
        assertEq(maxStaleness, STALENESS);
        assertEq(minPrice18, ETH_MIN);
        assertEq(maxPrice18, ETH_MAX);
    }
}
