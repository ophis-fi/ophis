// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.8.17 <0.9.0;

import {IERC20} from "../interfaces/IERC20.sol";
import {GPv2Order} from "../libraries/GPv2Order.sol";
import {ReentrancyGuard} from "../mixins/ReentrancyGuard.sol";
import {OphisChainlinkFloor} from "./OphisChainlinkFloor.sol";
import {
    IAggregatorV3,
    IERC20Metadata,
    IGPv2Settlement,
    ISafe
} from "./interfaces/IVaultPolicyDeps.sol";

/// @title Ophis vault order-policy module (Phase B)
/// @notice A Safe module that closes the Phase-A residual of the vault-curator
/// rebalance venue: it decodes the FULL CoW order ON-CHAIN and enforces the
/// policy (receiver == the vault Safe, token allowlist, oracle-backed minimum
/// out, pinned Ophis fee appData, rolling USD turnover cap, L2-sequencer-aware
/// oracle reads) BEFORE any presignature can exist. A compromised curator key
/// can therefore only ever trigger policy-valid rebalances - it cannot drain
/// the vault, and its worst-case damage is bounded:
///
///   loss over any rolling 24h <= ~dailyUsdTurnoverCap * (maxSlippageBps/1e4
///                                + fees + intra-TTL market drift)
///
/// The turnover accountant is a LEAKY BUCKET (drains at the cap per day) rather
/// than a calendar bucket, so there is no UTC-midnight cliff to straddle: the
/// instantaneous burst is bounded to the cap and the sustained rate to the cap
/// per rolling day.
///
/// The module's ONLY state-changing entrypoints are `rebalance` (policy-gated
/// presign) and `cancel` (strictly risk-reducing: it can only REMOVE a
/// presignature this module itself created, and it zeroes that order's relayer
/// allowance). There is deliberately no generic exec, no delegatecall, and no
/// post-deploy configuration: policy config is written once at construction and
/// can never be widened. A new policy means a new module instance that the Safe
/// owners enable (and the old one they disable + let its orders expire).
///
/// Settlement-agnostic by design: `domainSeparator` and the vault relayer are
/// read from the settlement itself at deploy, so one bytecode works
/// byte-identically against the Ophis non-canonical settlements (Unichain,
/// Optimism) and the canonical CoW settlement (Base).
///
/// KNOWN RESIDUALS (disclosed):
///  1. Fill-time floor: the oracle floor is enforced at PRESIGN time, not at
///     fill time - a presigned order stays fillable at its signed limit until
///     `validTo`, so an adverse market move inside the TTL window can be
///     captured. Bounded by MAX_TTL_CAP (1 hour) and the turnover cap; a true
///     fix needs a conditional-signature (EIP-1271) scheme (Phase C).
///  2. Shared-token allowances: `_approveAndPresign` resets any nonzero relayer
///     allowance on the sell token (USDT-safety). A vault running this module
///     MUST NOT keep concurrent relayer approvals on the same sell token from
///     another venue/module; when migrating, disable the old module and let its
///     orders expire/cancel first (else a rebalance can starve the old order's
///     allowance).
///  3. Token selection: fee-on-transfer / rebasing tokens must NOT be
///     allowlisted - the floor is computed on the gross sellAmount, which such
///     tokens do not deliver in full. Owners choose the allowlist at deploy.
///
/// OPERATIONAL INVARIANT (the guarantee depends on it): the curator MUST NOT
/// be a Safe owner and MUST NOT be able to call the Safe directly (scope it via
/// a Zodiac Roles Modifier to `rebalance`/`cancel` on this module only, and do
/// not enable the curator as its own Safe module). Both the factory AND this
/// constructor reject a curator that is a current Safe owner; keeping it true
/// over time (no owner-set / module-enable drift) is the vault owners'
/// responsibility. Safe OWNERS retain full custody and can always disable the
/// module - Phase B constrains the CURATOR, not the owners.
contract OphisVaultPolicyModule is ReentrancyGuard {
    using GPv2Order for GPv2Order.Data;

    /// @dev Per-token policy config, written once in the constructor.
    struct TokenPolicy {
        bool allowed;
        IAggregatorV3 feed; // token/USD Chainlink feed
        uint8 feedDecimals; // cached from feed.decimals() at deploy
        uint8 tokenDecimals; // cached from token.decimals() at deploy
        uint256 maxStaleness; // per-token accepted price age (feed heartbeat)
    }

    /// @dev Constructor input: a token, its token/USD feed, and the max price
    /// age tolerated for THAT feed (sized to the feed's own heartbeat, so a
    /// slow-heartbeat stable does not force a loose window on a fast, volatile
    /// asset).
    struct TokenFeed {
        address token;
        IAggregatorV3 feed;
        uint256 maxStaleness;
    }

    /// @dev Full construction config (a struct keeps the surface reviewable
    /// and the constructor stack shallow).
    struct ModuleConfig {
        ISafe safe;
        IGPv2Settlement settlement;
        address curator;
        /// The frozen Ophis partner-fee appData hash; bytes32(0) is REJECTED
        /// (a zero hash would silently disable the fee invariant).
        bytes32 appDataHash;
        uint256 maxSlippageBps;
        uint256 maxTtl;
        /// Rolling (leaky-bucket) cap on SELL-side turnover, in 18-decimal USD,
        /// drained at this much per day. Bounds a compromised curator's churn.
        uint256 dailyUsdTurnoverCap;
        /// Chainlink L2 sequencer-uptime feed; address(0) disables the gate
        /// (chains without one). When set, oracle reads are rejected while
        /// the sequencer is down AND for `sequencerGracePeriod` after it
        /// comes back (pre-outage prices can otherwise pass the staleness
        /// check before feeds recover).
        IAggregatorV3 sequencerUptimeFeed;
        uint256 sequencerGracePeriod;
        TokenFeed[] tokens;
    }

    /// @notice The vault Safe this module rebalances (order owner AND receiver).
    ISafe public immutable safe;
    /// @notice The chain's settlement (Ophis non-canonical or canonical CoW).
    IGPv2Settlement public immutable settlement;
    /// @notice The settlement's vault relayer - the ONLY approve spender.
    address public immutable relayer;
    /// @notice The settlement's EIP-712 domain separator (immutable there too).
    bytes32 public immutable domainSeparator;
    /// @notice The only address allowed to trigger rebalances (a Zodiac Roles
    /// modifier, an MPC signer, or a curator contract - never a Safe owner).
    address public immutable curator;
    /// @notice The frozen Ophis partner-fee appData hash orders must carry.
    bytes32 public immutable appDataHash;
    /// @notice Slippage band applied under the oracle price, in bps.
    uint256 public immutable maxSlippageBps;
    /// @notice Maximum order validity window, in seconds.
    uint256 public immutable maxTtl;
    /// @notice Rolling sell-side turnover cap in 18-decimal USD (per day).
    uint256 public immutable dailyUsdTurnoverCap;
    /// @notice L2 sequencer uptime feed (address(0) = gate disabled).
    IAggregatorV3 public immutable sequencerUptimeFeed;
    /// @notice Grace period after sequencer recovery before oracle reads.
    uint256 public immutable sequencerGracePeriod;

    /// @notice Per-token policy; populated only at construction (no setters).
    mapping(address => TokenPolicy) public tokenPolicy;
    /// @notice keccak256(orderUid) => the order's sell token (address(0) = not
    /// created by this module). `cancel` only accepts uids recorded here, so a
    /// curator cannot cancel presignatures created outside this module, and it
    /// uses the recorded token to zero that order's relayer allowance.
    mapping(bytes32 => address) public moduleOrderSellToken;
    /// @notice Leaky-bucket accumulator of sell-side USD turnover (18-dec),
    /// drained at `dailyUsdTurnoverCap` per day since `lastTurnoverTs`.
    uint256 public turnoverSpentUsd;
    /// @notice Timestamp of the last turnover accrual (leak reference point).
    uint256 public lastTurnoverTs;

    uint256 internal constant BPS = 10_000;
    /// @dev Hard caps on construction params (a per-vault config is expected
    /// to sit far below these).
    uint256 internal constant MAX_SLIPPAGE_BPS_CAP = 5_000;
    /// @dev 1 hour, deliberately tight: the oracle floor holds only at
    /// presign time, so the TTL bounds the window in which an adverse market
    /// move can be captured against a still-open order.
    uint256 internal constant MAX_TTL_CAP = 1 hours;
    uint256 internal constant MAX_STALENESS_CAP = 1 days;
    uint256 internal constant MAX_SEQ_GRACE_CAP = 1 days;
    /// @dev Bounds `10 ** tokenDecimals` so a pathological high-decimal token
    /// cannot brick every rebalance (self-DoS); far above any real token.
    uint8 internal constant MAX_TOKEN_DECIMALS = 36;

    event Rebalanced(
        bytes orderUid,
        address indexed sellToken,
        address indexed buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        uint256 oracleFloor
    );
    event Cancelled(bytes orderUid);

    error NotCurator();
    error ZeroAddress();
    error ZeroAppData();
    error BadConfig();
    error CuratorIsOwner();
    error UnsupportedTokenDecimals(address token);
    error TokenNotAllowed(address token);
    error SameToken();
    error ReceiverNotSafe();
    error NonZeroSignedFee();
    error WrongAppData();
    error BadOrderFlags();
    error BadValidTo();
    error ZeroSellAmount();
    error ZeroOracleFloor();
    error BelowFloor(uint256 buyAmount, uint256 requiredFloor);
    error TurnoverCapExceeded(uint256 spentUsd, uint256 orderUsd, uint256 capUsd);
    error SequencerDown();
    error SequencerStarting();
    error UnknownOrderUid();
    error ModuleExecFailed(address to);
    error ApproveFailed(address token);

    constructor(ModuleConfig memory cfg) {
        if (
            address(cfg.safe) == address(0) ||
            address(cfg.settlement) == address(0) ||
            cfg.curator == address(0)
        ) revert ZeroAddress();
        // A zero appData hash would make fee-less orders policy-valid,
        // silently disabling the partner-fee invariant. Fail closed.
        if (cfg.appDataHash == bytes32(0)) revert ZeroAppData();
        if (
            cfg.curator == address(cfg.safe) ||
            cfg.maxSlippageBps > MAX_SLIPPAGE_BPS_CAP ||
            cfg.maxTtl == 0 ||
            cfg.maxTtl > MAX_TTL_CAP ||
            cfg.dailyUsdTurnoverCap == 0 ||
            cfg.tokens.length < 2
        ) revert BadConfig();
        // Sequencer gate: grace period and feed must be set together.
        if (address(cfg.sequencerUptimeFeed) != address(0)) {
            if (
                cfg.sequencerGracePeriod == 0 ||
                cfg.sequencerGracePeriod > MAX_SEQ_GRACE_CAP
            ) revert BadConfig();
        } else if (cfg.sequencerGracePeriod != 0) {
            revert BadConfig();
        }
        // Defense in depth: the module's whole guarantee rests on the curator
        // not being a Safe owner (an owner can exec raw approve/setPreSignature
        // and bypass the module). The factory enforces this too, but a direct
        // deploy must not be able to skip it.
        _requireCuratorNotOwner(cfg.safe, cfg.curator);

        safe = cfg.safe;
        settlement = cfg.settlement;
        curator = cfg.curator;
        appDataHash = cfg.appDataHash;
        maxSlippageBps = cfg.maxSlippageBps;
        maxTtl = cfg.maxTtl;
        dailyUsdTurnoverCap = cfg.dailyUsdTurnoverCap;
        sequencerUptimeFeed = cfg.sequencerUptimeFeed;
        sequencerGracePeriod = cfg.sequencerGracePeriod;
        lastTurnoverTs = block.timestamp;

        // Read, never trust: relayer + domain separator come from the
        // settlement itself (both are immutables there), so this module
        // cannot be wired against a mismatched relayer/domain.
        relayer = cfg.settlement.vaultRelayer();
        domainSeparator = cfg.settlement.domainSeparator();
        if (relayer == address(0)) revert ZeroAddress();

        for (uint256 i = 0; i < cfg.tokens.length; i++) {
            address token = cfg.tokens[i].token;
            IAggregatorV3 feed = cfg.tokens[i].feed;
            uint256 staleness = cfg.tokens[i].maxStaleness;
            if (token == address(0) || address(feed) == address(0)) {
                revert ZeroAddress();
            }
            if (staleness == 0 || staleness > MAX_STALENESS_CAP) {
                revert BadConfig();
            }
            if (tokenPolicy[token].allowed) revert BadConfig(); // duplicate
            uint8 tokenDecimals = IERC20Metadata(token).decimals();
            if (tokenDecimals > MAX_TOKEN_DECIMALS) {
                revert UnsupportedTokenDecimals(token);
            }
            uint8 feedDecimals = feed.decimals();
            // Fail-closed liveness probe: a feed that cannot serve a valid,
            // fresh price NOW does not belong in the policy.
            OphisChainlinkFloor.read18(feed, feedDecimals, staleness);
            tokenPolicy[token] = TokenPolicy({
                allowed: true,
                feed: feed,
                feedDecimals: feedDecimals,
                tokenDecimals: tokenDecimals,
                maxStaleness: staleness
            });
        }
    }

    /// @notice Validates `order` against the on-chain policy and, if every
    /// check passes, makes the Safe execute exactly
    /// `[approve(relayer, exact), setPreSignature(uid, true)]`.
    /// @param order The full CoW order the curator wants to place. Built
    /// off-chain by the ophis safe-swap package (quote + appData + uid come
    /// from there); this module re-derives the uid and enforces the policy
    /// regardless of what the off-chain layer claims.
    /// @param minBuyOverride The curator's own NAV-based floor. The effective
    /// floor is `max(oracleFloor, minBuyOverride)` - the curator can TIGHTEN
    /// the oracle floor, never loosen it. A zero oracle floor always reverts
    /// regardless of this value.
    /// @return orderUid The 56-byte uid that was presigned.
    function rebalance(
        GPv2Order.Data calldata order,
        uint256 minBuyOverride
    ) external nonReentrant returns (bytes memory orderUid) {
        if (msg.sender != curator) revert NotCurator();

        (uint256 oracleFloor, uint256 orderUsd) = _enforcePolicy(
            order,
            minBuyOverride
        );
        _recordTurnover(orderUsd);
        orderUid = _deriveUid(order);
        moduleOrderSellToken[keccak256(orderUid)] = address(order.sellToken);
        _approveAndPresign(order, orderUid);

        emit Rebalanced(
            orderUid,
            address(order.sellToken),
            address(order.buyToken),
            order.sellAmount,
            order.buyAmount,
            oracleFloor
        );
    }

    /// @notice Revokes a presignature THIS MODULE created and zeroes its
    /// relayer allowance. Strictly risk-reducing: it can only ever REMOVE the
    /// settlement's permission to fill an order and shrink an approval, so it
    /// is safe to expose to the curator (e.g. the market moved and a still-open
    /// order no longer reflects fair value). Uids not recorded by `rebalance`
    /// are refused, so the curator cannot cancel presignatures created outside
    /// this module.
    function cancel(bytes calldata orderUid) external nonReentrant {
        if (msg.sender != curator) revert NotCurator();
        bytes32 key = keccak256(orderUid);
        address sellToken = moduleOrderSellToken[key];
        if (sellToken == address(0)) revert UnknownOrderUid();
        // Clear the record first (CEI): a re-presigned order gets a fresh entry.
        delete moduleOrderSellToken[key];
        _exec(
            address(settlement),
            abi.encodeWithSelector(
                IGPv2Settlement.setPreSignature.selector,
                orderUid,
                false
            )
        );
        // Zero the relayer allowance this order left standing (hygiene: keep
        // the approval lifecycle coupled to the presignature lifecycle).
        if (IERC20(sellToken).allowance(address(safe), relayer) != 0) {
            _safeApprove(sellToken, 0);
        }
        emit Cancelled(orderUid);
    }

    /// @dev All policy checks, fail-closed: ANY failure reverts. Returns the
    /// oracle floor the accepted order cleared and the order's sell-side
    /// value in 18-decimal USD (for turnover accounting).
    function _enforcePolicy(
        GPv2Order.Data calldata order,
        uint256 minBuyOverride
    ) internal view returns (uint256 oracleFloor, uint256 orderUsd) {
        address sellToken = address(order.sellToken);
        address buyToken = address(order.buyToken);
        TokenPolicy memory sellPolicy = tokenPolicy[sellToken];
        TokenPolicy memory buyPolicy = tokenPolicy[buyToken];

        if (!sellPolicy.allowed) revert TokenNotAllowed(sellToken);
        if (!buyPolicy.allowed) revert TokenNotAllowed(buyToken);
        if (sellToken == buyToken) revert SameToken();
        // Strict receiver pin: the settlement would also treat address(0) as
        // "same as owner", but the off-chain builder always pins the Safe
        // explicitly, so anything else here is a red flag - reject it.
        if (order.receiver != address(safe)) revert ReceiverNotSafe();
        // The Ophis fee rides ONLY in appData; a non-zero signed fee is never
        // produced by the builder (invariant 1 of the Phase-A spec).
        if (order.feeAmount != 0) revert NonZeroSignedFee();
        if (order.appData != appDataHash) revert WrongAppData();
        if (
            order.kind != GPv2Order.KIND_SELL ||
            order.partiallyFillable ||
            order.sellTokenBalance != GPv2Order.BALANCE_ERC20 ||
            order.buyTokenBalance != GPv2Order.BALANCE_ERC20
        ) revert BadOrderFlags();
        if (
            order.validTo <= block.timestamp ||
            order.validTo > block.timestamp + maxTtl
        ) revert BadValidTo();
        if (order.sellAmount == 0) revert ZeroSellAmount();

        // L2 sequencer gate BEFORE any price is trusted: after an outage a
        // pre-outage price can pass the staleness check before feeds recover.
        _checkSequencer();

        // Oracle floor (reverts on invalid/stale price: fail-closed).
        uint256 sellPrice18 = OphisChainlinkFloor.read18(
            sellPolicy.feed,
            sellPolicy.feedDecimals,
            sellPolicy.maxStaleness
        );
        oracleFloor = OphisChainlinkFloor.floorBuyAmount(
            order.sellAmount,
            sellPrice18,
            sellPolicy.tokenDecimals,
            OphisChainlinkFloor.read18(
                buyPolicy.feed,
                buyPolicy.feedDecimals,
                buyPolicy.maxStaleness
            ),
            buyPolicy.tokenDecimals,
            maxSlippageBps
        );
        // A floor that truncates to zero (order value < 1 base unit of the buy
        // token) must fail closed REGARDLESS of minBuyOverride - otherwise a
        // curator could pass minBuyOverride = 1 to admit a ~zero-proceeds order.
        if (oracleFloor == 0) revert ZeroOracleFloor();
        uint256 requiredFloor = minBuyOverride > oracleFloor
            ? minBuyOverride
            : oracleFloor;
        if (order.buyAmount < requiredFloor) {
            revert BelowFloor(order.buyAmount, requiredFloor);
        }

        // Sell-side USD value, 18 decimals (same oracle the floor used).
        orderUsd =
            (order.sellAmount * sellPrice18) /
            (10 ** sellPolicy.tokenDecimals);
    }

    /// @dev Chainlink L2 sequencer-uptime pattern: answer == 0 means "up";
    /// `startedAt` is when the current status began, so a recent recovery
    /// still rejects until the grace period has elapsed. `startedAt == 0`
    /// is an invalid/uninitialized round and is rejected.
    function _checkSequencer() internal view {
        IAggregatorV3 feed = sequencerUptimeFeed;
        if (address(feed) == address(0)) return;
        (, int256 answer, uint256 startedAt, , ) = feed.latestRoundData();
        if (answer != 0) revert SequencerDown();
        if (startedAt == 0) revert SequencerStarting();
        if (block.timestamp - startedAt < sequencerGracePeriod) {
            revert SequencerStarting();
        }
    }

    /// @dev Leaky-bucket turnover accounting: the accumulator drains at
    /// `dailyUsdTurnoverCap` per day since the last accrual, so the sustained
    /// sell rate cannot exceed the cap over any rolling 24h and the
    /// instantaneous burst is bounded to the cap - there is no calendar
    /// boundary a compromised curator can straddle to double the bound.
    function _recordTurnover(uint256 orderUsd) internal {
        uint256 nowTs = block.timestamp;
        uint256 elapsed = nowTs - lastTurnoverTs;
        uint256 leaked = (elapsed * dailyUsdTurnoverCap) / 1 days;
        uint256 spent = turnoverSpentUsd > leaked
            ? turnoverSpentUsd - leaked
            : 0;
        uint256 newSpent = spent + orderUsd;
        if (newSpent > dailyUsdTurnoverCap) {
            revert TurnoverCapExceeded(
                spent,
                orderUsd,
                dailyUsdTurnoverCap
            );
        }
        turnoverSpentUsd = newSpent;
        lastTurnoverTs = nowTs;
    }

    /// @dev The uid is derived with the settlement's OWN library + domain
    /// separator - definitionally the uid the settlement will verify.
    function _deriveUid(
        GPv2Order.Data calldata order
    ) internal view returns (bytes memory orderUid) {
        GPv2Order.Data memory orderMem = order;
        bytes32 orderDigest = orderMem.hash(domainSeparator);
        orderUid = new bytes(GPv2Order.UID_LENGTH);
        GPv2Order.packOrderUidParams(
            orderUid,
            orderDigest,
            address(safe),
            order.validTo
        );
    }

    /// @dev Effects, as the Safe. Exact, USDT-safe approve: reset a residual
    /// allowance to zero first (USDT-style tokens revert on nonzero ->
    /// nonzero), then approve the exact pull. Never MaxUint.
    function _approveAndPresign(
        GPv2Order.Data calldata order,
        bytes memory orderUid
    ) internal {
        address sellToken = address(order.sellToken);
        uint256 pullAmount = order.sellAmount + order.feeAmount;
        if (IERC20(sellToken).allowance(address(safe), relayer) != 0) {
            _safeApprove(sellToken, 0);
        }
        _safeApprove(sellToken, pullAmount);
        _exec(
            address(settlement),
            abi.encodeWithSelector(
                IGPv2Settlement.setPreSignature.selector,
                orderUid,
                true
            )
        );
    }

    /// @dev Reverts unless `curator` is absent from the Safe's current owner
    /// set. An owner-curator has full Safe power and does not need the module.
    function _requireCuratorNotOwner(ISafe safe_, address curator_) internal view {
        address[] memory owners = safe_.getOwners();
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == curator_) revert CuratorIsOwner();
        }
    }

    /// @dev Plain CALL from the Safe (operation 0, never delegatecall).
    function _exec(address to, bytes memory data) internal {
        (bool success, ) = safe.execTransactionFromModuleReturnData(
            to,
            0,
            data,
            0
        );
        if (!success) revert ModuleExecFailed(to);
    }

    /// @dev ERC20 approve from the Safe, accepting both bool-returning and
    /// void-returning (USDT-style) tokens, rejecting an explicit `false`.
    function _safeApprove(address token, uint256 amount) internal {
        (bool success, bytes memory returnData) = safe
            .execTransactionFromModuleReturnData(
                token,
                0,
                abi.encodeWithSelector(IERC20.approve.selector, relayer, amount),
                0
            );
        if (
            !success ||
            (returnData.length != 0 && !abi.decode(returnData, (bool)))
        ) revert ApproveFailed(token);
    }
}
