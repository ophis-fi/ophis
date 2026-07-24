// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {IERC20} from "src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "src/contracts/libraries/GPv2Order.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

import {MockERC20, MockFeed, MockSafe, MockSettlement} from "./Mocks.sol";

/// @dev Handler the invariant fuzzer drives. It IS the curator (so it can
/// call rebalance), builds random - including deliberately policy-VIOLATING -
/// orders, and records every order that actually got presigned so the
/// invariants can prove no bad order ever slips through.
contract Handler is Test {
    OphisVaultPolicyModule public module;
    MockSafe public safe;
    MockSettlement public settlement;
    MockFeed public usdcFeed;
    MockFeed public wethFeed;
    address public usdc;
    address public weth;
    address public rogue; // NOT allowlisted
    bytes32 public appData;

    struct Rec {
        bytes uid;
        address receiver;
        address sellToken;
        address buyToken;
        uint256 feeAmount;
        bytes32 appData;
        uint256 sellAmount;
    }

    Rec[] public recs;

    constructor(
        OphisVaultPolicyModule _module,
        MockSafe _safe,
        MockSettlement _settlement,
        MockFeed _usdcFeed,
        MockFeed _wethFeed,
        address _usdc,
        address _weth,
        address _rogue,
        bytes32 _appData
    ) {
        module = _module;
        safe = _safe;
        settlement = _settlement;
        usdcFeed = _usdcFeed;
        wethFeed = _wethFeed;
        usdc = _usdc;
        weth = _weth;
        rogue = _rogue;
        appData = _appData;
    }

    function recCount() external view returns (uint256) {
        return recs.length;
    }

    function _tok(uint8 sel) internal view returns (address) {
        uint8 s = sel % 3;
        if (s == 0) return usdc;
        if (s == 1) return weth;
        return rogue;
    }

    function doRebalance(uint8 sSel, uint8 bSel, uint96 sellAmt, uint96 override_, uint16 ttl, uint8 badBits) external {
        address st = _tok(sSel);
        address bt = _tok(bSel);
        uint8 dec = st == weth ? 18 : (st == usdc ? 6 : 18);
        uint256 sellAmount = bound(uint256(sellAmt), 1, 5000 * (10 ** dec));
        uint32 validTo = uint32(block.timestamp + bound(uint256(ttl), 1, module.maxTtl()));

        GPv2Order.Data memory o = GPv2Order.Data({
            sellToken: IERC20(st),
            buyToken: IERC20(bt),
            receiver: (badBits & 1) != 0 ? address(0xBAD) : address(safe),
            sellAmount: sellAmount,
            buyAmount: 1e30, // always clears the floor; turnover keys off sell side
            validTo: validTo,
            appData: (badBits & 4) != 0 ? bytes32(uint256(1)) : appData,
            feeAmount: (badBits & 2) != 0 ? 1 : 0,
            kind: (badBits & 8) != 0 ? GPv2Order.KIND_BUY : GPv2Order.KIND_SELL,
            partiallyFillable: (badBits & 16) != 0,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });

        try module.rebalance(o, bound(uint256(override_), 0, 1e29)) returns (bytes memory uid) {
            recs.push(Rec(uid, o.receiver, st, bt, o.feeAmount, o.appData, o.sellAmount));
        } catch {
            // policy-violating or cap-exceeding orders revert: expected
        }
    }

    function doCancel(uint256 seed) external {
        uint256 n = recs.length;
        if (n == 0) return;
        bytes memory uid = recs[seed % n].uid;
        try module.cancel(uid) {} catch {}
    }

    function doWarp(uint16 dt) external {
        vm.warp(block.timestamp + bound(uint256(dt), 0, 2 days));
        // keep feeds fresh so staleness doesn't monopolize the reverts
        usdcFeed.set(1e8, block.timestamp);
        wethFeed.set(2000e8, block.timestamp);
    }

    function doMoveOracle(uint16 seed) external {
        wethFeed.set(int256(bound(uint256(seed), 1000e8, 4000e8)), block.timestamp);
    }
}

contract OphisVaultPolicyModuleInvariant is StdInvariant, Test {
    uint256 internal constant T0 = 1_000_000_000;
    uint256 internal constant CAP = 10_000e18; // $10k/day rolling
    bytes32 internal constant APP_DATA = keccak256("ophis-partner-fee-appdata");
    address internal constant RELAYER = address(0xBEEF00000000000000000000000000000000BEEf);

    MockSafe internal safe;
    MockSettlement internal settlement;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockERC20 internal rogue;
    MockFeed internal usdcFeed;
    MockFeed internal wethFeed;
    OphisVaultPolicyModule internal module;
    Handler internal handler;

    function setUp() public {
        vm.warp(T0);
        address[] memory owners = new address[](1);
        owners[0] = address(0xA11CE);
        safe = new MockSafe(owners);
        settlement = new MockSettlement(keccak256("inv domain"), RELAYER);
        usdc = new MockERC20(6);
        weth = new MockERC20(18);
        rogue = new MockERC20(18);
        usdcFeed = new MockFeed(8, 1e8, T0);
        wethFeed = new MockFeed(8, 2000e8, T0);

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(address(usdc), IAggregatorV3(address(usdcFeed)), 3600, 25e16, 4e18);
        tokens[1] =
            OphisVaultPolicyModule.TokenFeed(address(weth), IAggregatorV3(address(wethFeed)), 3600, 500e18, 8000e18);

        // curator == the handler, so the fuzzer can drive rebalance/cancel.
        handler = Handler(address(0)); // placeholder; set after module (needs curator addr)
        address predictedHandler = computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        module = new OphisVaultPolicyModule(
            OphisVaultPolicyModule.ModuleConfig({
                safe: ISafe(address(safe)),
                settlement: IGPv2Settlement(address(settlement)),
                curator: predictedHandler,
                appDataHash: APP_DATA,
                maxSlippageBps: 50,
                maxTtl: 1800,
                dailyUsdTurnoverCap: CAP,
                sequencerUptimeFeed: IAggregatorV3(address(0)),
                sequencerGracePeriod: 0,
                tokens: tokens
            })
        );
        handler = new Handler(
            module, safe, settlement, usdcFeed, wethFeed, address(usdc), address(weth), address(rogue), APP_DATA
        );
        require(address(handler) == predictedHandler, "curator address mismatch");
        safe.setEnabledModule(address(module));

        targetContract(address(handler));
    }

    /// Coverage sanity: prove the handler actually reaches the presign path,
    /// so `invariant_no_bad_presignature_survives` is not vacuously true.
    function test_handler_reaches_presign_path() public {
        // A clean order (badBits = 0): allowlisted USDC -> WETH, receiver ==
        // Safe, zero fee, pinned appData, sell-kind. Must presign + record.
        handler.doRebalance(0, 1, uint96(1000e6), 0, 1000, 0);
        assertEq(handler.recCount(), 1, "clean order did not presign");
        (bytes memory uid,,,,,,) = handler.recs(0);
        assertEq(settlement.preSignature(uid), settlement.PRE_SIGNED());
        // And a bad order (foreign receiver) must NOT record.
        handler.doRebalance(0, 1, uint96(1000e6), 0, 1000, 1);
        assertEq(handler.recCount(), 1, "bad order slipped into the record");
    }

    /// The leaky-bucket accumulator must NEVER exceed the cap, under any
    /// sequence of rebalances, cancels, time warps, and oracle moves.
    function invariant_turnover_never_exceeds_cap() public view {
        assertLe(module.turnoverSpentUsd(), CAP);
    }

    /// No policy-violating order can ever hold a live presignature: every uid
    /// the module presigned (and hasn't cancelled) must have receiver == the
    /// Safe, feeAmount == 0, the pinned appData, and two allowlisted tokens.
    function invariant_no_bad_presignature_survives() public view {
        uint256 n = handler.recCount();
        for (uint256 i = 0; i < n; i++) {
            (bytes memory uid, address receiver, address sellToken, address buyToken, uint256 feeAmount, bytes32 ad,) =
                handler.recs(i);
            if (settlement.preSignature(uid) != settlement.PRE_SIGNED()) continue;
            assertEq(receiver, address(safe), "presigned order with foreign receiver");
            assertEq(feeAmount, 0, "presigned order with non-zero signed fee");
            assertEq(ad, APP_DATA, "presigned order with wrong appData");
            assertTrue(
                (sellToken == address(usdc) || sellToken == address(weth))
                    && (buyToken == address(usdc) || buyToken == address(weth)) && sellToken != buyToken,
                "presigned order with non-allowlisted or same token"
            );
        }
    }

    /// Regression guard for the reconciliation (superseded-order un-presign +
    /// combined allowance tracking): for EACH sell token there is at most one
    /// order holding a live presignature, and the relayer allowance for that
    /// token equals exactly that order's sellAmount (0 when none is live). This
    /// is the property whose absence WAS the pre-reconciliation drain bug (two
    /// live same-token orders sharing one allowance); a future edit dropping the
    /// supersede-time revoke would trip this invariant instead of shipping.
    function invariant_one_live_presign_and_exact_allowance_per_sellToken() public view {
        _checkSellToken(address(usdc));
        _checkSellToken(address(weth));
        _checkSellToken(address(rogue)); // never allowlisted: must stay empty
    }

    function _checkSellToken(address token) internal view {
        uint256 n = handler.recCount();
        bytes memory liveUid;
        uint256 liveSellAmount;
        uint256 liveCount;
        for (uint256 i = 0; i < n; i++) {
            (bytes memory uid,, address sellToken,,,, uint256 sellAmount) = handler.recs(i);
            if (sellToken != token) continue;
            if (settlement.preSignature(uid) != settlement.PRE_SIGNED()) continue;
            // The same uid re-presigned (self-supersede) is ONE live order.
            if (liveCount == 1 && keccak256(uid) == keccak256(liveUid)) continue;
            liveUid = uid;
            liveSellAmount = sellAmount;
            liveCount++;
        }
        assertLe(liveCount, 1, "more than one live presigned order for a sell token");
        uint256 onchain = IERC20(token).allowance(address(safe), RELAYER);
        if (liveCount == 1) {
            assertEq(onchain, liveSellAmount, "relayer allowance != live order sellAmount");
        } else {
            assertEq(onchain, 0, "residual relayer allowance with no live order");
        }
    }
}
