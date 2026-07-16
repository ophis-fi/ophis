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
/// out, pinned Ophis fee appData) BEFORE any presignature can exist. A
/// compromised curator key can therefore only ever trigger policy-valid
/// rebalances - it cannot drain the vault.
///
/// The module's ONLY state-changing entrypoints are `rebalance` (policy-gated
/// presign) and `cancel` (strictly risk-reducing: it can only REMOVE a
/// presignature). There is deliberately no generic exec, no delegatecall, and
/// no post-deploy configuration: policy config is written once at construction
/// and can never be widened. A new policy means a new module instance that the
/// Safe owners enable (and the old one they disable).
///
/// Settlement-agnostic by design: `domainSeparator` and the vault relayer are
/// read from the settlement itself at deploy, so one bytecode works
/// byte-identically against the Ophis non-canonical settlements (Unichain,
/// Optimism) and the canonical CoW settlement (Base).
///
/// OPERATIONAL INVARIANT (the guarantee depends on it): the curator MUST NOT
/// be a Safe owner and MUST NOT be able to call the Safe directly (scope it
/// via a Zodiac Roles Modifier to `rebalance`/`cancel` on this module only).
/// The factory enforces the owner check at deploy; keeping it true over time
/// is the vault owners' responsibility. Safe OWNERS retain full custody and
/// can always disable the module - Phase B constrains the CURATOR, not the
/// owners.
contract OphisVaultPolicyModule is ReentrancyGuard {
    using GPv2Order for GPv2Order.Data;

    /// @dev Per-token policy config, written once in the constructor.
    struct TokenPolicy {
        bool allowed;
        IAggregatorV3 feed; // token/USD Chainlink feed
        uint8 feedDecimals; // cached from feed.decimals() at deploy
        uint8 tokenDecimals; // cached from token.decimals() at deploy
    }

    /// @dev Constructor input: a token and its token/USD feed.
    struct TokenFeed {
        address token;
        IAggregatorV3 feed;
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
    /// @notice Maximum accepted oracle price age, in seconds.
    uint256 public immutable maxOracleStaleness;

    /// @notice Per-token policy; populated only at construction (no setters).
    mapping(address => TokenPolicy) public tokenPolicy;

    uint256 internal constant BPS = 10_000;
    /// @dev Hard caps on construction params (a per-vault config is expected
    /// to sit far below these).
    uint256 internal constant MAX_SLIPPAGE_BPS_CAP = 5_000;
    uint256 internal constant MAX_TTL_CAP = 1 days;
    uint256 internal constant MAX_STALENESS_CAP = 1 days;

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
    error BadConfig();
    error TokenNotAllowed(address token);
    error SameToken();
    error ReceiverNotSafe();
    error NonZeroSignedFee();
    error WrongAppData();
    error BadOrderFlags();
    error BadValidTo();
    error ZeroSellAmount();
    error BelowFloor(uint256 buyAmount, uint256 requiredFloor);
    error ModuleExecFailed(address to);
    error ApproveFailed(address token);

    constructor(
        ISafe safe_,
        IGPv2Settlement settlement_,
        address curator_,
        bytes32 appDataHash_,
        uint256 maxSlippageBps_,
        uint256 maxTtl_,
        uint256 maxOracleStaleness_,
        TokenFeed[] memory tokens_
    ) {
        if (
            address(safe_) == address(0) ||
            address(settlement_) == address(0) ||
            curator_ == address(0)
        ) revert ZeroAddress();
        if (
            curator_ == address(safe_) ||
            maxSlippageBps_ > MAX_SLIPPAGE_BPS_CAP ||
            maxTtl_ == 0 ||
            maxTtl_ > MAX_TTL_CAP ||
            maxOracleStaleness_ == 0 ||
            maxOracleStaleness_ > MAX_STALENESS_CAP ||
            tokens_.length < 2
        ) revert BadConfig();

        safe = safe_;
        settlement = settlement_;
        curator = curator_;
        appDataHash = appDataHash_;
        maxSlippageBps = maxSlippageBps_;
        maxTtl = maxTtl_;
        maxOracleStaleness = maxOracleStaleness_;

        // Read, never trust: relayer + domain separator come from the
        // settlement itself (both are immutables there), so this module
        // cannot be wired against a mismatched relayer/domain.
        relayer = settlement_.vaultRelayer();
        domainSeparator = settlement_.domainSeparator();
        if (relayer == address(0)) revert ZeroAddress();

        for (uint256 i = 0; i < tokens_.length; i++) {
            address token = tokens_[i].token;
            IAggregatorV3 feed = tokens_[i].feed;
            if (token == address(0) || address(feed) == address(0)) {
                revert ZeroAddress();
            }
            if (tokenPolicy[token].allowed) revert BadConfig(); // duplicate
            uint8 feedDecimals = feed.decimals();
            // Fail-closed liveness probe: a feed that cannot serve a valid,
            // fresh price NOW does not belong in the policy.
            OphisChainlinkFloor.read18(feed, feedDecimals, maxOracleStaleness_);
            tokenPolicy[token] = TokenPolicy({
                allowed: true,
                feed: feed,
                feedDecimals: feedDecimals,
                tokenDecimals: IERC20Metadata(token).decimals()
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
    /// the oracle floor, never loosen it.
    /// @return orderUid The 56-byte uid that was presigned.
    function rebalance(
        GPv2Order.Data calldata order,
        uint256 minBuyOverride
    ) external nonReentrant returns (bytes memory orderUid) {
        if (msg.sender != curator) revert NotCurator();

        uint256 oracleFloor = _enforcePolicy(order, minBuyOverride);
        orderUid = _deriveUid(order);
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

    /// @dev All policy checks, fail-closed: ANY failure reverts. Returns the
    /// oracle floor the accepted order cleared.
    function _enforcePolicy(
        GPv2Order.Data calldata order,
        uint256 minBuyOverride
    ) internal view returns (uint256 oracleFloor) {
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

        // Oracle floor (reverts on invalid/stale price: fail-closed).
        oracleFloor = OphisChainlinkFloor.floorBuyAmount(
            order.sellAmount,
            OphisChainlinkFloor.read18(
                sellPolicy.feed,
                sellPolicy.feedDecimals,
                maxOracleStaleness
            ),
            sellPolicy.tokenDecimals,
            OphisChainlinkFloor.read18(
                buyPolicy.feed,
                buyPolicy.feedDecimals,
                maxOracleStaleness
            ),
            buyPolicy.tokenDecimals,
            maxSlippageBps
        );
        uint256 requiredFloor = minBuyOverride > oracleFloor
            ? minBuyOverride
            : oracleFloor;
        if (requiredFloor == 0 || order.buyAmount < requiredFloor) {
            revert BelowFloor(order.buyAmount, requiredFloor);
        }
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

    /// @notice Revokes a presignature. Strictly risk-reducing: this can only
    /// ever REMOVE the settlement's permission to fill an order, so it is
    /// safe to expose to the curator (e.g. the market moved and a still-open
    /// order no longer reflects fair value).
    function cancel(bytes calldata orderUid) external nonReentrant {
        if (msg.sender != curator) revert NotCurator();
        _exec(
            address(settlement),
            abi.encodeWithSelector(
                IGPv2Settlement.setPreSignature.selector,
                orderUid,
                false
            )
        );
        emit Cancelled(orderUid);
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
