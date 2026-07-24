// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.8.17 <0.9.0;

import {IERC20} from "../../../src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "../../../src/contracts/libraries/GPv2Order.sol";
import {OphisChainlinkFloor} from "../../../src/contracts/vault/OphisChainlinkFloor.sol";
import {OphisVaultPolicyModule} from "../../../src/contracts/vault/OphisVaultPolicyModule.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "../../../src/contracts/vault/interfaces/IVaultPolicyDeps.sol";
import {MockERC20, MockFeed, MockSafe, MockSequencerUptimeFeed, MockSettlement} from "../../vault/Mocks.sol";

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
    uint256 internal constant MAX_TTL = 1800;
    uint256 internal constant SEQUENCER_GRACE_PERIOD = 3600;
    bytes32 internal constant APP_DATA = keccak256("ophis-partner-fee-appdata");
    address internal constant RELAYER = address(0xBEEF00000000000000000000000000000000BEEf);

    MockSafe internal safe;
    MockSettlement internal settlement;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockERC20 internal rogue;
    MockFeed internal usdcFeed;
    MockFeed internal wethFeed;
    MockSequencerUptimeFeed internal sequencerFeed;
    OphisVaultPolicyModule internal module;

    struct Rec {
        bytes uid;
        address receiver;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 buyAmount;
        uint256 oracleFloor;
        uint32 validTo;
        uint256 feeAmount;
        bytes32 appData;
        bytes32 kind;
        bool partiallyFillable;
        uint256 createdAt;
        bool createdDuringSequencerBlock;
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
        uint256 initialSequencerStartedAt =
            block.timestamp > SEQUENCER_GRACE_PERIOD ? block.timestamp - SEQUENCER_GRACE_PERIOD : 1;
        sequencerFeed = new MockSequencerUptimeFeed(0, initialSequencerStartedAt, block.timestamp);

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
                maxTtl: MAX_TTL,
                dailyUsdTurnoverCap: CAP,
                sequencerUptimeFeed: IAggregatorV3(address(sequencerFeed)),
                sequencerGracePeriod: SEQUENCER_GRACE_PERIOD,
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

    function _tokenDecimals(address token) internal view returns (uint8) {
        if (token == address(usdc)) return 6;
        if (token == address(weth)) return 18;
        return 18;
    }

    function _isAllowedToken(address token) internal view returns (bool) {
        return token == address(usdc) || token == address(weth);
    }

    function _feed(address token) internal view returns (MockFeed) {
        if (token == address(usdc)) return usdcFeed;
        return wethFeed;
    }

    function _minPrice18(address token) internal view returns (uint256) {
        if (token == address(usdc)) return 25e16;
        return 500e18;
    }

    function _maxPrice18(address token) internal view returns (uint256) {
        if (token == address(usdc)) return 4e18;
        return 8000e18;
    }

    function _readPrice18(address token) internal view returns (uint256) {
        return OphisChainlinkFloor.read18(
            IAggregatorV3(address(_feed(token))), 8, 1 days, _minPrice18(token), _maxPrice18(token)
        );
    }

    function _oracleFloor(address sellToken, address buyToken, uint256 sellAmount) internal view returns (uint256) {
        if (!_isAllowedToken(sellToken) || !_isAllowedToken(buyToken) || sellToken == buyToken) return 0;
        return OphisChainlinkFloor.floorBuyAmount(
            sellAmount,
            _readPrice18(sellToken),
            _tokenDecimals(sellToken),
            _readPrice18(buyToken),
            _tokenDecimals(buyToken),
            module.maxSlippageBps()
        );
    }

    function _mappedBuyAmount(
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint96 buyAmt
    ) internal view returns (uint256) {
        uint256 floor = _oracleFloor(sellToken, buyToken, sellAmount);
        if (floor == 0) return 1 + (uint256(buyAmt) % 1e30);
        uint256 pct = 50 + (uint256(buyAmt) % 101); // 50% to 150% of floor
        uint256 mapped = (floor * pct) / 100;
        if (mapped == 0) return 1;
        return mapped;
    }

    function _sequencerBlocked() internal view returns (bool) {
        (, int256 answer, uint256 startedAt, , ) = sequencerFeed.latestRoundData();
        return answer != 0 || startedAt == 0 || startedAt > block.timestamp
            || block.timestamp - startedAt < SEQUENCER_GRACE_PERIOD;
    }

    function rebalance(uint8 sSel, uint8 bSel, uint96 sellAmt, uint96 buyAmt, uint96 override_, uint16 ttl, uint8 badBits)
        public
    {
        _refresh();
        address st = _tok(sSel);
        address bt = _tok(bSel);
        uint8 dec = _tokenDecimals(st);
        uint256 sellAmount = 1 + (uint256(sellAmt) % (5000 * (10 ** dec)));
        uint32 validTo = uint32(block.timestamp + 1 + (uint256(ttl) % module.maxTtl()));
        uint256 oracleFloor = _oracleFloor(st, bt, sellAmount);
        uint256 buyAmount = _mappedBuyAmount(st, bt, sellAmount, buyAmt);
        bool sequencerBlockedAtCreate = _sequencerBlocked();

        GPv2Order.Data memory o = GPv2Order.Data({
            sellToken: IERC20(st),
            buyToken: IERC20(bt),
            receiver: (badBits & 1) != 0 ? address(0xBAD) : address(safe),
            sellAmount: sellAmount,
            buyAmount: buyAmount,
            validTo: validTo,
            appData: (badBits & 4) != 0 ? bytes32(uint256(1)) : APP_DATA,
            feeAmount: (badBits & 2) != 0 ? 1 : 0,
            kind: (badBits & 8) != 0 ? GPv2Order.KIND_BUY : GPv2Order.KIND_SELL,
            partiallyFillable: (badBits & 16) != 0,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });

        try module.rebalance(o, uint256(override_) % 1e29) returns (bytes memory uid) {
            recs.push(
                Rec(
                    uid,
                    o.receiver,
                    st,
                    bt,
                    o.sellAmount,
                    o.buyAmount,
                    oracleFloor,
                    o.validTo,
                    o.feeAmount,
                    o.appData,
                    o.kind,
                    o.partiallyFillable,
                    block.timestamp,
                    sequencerBlockedAtCreate
                )
            );
        } catch {}
    }

    function sequencerUp(uint16 age) public {
        uint256 targetAge = SEQUENCER_GRACE_PERIOD + (uint256(age) % 1 days);
        uint256 startedAt = block.timestamp > targetAge ? block.timestamp - targetAge : 1;
        sequencerFeed.setStatus(0, startedAt);
    }

    function sequencerDown(uint16 age) public {
        uint256 targetAge = uint256(age) % 1 days;
        uint256 startedAt = block.timestamp > targetAge ? block.timestamp - targetAge : 1;
        sequencerFeed.setStatus(1, startedAt);
    }

    function sequencerRecentlyRestored(uint16 age) public {
        uint256 targetAge = uint256(age) % SEQUENCER_GRACE_PERIOD;
        uint256 startedAt = block.timestamp > targetAge ? block.timestamp - targetAge : 1;
        sequencerFeed.setStatus(0, startedAt);
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
            if (r.kind != GPv2Order.KIND_SELL) return false;
            if (r.partiallyFillable) return false;
            if (r.validTo <= r.createdAt || r.validTo > r.createdAt + module.maxTtl()) return false;
            bool okTokens = (r.sellToken == address(usdc) || r.sellToken == address(weth))
                && (r.buyToken == address(usdc) || r.buyToken == address(weth)) && r.sellToken != r.buyToken;
            if (!okTokens) return false;
            if (r.buyAmount < r.oracleFloor) return false;
        }
        return true;
    }

    function echidna_no_sequencer_blocked_presignature() public view returns (bool) {
        for (uint256 i = 0; i < recs.length; i++) {
            Rec storage r = recs[i];
            if (settlement.preSignature(r.uid) != settlement.PRE_SIGNED()) continue;
            if (r.createdDuringSequencerBlock) return false;
        }
        return true;
    }

    function echidna_one_live_presign_and_exact_allowance_per_sellToken() public view returns (bool) {
        return _checkSellToken(address(usdc)) && _checkSellToken(address(weth)) && _checkSellToken(address(rogue));
    }

    function _checkSellToken(address token) internal view returns (bool) {
        bytes32 liveUidHash;
        uint256 liveSellAmount;
        uint256 liveCount;
        for (uint256 i = 0; i < recs.length; i++) {
            Rec storage r = recs[i];
            if (r.sellToken != token) continue;
            if (settlement.preSignature(r.uid) != settlement.PRE_SIGNED()) continue;
            bytes32 uidHash = keccak256(r.uid);
            if (liveCount == 1 && uidHash == liveUidHash) continue;
            liveUidHash = uidHash;
            liveSellAmount = r.sellAmount;
            liveCount++;
        }
        if (liveCount > 1) return false;
        uint256 onchain = IERC20(token).allowance(address(safe), RELAYER);
        if (liveCount == 1) return onchain == liveSellAmount;
        return onchain == 0;
    }
}
