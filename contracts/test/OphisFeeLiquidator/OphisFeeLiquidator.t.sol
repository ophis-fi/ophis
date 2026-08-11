// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {GPv2AllowListAuthentication} from "src/contracts/GPv2AllowListAuthentication.sol";
import {GPv2Authentication, GPv2Settlement, IVault} from "src/contracts/GPv2Settlement.sol";
import {OphisFeeLiquidator} from "src/contracts/OphisFeeLiquidator.sol";

import {FalseReturnERC20, MockERC20, MockVenueRouter, NoReturnERC20, StickyApproveERC20} from "./Mocks.sol";

// solhint-disable func-name-mixedcase
contract OphisFeeLiquidatorTest is Test {
    address internal deployer;
    address internal manager;
    address internal ownerSafe;
    address internal ops;
    address internal stranger;
    address payable internal feeSafe;

    GPv2AllowListAuthentication internal allowList;
    GPv2Settlement internal settlement;
    OphisFeeLiquidator internal liq;

    MockERC20 internal usdc; // 6 decimals dust
    MockERC20 internal dai; // 18 decimals dust
    MockERC20 internal weth; // consolidation target
    MockVenueRouter internal venue;

    function setUp() public {
        deployer = makeAddr("OphisFeeLiquidator: deployer");
        manager = makeAddr("OphisFeeLiquidator: allowlist manager");
        ownerSafe = makeAddr("OphisFeeLiquidator: protocol safe");
        ops = makeAddr("OphisFeeLiquidator: fee-ops key");
        stranger = makeAddr("OphisFeeLiquidator: stranger");
        feeSafe = payable(makeAddr("OphisFeeLiquidator: fee safe"));

        vm.startPrank(deployer);
        allowList = new GPv2AllowListAuthentication();
        allowList.initializeManager(manager);
        IVault vault = IVault(makeAddr("OphisFeeLiquidator: vault"));
        vm.mockCallRevert(address(vault), hex"", "unexpected call to mock vault");
        settlement = new GPv2Settlement(GPv2Authentication(address(allowList)), vault);
        liq = new OphisFeeLiquidator(settlement, feeSafe, ownerSafe, ops);
        vm.stopPrank();

        vm.prank(manager);
        allowList.addSolver(address(liq));

        usdc = new MockERC20(6);
        dai = new MockERC20(18);
        weth = new MockERC20(18);
        venue = new MockVenueRouter();

        // Sweep now requires each non-native token to be owner-allowlisted;
        // enable the standard fee tokens so the behaviour tests below exercise
        // sweep logic rather than the allowlist gate (which has its own tests).
        vm.startPrank(ownerSafe);
        liq.setSweepToken(address(usdc), true);
        liq.setSweepToken(address(dai), true);
        liq.setSweepToken(address(weth), true);
        vm.stopPrank();
    }

    // --- helpers ---

    function enableConsolidation() internal {
        vm.startPrank(ownerSafe);
        liq.setVenue(address(venue), true);
        liq.setOutputToken(address(weth), true);
        vm.stopPrank();
        weth.mint(address(venue), 1e40); // venue payout inventory
    }

    function oneInput(address token, uint256 amount)
        internal
        pure
        returns (OphisFeeLiquidator.ConsolidateInput[] memory inputs)
    {
        inputs = new OphisFeeLiquidator.ConsolidateInput[](1);
        inputs[0] = OphisFeeLiquidator.ConsolidateInput({token: token, amount: amount});
    }

    function venueSwapData(address tokenIn, uint256 amountIn) internal view returns (bytes memory) {
        return abi.encodeCall(MockVenueRouter.swap, (MockERC20(tokenIn), amountIn, weth, address(settlement)));
    }

    // --- constructor + admin ---

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert("OFL: settlement is zero");
        new OphisFeeLiquidator(GPv2Settlement(payable(address(0))), feeSafe, ownerSafe, ops);
        vm.expectRevert("OFL: fee safe is zero");
        new OphisFeeLiquidator(settlement, payable(address(0)), ownerSafe, ops);
        vm.expectRevert("OFL: owner is zero");
        new OphisFeeLiquidator(settlement, feeSafe, address(0), ops);
    }

    function test_constructor_allows_paused_liquidator() public {
        OphisFeeLiquidator paused = new OphisFeeLiquidator(settlement, feeSafe, ownerSafe, address(0));
        assertEq(paused.liquidator(), address(0));
    }

    function test_immutables_and_roles_are_set() public view {
        assertEq(address(liq.settlement()), address(settlement));
        assertEq(liq.feeSafe(), feeSafe);
        assertEq(liq.owner(), ownerSafe);
        assertEq(liq.liquidator(), ops);
    }

    function test_setLiquidator_only_owner() public {
        vm.prank(stranger);
        vm.expectRevert("OFL: caller not owner");
        liq.setLiquidator(stranger);
        // The ops key cannot rotate itself either.
        vm.prank(ops);
        vm.expectRevert("OFL: caller not owner");
        liq.setLiquidator(stranger);
        vm.prank(ownerSafe);
        liq.setLiquidator(stranger);
        assertEq(liq.liquidator(), stranger);
    }

    function test_setVenue_only_owner_and_rejects_zero() public {
        vm.prank(ops);
        vm.expectRevert("OFL: caller not owner");
        liq.setVenue(address(venue), true);
        vm.prank(ownerSafe);
        vm.expectRevert("OFL: venue is zero");
        liq.setVenue(address(0), true);
        vm.prank(ownerSafe);
        liq.setVenue(address(venue), true);
        assertTrue(liq.venueAllowed(address(venue)));
        vm.prank(ownerSafe);
        liq.setVenue(address(venue), false);
        assertFalse(liq.venueAllowed(address(venue)));
    }

    function test_setOutputToken_only_owner_and_rejects_zero() public {
        vm.prank(ops);
        vm.expectRevert("OFL: caller not owner");
        liq.setOutputToken(address(weth), true);
        vm.prank(ownerSafe);
        vm.expectRevert("OFL: output token is zero");
        liq.setOutputToken(address(0), true);
        vm.prank(ownerSafe);
        liq.setOutputToken(address(weth), true);
        assertTrue(liq.outputTokenAllowed(address(weth)));
    }

    function test_setSweepToken_only_owner_and_rejects_native() public {
        MockERC20 tok = new MockERC20(18);

        vm.prank(ops);
        vm.expectRevert("OFL: caller not owner");
        liq.setSweepToken(address(tok), true);

        vm.prank(ownerSafe);
        vm.expectRevert("OFL: native needs no allowlist");
        liq.setSweepToken(address(0), true);

        vm.prank(ownerSafe);
        vm.expectEmit(address(liq));
        emit OphisFeeLiquidator.SweepTokenSet(address(tok), true);
        liq.setSweepToken(address(tok), true);
        assertTrue(liq.sweepTokenAllowed(address(tok)));

        vm.prank(ownerSafe);
        liq.setSweepToken(address(tok), false);
        assertFalse(liq.sweepTokenAllowed(address(tok)));
    }

    // --- sweep: allowlist gate ---

    /// The audit hardening: `sweep` turns each non-native `tokens[i]` into an
    /// interaction target the solver-privileged Settlement calls, so a
    /// non-allowlisted token must be rejected before any interaction is built.
    function test_sweep_rejects_non_allowlisted_token() public {
        MockERC20 rogue = new MockERC20(18);
        rogue.mint(address(settlement), 1e18);
        address[] memory tokens = new address[](1);
        tokens[0] = address(rogue);
        uint256[] memory amounts = new uint256[](1);

        vm.prank(ops);
        vm.expectRevert("OFL: sweep token not allowed");
        liq.sweep(tokens, amounts);

        // Once the owner allowlists it, the same sweep succeeds.
        vm.prank(ownerSafe);
        liq.setSweepToken(address(rogue), true);
        vm.prank(ops);
        liq.sweep(tokens, amounts);
        assertEq(rogue.balanceOf(feeSafe), 1e18);
    }

    /// A rogue token bundled alongside an allowlisted one still reverts the
    /// whole sweep (no partial execution of the vetted leg).
    function test_sweep_rejects_batch_containing_non_allowlisted_token() public {
        MockERC20 rogue = new MockERC20(18);
        usdc.mint(address(settlement), 5e6);
        rogue.mint(address(settlement), 1e18);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc); // allowlisted in setUp
        tokens[1] = address(rogue); // not allowlisted
        uint256[] memory amounts = new uint256[](2);

        vm.prank(ops);
        vm.expectRevert("OFL: sweep token not allowed");
        liq.sweep(tokens, amounts);
        assertEq(usdc.balanceOf(feeSafe), 0); // nothing moved
    }

    /// Native ETH carries no arbitrary-call surface (target is the fee Safe),
    /// so it sweeps with no allowlist entry — even on a contract whose token
    /// allowlist is entirely empty.
    function test_sweep_native_eth_needs_no_allowlist() public {
        OphisFeeLiquidator fresh =
            new OphisFeeLiquidator(settlement, feeSafe, ownerSafe, ops);
        vm.prank(manager);
        allowList.addSolver(address(fresh));

        vm.deal(address(settlement), 3 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        uint256[] memory amounts = new uint256[](1);

        vm.prank(ops);
        fresh.sweep(tokens, amounts);
        assertEq(feeSafe.balance, 3 ether);
    }

    /// De-allowlisting a token blocks future sweeps of it.
    function test_sweep_blocked_after_token_removed() public {
        usdc.mint(address(settlement), 2e6);
        vm.prank(ownerSafe);
        liq.setSweepToken(address(usdc), false);

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);
        vm.prank(ops);
        vm.expectRevert("OFL: sweep token not allowed");
        liq.sweep(tokens, amounts);
    }

    // --- sweep: auth matrix ---

    function test_sweep_rejects_stranger() public {
        usdc.mint(address(settlement), 1e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);
        vm.prank(stranger);
        vm.expectRevert("OFL: caller not ops");
        liq.sweep(tokens, amounts);
    }

    function test_sweep_paused_when_liquidator_zeroed_owner_still_works() public {
        usdc.mint(address(settlement), 5e6);
        vm.prank(ownerSafe);
        liq.setLiquidator(address(0));

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);

        vm.prank(ops);
        vm.expectRevert("OFL: caller not ops");
        liq.sweep(tokens, amounts);

        vm.prank(ownerSafe);
        liq.sweep(tokens, amounts);
        assertEq(usdc.balanceOf(feeSafe), 5e6);
    }

    function test_sweep_reverts_when_not_a_solver() public {
        vm.prank(manager);
        allowList.removeSolver(address(liq));
        usdc.mint(address(settlement), 1e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);
        vm.prank(ops);
        vm.expectRevert("GPv2: not a solver");
        liq.sweep(tokens, amounts);
    }

    // --- sweep: behavior ---

    function test_sweep_full_balance_with_amount_zero() public {
        usdc.mint(address(settlement), 123e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);

        vm.expectEmit(address(liq));
        emit OphisFeeLiquidator.Swept(address(usdc), 123e6);
        vm.prank(ops);
        liq.sweep(tokens, amounts);

        assertEq(usdc.balanceOf(feeSafe), 123e6);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(liq.lastSweepAt(), block.timestamp);
    }

    function test_sweep_partial_amount() public {
        usdc.mint(address(settlement), 100e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 40e6;

        vm.prank(ops);
        liq.sweep(tokens, amounts);
        assertEq(usdc.balanceOf(feeSafe), 40e6);
        assertEq(usdc.balanceOf(address(settlement)), 60e6);
    }

    function test_sweep_multiple_tokens_and_native_eth() public {
        usdc.mint(address(settlement), 7e6);
        dai.mint(address(settlement), 3e18);
        vm.deal(address(settlement), 2 ether);

        address[] memory tokens = new address[](3);
        tokens[0] = address(usdc);
        tokens[1] = address(0); // native ETH
        tokens[2] = address(dai);
        uint256[] memory amounts = new uint256[](3);
        amounts[2] = 1e18; // partial DAI

        vm.prank(ops);
        liq.sweep(tokens, amounts);

        assertEq(usdc.balanceOf(feeSafe), 7e6);
        assertEq(feeSafe.balance, 2 ether);
        assertEq(dai.balanceOf(feeSafe), 1e18);
        assertEq(dai.balanceOf(address(settlement)), 2e18);
        assertEq(address(settlement).balance, 0);
    }

    function test_sweep_no_return_token() public {
        NoReturnERC20 usdt = new NoReturnERC20();
        vm.prank(ownerSafe);
        liq.setSweepToken(address(usdt), true);
        usdt.mint(address(settlement), 9e6);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdt);
        uint256[] memory amounts = new uint256[](1);

        vm.prank(ops);
        liq.sweep(tokens, amounts);
        assertEq(usdt.balanceOf(feeSafe), 9e6);
    }

    function test_sweep_false_return_token_reverts() public {
        FalseReturnERC20 broken = new FalseReturnERC20();
        vm.prank(ownerSafe);
        liq.setSweepToken(address(broken), true);
        broken.mint(address(settlement), 1e18);
        address[] memory tokens = new address[](1);
        tokens[0] = address(broken);
        uint256[] memory amounts = new uint256[](1);

        vm.prank(ops);
        vm.expectRevert("OFL: sweep amount mismatch");
        liq.sweep(tokens, amounts);
    }

    function test_sweep_input_validation() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](2);
        vm.prank(ops);
        vm.expectRevert("OFL: length mismatch");
        liq.sweep(tokens, amounts);

        vm.prank(ops);
        vm.expectRevert("OFL: empty sweep");
        liq.sweep(new address[](0), new uint256[](0));

        address[] memory dup = new address[](2);
        dup[0] = address(usdc);
        dup[1] = address(usdc);
        vm.prank(ops);
        vm.expectRevert("OFL: duplicate token");
        liq.sweep(dup, new uint256[](2));

        // All-zero balances: nothing to sweep.
        uint256[] memory one = new uint256[](1);
        vm.prank(ops);
        vm.expectRevert("OFL: nothing to sweep");
        liq.sweep(tokens, one);

        // Requesting more than the settlement holds.
        usdc.mint(address(settlement), 1e6);
        one[0] = 2e6;
        vm.prank(ops);
        vm.expectRevert("OFL: amount exceeds balance");
        liq.sweep(tokens, one);
    }

    function test_sweep_liquidator_contract_holds_nothing_after() public {
        usdc.mint(address(settlement), 5e6);
        vm.deal(address(settlement), 1 ether);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(0);
        uint256[] memory amounts = new uint256[](2);

        vm.prank(ops);
        liq.sweep(tokens, amounts);
        assertEq(usdc.balanceOf(address(liq)), 0);
        assertEq(address(liq).balance, 0);
    }

    // --- consolidate: access control (BLOCKER fix: owner-only) ---

    /// The BLOCKER: consolidate() routes through an arbitrary venue with a
    /// caller-supplied amountOutMin, so it must NOT be reachable by the
    /// liquidator hot key. Only the owner Safe may call it.
    function test_consolidate_is_owner_only_not_ops_key() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1000e6);

        // The liquidator hot key is rejected BEFORE any state change.
        vm.prank(ops);
        vm.expectRevert("OFL: caller not owner");
        liq.consolidate(
            oneInput(address(usdc), 0), address(weth), 1, address(venue), venueSwapData(address(usdc), 1000e6)
        );

        // A random address is rejected too.
        vm.prank(stranger);
        vm.expectRevert("OFL: caller not owner");
        liq.consolidate(
            oneInput(address(usdc), 0), address(weth), 1, address(venue), venueSwapData(address(usdc), 1000e6)
        );

        // The owner Safe can.
        vm.prank(ownerSafe);
        liq.consolidate(
            oneInput(address(usdc), 0), address(weth), 990e6, address(venue), venueSwapData(address(usdc), 1000e6)
        );
    }

    /// The exact drain scenario from the audit, proven impossible: a
    /// compromised ops key calls consolidate() DIRECTLY (bypassing the
    /// 100 bps script cap) with amountOutMin = 1 and venue calldata paying an
    /// attacker. The onlyOwner gate reverts it before the venue is ever
    /// approved or called, so no dust moves and the attacker's misdirect
    /// never executes.
    function test_consolidate_drain_via_ops_key_is_blocked() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1000e6);
        venue.setMisdirectTo(stranger); // hostile route: pay the attacker

        uint256 settlementBefore = usdc.balanceOf(address(settlement));
        uint256 attackerBefore = weth.balanceOf(stranger);

        vm.prank(ops);
        vm.expectRevert("OFL: caller not owner");
        liq.consolidate(
            oneInput(address(usdc), 0),
            address(weth),
            1, // 1 wei floor: legal on-chain, would pass the balance check
            address(venue),
            venueSwapData(address(usdc), 1000e6)
        );

        // Nothing moved: dust intact, attacker got nothing, no lingering
        // approval that a follow-up call could exploit.
        assertEq(usdc.balanceOf(address(settlement)), settlementBefore);
        assertEq(weth.balanceOf(stranger), attackerBefore);
        assertEq(usdc.allowance(address(settlement), address(venue)), 0);
    }

    // --- consolidate: gating (owner-executed) ---

    function test_consolidate_rejects_unallowed_venue() public {
        vm.prank(ownerSafe);
        liq.setOutputToken(address(weth), true);
        usdc.mint(address(settlement), 1e6);
        vm.prank(ownerSafe);
        vm.expectRevert("OFL: venue not allowed");
        liq.consolidate(oneInput(address(usdc), 0), address(weth), 1, address(venue), "");
    }

    function test_consolidate_rejects_unallowed_output() public {
        vm.prank(ownerSafe);
        liq.setVenue(address(venue), true);
        usdc.mint(address(settlement), 1e6);
        vm.prank(ownerSafe);
        vm.expectRevert("OFL: output not allowed");
        liq.consolidate(oneInput(address(usdc), 0), address(weth), 1, address(venue), "");
    }

    function test_consolidate_rejects_zero_amount_out_min() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1e6);
        vm.prank(ownerSafe);
        vm.expectRevert("OFL: zero amountOutMin");
        liq.consolidate(oneInput(address(usdc), 0), address(weth), 0, address(venue), "");
    }

    function test_consolidate_rejects_bad_inputs() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1e6);

        vm.prank(ownerSafe);
        vm.expectRevert("OFL: empty consolidate");
        liq.consolidate(new OphisFeeLiquidator.ConsolidateInput[](0), address(weth), 1, address(venue), "");

        vm.prank(ownerSafe);
        vm.expectRevert("OFL: native input");
        liq.consolidate(oneInput(address(0), 1), address(weth), 1, address(venue), "");

        vm.prank(ownerSafe);
        vm.expectRevert("OFL: input is output");
        liq.consolidate(oneInput(address(weth), 1), address(weth), 1, address(venue), "");

        OphisFeeLiquidator.ConsolidateInput[] memory dup = new OphisFeeLiquidator.ConsolidateInput[](2);
        dup[0] = OphisFeeLiquidator.ConsolidateInput({token: address(usdc), amount: 1});
        dup[1] = OphisFeeLiquidator.ConsolidateInput({token: address(usdc), amount: 1});
        vm.prank(ownerSafe);
        vm.expectRevert("OFL: duplicate input");
        liq.consolidate(dup, address(weth), 1, address(venue), "");

        vm.prank(ownerSafe);
        vm.expectRevert("OFL: nothing to consolidate");
        liq.consolidate(oneInput(address(dai), 0), address(weth), 1, address(venue), "");
    }

    // --- consolidate: behavior (owner-executed) ---

    function test_consolidate_happy_path_full_balance() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1000e6);
        venue.setRateBps(10_000); // 1:1 in raw base units

        vm.expectEmit(address(liq));
        emit OphisFeeLiquidator.Consolidated(address(venue), address(weth), 1000e6);
        vm.prank(ownerSafe);
        uint256 amountOut = liq.consolidate(
            oneInput(address(usdc), 0),
            address(weth),
            990e6, // 100 bps floor below the 1:1 quote
            address(venue),
            venueSwapData(address(usdc), 1000e6)
        );

        assertEq(amountOut, 1000e6);
        // Output accrues in the Settlement contract, not the fee Safe.
        assertEq(weth.balanceOf(address(settlement)), 1000e6);
        assertEq(weth.balanceOf(feeSafe), 0);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(usdc.balanceOf(address(venue)), 1000e6);
        // No residual approval, nothing stuck in the liquidator.
        assertEq(usdc.allowance(address(settlement), address(venue)), 0);
        assertEq(weth.balanceOf(address(liq)), 0);
        assertEq(usdc.balanceOf(address(liq)), 0);
    }

    function test_consolidate_multi_input() public {
        enableConsolidation();
        usdc.mint(address(settlement), 100e6);
        dai.mint(address(settlement), 50e18);

        OphisFeeLiquidator.ConsolidateInput[] memory inputs = new OphisFeeLiquidator.ConsolidateInput[](2);
        inputs[0] = OphisFeeLiquidator.ConsolidateInput({token: address(usdc), amount: 0});
        inputs[1] = OphisFeeLiquidator.ConsolidateInput({token: address(dai), amount: 20e18});

        // Two sequential venue swaps in one call payload via multicall-style
        // is out of scope for the mock; call the venue once per input token
        // is what a real aggregator route does internally. Here: single swap
        // consuming the USDC leg; the DAI approval is still revoked.
        bytes memory data = venueSwapData(address(usdc), 100e6);

        vm.prank(ownerSafe);
        uint256 amountOut = liq.consolidate(inputs, address(weth), 90e6, address(venue), data);

        assertEq(amountOut, 100e6);
        assertEq(usdc.allowance(address(settlement), address(venue)), 0);
        assertEq(dai.allowance(address(settlement), address(venue)), 0);
        // The un-consumed DAI leg stays in the settlement, untouched.
        assertEq(dai.balanceOf(address(settlement)), 50e18);
    }

    function test_consolidate_slippage_reverts() public {
        enableConsolidation();
        usdc.mint(address(settlement), 10_000);
        venue.setRateBps(9_899); // delivers 9899 against a floor of 9900

        vm.prank(ownerSafe);
        vm.expectRevert("OFL: slippage");
        liq.consolidate(
            oneInput(address(usdc), 0),
            address(weth),
            9_900, // quote 10_000 with the 100 bps runner cap
            address(venue),
            venueSwapData(address(usdc), 10_000)
        );
    }

    function test_consolidate_boundary_at_exact_floor_succeeds() public {
        enableConsolidation();
        usdc.mint(address(settlement), 10_000);
        venue.setRateBps(9_900);

        vm.prank(ownerSafe);
        uint256 amountOut = liq.consolidate(
            oneInput(address(usdc), 0), address(weth), 9_900, address(venue), venueSwapData(address(usdc), 10_000)
        );
        assertEq(amountOut, 9_900);
    }

    function test_consolidate_misdirected_output_reverts() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1000e6);
        venue.setMisdirectTo(stranger); // venue ignores the recipient

        vm.prank(ownerSafe);
        vm.expectRevert("OFL: slippage");
        liq.consolidate(
            oneInput(address(usdc), 0), address(weth), 990e6, address(venue), venueSwapData(address(usdc), 1000e6)
        );
    }

    function test_consolidate_sticky_allowance_reverts() public {
        enableConsolidation();
        StickyApproveERC20 sticky = new StickyApproveERC20();
        sticky.mint(address(settlement), 100e18);

        // Venue only pulls 60 of the 100 approved; the revoke is ignored by
        // the token, so 40 of allowance would survive the settlement.
        bytes memory data =
            abi.encodeCall(MockVenueRouter.swap, (MockERC20(address(sticky)), 60e18, weth, address(settlement)));
        vm.prank(ownerSafe);
        vm.expectRevert("OFL: allowance left");
        liq.consolidate(oneInput(address(sticky), 0), address(weth), 1, address(venue), data);
    }

    function test_consolidate_partial_pull_with_standard_token_succeeds() public {
        enableConsolidation();
        usdc.mint(address(settlement), 100e6);

        // Venue pulls only 60 of the approved 100; the same-settle revoke
        // still zeroes the remainder, so the invariant holds.
        bytes memory data = venueSwapData(address(usdc), 60e6);
        vm.prank(ownerSafe);
        uint256 amountOut = liq.consolidate(oneInput(address(usdc), 0), address(weth), 50e6, address(venue), data);
        assertEq(amountOut, 60e6);
        assertEq(usdc.allowance(address(settlement), address(venue)), 0);
        assertEq(usdc.balanceOf(address(settlement)), 40e6);
    }

    /// Zeroing the liquidator key does NOT disable consolidation: it is an
    /// owner capability, orthogonal to the hot-key pause. The owner still
    /// consolidates while the ops-key sweep path is paused.
    function test_consolidate_unaffected_by_liquidator_pause() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1000e6);
        vm.prank(ownerSafe);
        liq.setLiquidator(address(0));

        vm.prank(ownerSafe);
        uint256 amountOut = liq.consolidate(
            oneInput(address(usdc), 0), address(weth), 990e6, address(venue), venueSwapData(address(usdc), 1000e6)
        );
        assertEq(amountOut, 1000e6);
    }

    function test_consolidate_reverts_when_not_a_solver() public {
        enableConsolidation();
        usdc.mint(address(settlement), 1e6);
        vm.prank(manager);
        allowList.removeSolver(address(liq));
        vm.prank(ownerSafe);
        vm.expectRevert("GPv2: not a solver");
        liq.consolidate(oneInput(address(usdc), 0), address(weth), 1, address(venue), venueSwapData(address(usdc), 1e6));
    }

    // --- fuzz ---

    /// Sweep amount resolution: 0 = full balance, otherwise exact, never more
    /// than the settlement holds.
    function testFuzz_sweep_amount_math(uint256 balance, uint256 requested) public {
        balance = bound(balance, 1, 1e30);
        requested = bound(requested, 0, balance);
        usdc.mint(address(settlement), balance);

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = requested;

        uint256 expected = requested == 0 ? balance : requested;
        vm.prank(ops);
        liq.sweep(tokens, amounts);

        assertEq(usdc.balanceOf(feeSafe), expected);
        assertEq(usdc.balanceOf(address(settlement)), balance - expected);
    }

    function testFuzz_sweep_over_balance_reverts(uint256 balance, uint256 requested) public {
        balance = bound(balance, 0, 1e30);
        requested = bound(requested, balance + 1, type(uint128).max);
        if (balance > 0) {
            usdc.mint(address(settlement), balance);
        }
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = requested;
        vm.prank(ops);
        vm.expectRevert("OFL: amount exceeds balance");
        liq.sweep(tokens, amounts);
    }

    /// The amountMin floor math end to end: the runner computes
    /// `min = quote * (10_000 - slippageBps) / 10_000`; the venue actually
    /// delivers at `actualRateBps`. The call must succeed exactly when the
    /// delivered amount clears the floor (and the floor is non-zero).
    function testFuzz_consolidate_amount_min_floor(
        uint256 amountIn,
        uint256 quoteRateBps,
        uint256 actualRateBps,
        uint256 slippageBps
    ) public {
        amountIn = bound(amountIn, 1, 1e27);
        quoteRateBps = bound(quoteRateBps, 1, 20_000);
        actualRateBps = bound(actualRateBps, 0, 20_000);
        slippageBps = bound(slippageBps, 0, 10_000);

        enableConsolidation();
        usdc.mint(address(settlement), amountIn);
        venue.setRateBps(actualRateBps);

        uint256 quote = (amountIn * quoteRateBps) / 10_000;
        uint256 amountOutMin = (quote * (10_000 - slippageBps)) / 10_000;
        uint256 delivered = (amountIn * actualRateBps) / 10_000;

        vm.prank(ownerSafe);
        if (amountOutMin == 0) {
            vm.expectRevert("OFL: zero amountOutMin");
            liq.consolidate(
                oneInput(address(usdc), 0),
                address(weth),
                amountOutMin,
                address(venue),
                venueSwapData(address(usdc), amountIn)
            );
        } else if (delivered < amountOutMin) {
            vm.expectRevert("OFL: slippage");
            liq.consolidate(
                oneInput(address(usdc), 0),
                address(weth),
                amountOutMin,
                address(venue),
                venueSwapData(address(usdc), amountIn)
            );
        } else {
            uint256 amountOut = liq.consolidate(
                oneInput(address(usdc), 0),
                address(weth),
                amountOutMin,
                address(venue),
                venueSwapData(address(usdc), amountIn)
            );
            assertEq(amountOut, delivered);
            assertEq(weth.balanceOf(address(settlement)), delivered);
            assertEq(usdc.allowance(address(settlement), address(venue)), 0);
        }
    }

    /// Success-path conservation: input leaves the settlement for the venue,
    /// output lands in the settlement, nothing sticks to the liquidator.
    function testFuzz_consolidate_accounting(uint256 amountIn, uint256 rateBps) public {
        amountIn = bound(amountIn, 1, 1e27);
        rateBps = bound(rateBps, 1, 20_000);

        enableConsolidation();
        usdc.mint(address(settlement), amountIn);
        venue.setRateBps(rateBps);
        uint256 delivered = (amountIn * rateBps) / 10_000;
        vm.assume(delivered > 0);

        vm.prank(ownerSafe);
        uint256 amountOut = liq.consolidate(
            oneInput(address(usdc), 0),
            address(weth),
            delivered, // exact floor
            address(venue),
            venueSwapData(address(usdc), amountIn)
        );

        assertEq(amountOut, delivered);
        assertEq(usdc.balanceOf(address(settlement)), 0);
        assertEq(usdc.balanceOf(address(venue)), amountIn);
        assertEq(weth.balanceOf(address(settlement)), delivered);
        assertEq(usdc.balanceOf(address(liq)), 0);
        assertEq(weth.balanceOf(address(liq)), 0);
        assertEq(usdc.allowance(address(settlement), address(venue)), 0);
    }
}
