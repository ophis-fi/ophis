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
        module = new OphisVaultPolicyModule(
            ISafe(address(safe)),
            IGPv2Settlement(address(settlement)),
            CURATOR,
            APP_DATA,
            50, // maxSlippageBps
            1800, // maxTtl
            3600, // maxOracleStaleness
            tokenFeeds()
        );
        safe.setEnabledModule(address(module));
    }

    function tokenFeeds()
        internal
        view
        returns (OphisVaultPolicyModule.TokenFeed[] memory tokens)
    {
        tokens = new OphisVaultPolicyModule.TokenFeed[](3);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(address(usdc), IAggregatorV3(address(usdcFeed)));
        tokens[1] = OphisVaultPolicyModule.TokenFeed(address(weth), IAggregatorV3(address(wethFeed)));
        tokens[2] = OphisVaultPolicyModule.TokenFeed(address(usdt), IAggregatorV3(address(usdtFeed)));
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

    function test_stale_oracle_reverts() public {
        vm.warp(T0 + 3601); // usdcFeed.updatedAt == T0, staleness cap 3600
        GPv2Order.Data memory order = validOrder(); // validTo re-derived after warp
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.StaleOraclePrice.selector,
                address(usdcFeed)
            )
        );
        rebalanceAsCurator(order, 0);
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
    // Cancel (risk-reducing only)
    // ------------------------------------------------------------------

    function test_curator_can_cancel_its_presignature() public {
        bytes memory uid = rebalanceAsCurator(validOrder(), 0);
        assertEq(settlement.preSignature(uid), settlement.PRE_SIGNED());
        vm.prank(CURATOR);
        module.cancel(uid);
        assertEq(settlement.preSignature(uid), 0);
    }

    function test_non_curator_cannot_cancel() public {
        bytes memory uid = rebalanceAsCurator(validOrder(), 0);
        vm.expectRevert(OphisVaultPolicyModule.NotCurator.selector);
        module.cancel(uid);
    }

    function test_cancel_of_foreign_uid_fails_closed() public {
        // A uid owned by someone else: the settlement's owner check refuses
        // it, and the module surfaces the failed exec instead of ignoring it.
        bytes memory foreignUid = new bytes(GPv2Order.UID_LENGTH);
        GPv2Order.packOrderUidParams(
            foreignUid,
            keccak256("foreign digest"),
            address(0xD00D),
            uint32(block.timestamp + 100)
        );
        vm.prank(CURATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModule.ModuleExecFailed.selector,
                address(settlement)
            )
        );
        module.cancel(foreignUid);
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

    function newModule(
        address curator_,
        uint256 slippage,
        uint256 ttl,
        uint256 staleness,
        OphisVaultPolicyModule.TokenFeed[] memory tokens
    ) internal returns (OphisVaultPolicyModule) {
        return new OphisVaultPolicyModule(
            ISafe(address(safe)),
            IGPv2Settlement(address(settlement)),
            curator_,
            APP_DATA,
            slippage,
            ttl,
            staleness,
            tokens
        );
    }

    function test_constructor_rejects_bad_config() public {
        OphisVaultPolicyModule.TokenFeed[] memory tokens = tokenFeeds();

        vm.expectRevert(OphisVaultPolicyModule.ZeroAddress.selector);
        newModule(address(0), 50, 1800, 3600, tokens);

        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        newModule(address(safe), 50, 1800, 3600, tokens); // curator == safe

        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        newModule(CURATOR, 5001, 1800, 3600, tokens); // slippage over cap

        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        newModule(CURATOR, 50, 0, 3600, tokens); // zero ttl

        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        newModule(CURATOR, 50, 1 days + 1, 3600, tokens); // ttl over cap

        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        newModule(CURATOR, 50, 1800, 0, tokens); // zero staleness

        OphisVaultPolicyModule.TokenFeed[] memory single =
            new OphisVaultPolicyModule.TokenFeed[](1);
        single[0] = tokens[0];
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        newModule(CURATOR, 50, 1800, 3600, single); // fewer than 2 tokens

        OphisVaultPolicyModule.TokenFeed[] memory dup =
            new OphisVaultPolicyModule.TokenFeed[](2);
        dup[0] = tokens[0];
        dup[1] = tokens[0];
        vm.expectRevert(OphisVaultPolicyModule.BadConfig.selector);
        newModule(CURATOR, 50, 1800, 3600, dup); // duplicate token
    }

    function test_constructor_probes_feed_liveness() public {
        OphisVaultPolicyModule.TokenFeed[] memory tokens = tokenFeeds();
        usdcFeed.set(1e8, T0 - 3601); // stale at deploy
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.StaleOraclePrice.selector,
                address(usdcFeed)
            )
        );
        newModule(CURATOR, 50, 1800, 3600, tokens);

        usdcFeed.set(0, T0); // invalid price at deploy
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisChainlinkFloor.InvalidOraclePrice.selector,
                address(usdcFeed)
            )
        );
        newModule(CURATOR, 50, 1800, 3600, tokens);
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
        vm.expectRevert(
            abi.encodeWithSelector(
                OphisVaultPolicyModuleFactory.CuratorIsSafeOwner.selector,
                SAFE_OWNER
            )
        );
        factory.deploy(
            ISafe(address(safe)),
            IGPv2Settlement(address(settlement)),
            SAFE_OWNER, // curator IS an owner: refused
            APP_DATA,
            50,
            1800,
            3600,
            tokenFeeds()
        );
    }

    function test_factory_deploys_configured_module() public {
        OphisVaultPolicyModuleFactory factory = new OphisVaultPolicyModuleFactory();
        OphisVaultPolicyModule deployed = factory.deploy(
            ISafe(address(safe)),
            IGPv2Settlement(address(settlement)),
            CURATOR,
            APP_DATA,
            50,
            1800,
            3600,
            tokenFeeds()
        );
        assertEq(deployed.curator(), CURATOR);
        assertEq(address(deployed.safe()), address(safe));
        assertEq(deployed.relayer(), RELAYER);
        (bool allowed, , , uint8 tokenDecimals) = deployed.tokenPolicy(address(weth));
        assertTrue(allowed);
        assertEq(tokenDecimals, 18);
    }
}
