// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.8.17 <0.9.0;

import {IERC20} from "../../../src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "../../../src/contracts/libraries/GPv2Order.sol";
import {OphisVaultPolicyModule} from "../../../src/contracts/vault/OphisVaultPolicyModule.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "../../../src/contracts/vault/interfaces/IVaultPolicyDeps.sol";
import {MockERC20, MockFeed, MockSafe, MockSettlement} from "../../vault/Mocks.sol";

/// @title Echidna property harness for the vault order-policy module.
/// @notice The harness IS the curator (deploys the module with
/// `curator = address(this)`), so Echidna's fuzzed calls to `rebalance`/
/// `cancel` reach the module as the authorized caller. Two properties encode
/// the drain invariants:
///   echidna_turnover_within_cap        - leaky bucket never exceeds the cap
///   echidna_no_bad_presignature        - no policy-violating order is ever
///                                        left presigned
/// Both are time-robust (the cap is an upper bound that only decays with time;
/// the policy check is time-independent), so Echidna's own timestamp jitter
/// needs no explicit warp cheatcode.
contract VaultPolicyEchidna {
    uint256 internal constant CAP = 10_000e18;
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

    struct Rec {
        bytes uid;
        address receiver;
        address sellToken;
        address buyToken;
        uint256 feeAmount;
        bytes32 appData;
    }

    Rec[] internal recs;

    constructor() {
        address[] memory owners = new address[](1);
        owners[0] = address(0xA11CE);
        safe = new MockSafe(owners);
        settlement = new MockSettlement(keccak256("echidna domain"), RELAYER);
        usdc = new MockERC20(6);
        weth = new MockERC20(18);
        rogue = new MockERC20(18);
        usdcFeed = new MockFeed(8, 1e8, block.timestamp);
        wethFeed = new MockFeed(8, 2000e8, block.timestamp);

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] =
            OphisVaultPolicyModule.TokenFeed(address(usdc), IAggregatorV3(address(usdcFeed)), 1 days, 25e16, 4e18);
        tokens[1] =
            OphisVaultPolicyModule.TokenFeed(address(weth), IAggregatorV3(address(wethFeed)), 1 days, 500e18, 8000e18);

        module = new OphisVaultPolicyModule(
            OphisVaultPolicyModule.ModuleConfig({
                safe: ISafe(address(safe)),
                settlement: IGPv2Settlement(address(settlement)),
                curator: address(this), // the harness drives rebalance/cancel
                appDataHash: APP_DATA,
                maxSlippageBps: 50,
                maxTtl: 1800,
                dailyUsdTurnoverCap: CAP,
                sequencerUptimeFeed: IAggregatorV3(address(0)),
                sequencerGracePeriod: 0,
                tokens: tokens
            })
        );
        safe.setEnabledModule(address(module));
    }

    function _tok(uint8 sel) internal view returns (address) {
        uint8 s = sel % 3;
        if (s == 0) return address(usdc);
        if (s == 1) return address(weth);
        return address(rogue);
    }

    // keep the oracle fresh so Echidna's timestamp jitter doesn't turn every
    // call into a staleness revert
    function _refresh() internal {
        usdcFeed.set(1e8, block.timestamp);
        wethFeed.set(2000e8, block.timestamp);
    }

    function rebalance(uint8 sSel, uint8 bSel, uint96 sellAmt, uint96 override_, uint16 ttl, uint8 badBits) public {
        _refresh();
        address st = _tok(sSel);
        address bt = _tok(bSel);
        uint8 dec = st == address(weth) ? 18 : (st == address(usdc) ? 6 : 18);
        uint256 sellAmount = 1 + (uint256(sellAmt) % (5000 * (10 ** dec)));
        uint32 validTo = uint32(block.timestamp + 1 + (uint256(ttl) % module.maxTtl()));

        GPv2Order.Data memory o = GPv2Order.Data({
            sellToken: IERC20(st),
            buyToken: IERC20(bt),
            receiver: (badBits & 1) != 0 ? address(0xBAD) : address(safe),
            sellAmount: sellAmount,
            buyAmount: 1e30,
            validTo: validTo,
            appData: (badBits & 4) != 0 ? bytes32(uint256(1)) : APP_DATA,
            feeAmount: (badBits & 2) != 0 ? 1 : 0,
            kind: (badBits & 8) != 0 ? GPv2Order.KIND_BUY : GPv2Order.KIND_SELL,
            partiallyFillable: (badBits & 16) != 0,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });

        try module.rebalance(o, uint256(override_) % 1e29) returns (bytes memory uid) {
            recs.push(Rec(uid, o.receiver, st, bt, o.feeAmount, o.appData));
        } catch {}
    }

    function cancel(uint256 seed) public {
        uint256 n = recs.length;
        if (n == 0) return;
        try module.cancel(recs[seed % n].uid) {} catch {}
    }

    // --- properties ---

    function echidna_turnover_within_cap() public view returns (bool) {
        return module.turnoverSpentUsd() <= CAP;
    }

    function echidna_no_bad_presignature() public view returns (bool) {
        for (uint256 i = 0; i < recs.length; i++) {
            Rec storage r = recs[i];
            if (settlement.preSignature(r.uid) != settlement.PRE_SIGNED()) continue;
            if (r.receiver != address(safe)) return false;
            if (r.feeAmount != 0) return false;
            if (r.appData != APP_DATA) return false;
            bool okTokens = (r.sellToken == address(usdc) || r.sellToken == address(weth))
                && (r.buyToken == address(usdc) || r.buyToken == address(weth)) && r.sellToken != r.buyToken;
            if (!okTokens) return false;
        }
        return true;
    }
}
