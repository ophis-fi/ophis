// SPDX-License-Identifier: LGPL-3.0-or-later

// NOTICE: the liquidator-role fee-treasury pattern in this contract
// (`liquidator` role, sweep with amount 0 = full balance, in-place
// consolidation with a balance-difference minimum-out floor) is ported from
// OdosRouterV3 (`liquidatorAddress` / `transferRouterFunds` /
// `swapRouterFunds`), MIT License, Copyright (c) 2024 Odos.
// The ported logic is deliberately narrowed for Ophis:
//   - the sweep destination is pinned to the immutable fee Safe (the Odos
//     original accepted an arbitrary `dest`);
//   - consolidation venues and output tokens are owner-allowlisted (the Odos
//     original executed arbitrary path definitions on any executor);
//   - `amountOutMin > 0` is mandatory (the Odos original accepted 0);
//   - consolidation output stays in the Settlement contract (the Odos
//     original paid out to a caller-chosen receiver).

pragma solidity >=0.7.6 <0.9.0;
pragma abicoder v2;

import {GPv2Settlement} from "./GPv2Settlement.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {GPv2Interaction} from "./libraries/GPv2Interaction.sol";
import {GPv2Trade} from "./libraries/GPv2Trade.sol";
import {ReentrancyGuard} from "./mixins/ReentrancyGuard.sol";

/// @title Ophis fee-treasury liquidator
/// @notice A constrained ops surface, distinct from the protocol Safe and the
/// driver-submitter key, that can ONLY:
///   1. sweep accrued CIP-75 fees from the Ophis OP Settlement contract to
///      the immutable fee Safe (`sweep`), and
///   2. consolidate multi-denomination fee dust in place into an allowlisted
///      output token with a mandatory minimum-out floor (`consolidate`).
/// Both operations are executed as empty-trade `settle()` calls with
/// post-interactions, so this contract must be in the solver allowlist
/// (added via the 24h Timelock + AllowListGuardian ceremony; the guardian's
/// instant `removeSolver` is the kill switch, see
/// docs/operations/fee-treasury-ops-runbook.md).
///
/// Roles:
///   - `owner` (immutable, the protocol Safe): admin, rotate the liquidator
///     key, allowlist venues/output tokens, and run ops itself if needed.
///   - `liquidator` (mutable): the fee-ops key. Setting it to address(0)
///     pauses the ops-key path without touching the solver allowlist.
///
/// Funds-flow guarantees:
///   - swept funds can ONLY go to the immutable `feeSafe`;
///   - consolidation output can ONLY accrue inside the Settlement contract
///     (enforced by the balance-difference floor, not by trusting the venue);
///   - venue approvals are exact-amount and revoked in the same settlement,
///     with a post-settlement zero-allowance assertion;
///   - this contract itself never custodies funds.
contract OphisFeeLiquidator is ReentrancyGuard {
    /// @dev address(0) denotes native ETH in `sweep` token lists (matches the
    /// Odos convention; Settlement holds native ETH from ethflow refunds).
    address private constant NATIVE_ETH = address(0);

    /// @notice The GPv2 settlement contract fees accrue in.
    GPv2Settlement public immutable settlement;
    /// @notice The only address sweeps can pay. Immutable by design: rotating
    /// the fee Safe REQUIRES redeploying this contract (see
    /// docs/operations/fee-recipient-rotation.md).
    address payable public immutable feeSafe;
    /// @notice The protocol Safe. Immutable; rotation = redeploy.
    address public immutable owner;

    /// @notice The fee-ops key. address(0) pauses the ops-key path.
    address public liquidator;
    /// @notice Consolidation venues the owner has approved (ships empty:
    /// sweep-only posture until a Safe transaction enables a venue).
    mapping(address => bool) public venueAllowed;
    /// @notice Consolidation output tokens the owner has approved.
    mapping(address => bool) public outputTokenAllowed;
    /// @notice Timestamp of the last successful sweep (ops observability).
    uint256 public lastSweepAt;

    /// @dev One consolidation input: `amount` 0 = full Settlement balance.
    struct ConsolidateInput {
        address token;
        uint256 amount;
    }

    event LiquidatorChanged(address indexed newLiquidator);
    event VenueSet(address indexed venue, bool allowed);
    event OutputTokenSet(address indexed token, bool allowed);
    event Swept(address indexed token, uint256 amount);
    event Consolidated(address indexed venue, address indexed tokenOut, uint256 amountOut);

    modifier onlyOwner() {
        require(msg.sender == owner, "OFL: caller not owner");
        _;
    }

    /// @dev `liquidator == address(0)` cannot match any real sender, so
    /// zeroing the liquidator pauses the ops-key path while the owner path
    /// keeps working.
    modifier onlyOps() {
        require(msg.sender == liquidator || msg.sender == owner, "OFL: caller not ops");
        _;
    }

    constructor(
        GPv2Settlement settlement_,
        address payable feeSafe_,
        address owner_,
        address initialLiquidator
    ) {
        require(address(settlement_) != address(0), "OFL: settlement is zero");
        require(feeSafe_ != address(0), "OFL: fee safe is zero");
        require(owner_ != address(0), "OFL: owner is zero");
        settlement = settlement_;
        feeSafe = feeSafe_;
        owner = owner_;
        liquidator = initialLiquidator;
        emit LiquidatorChanged(initialLiquidator);
    }

    // --- owner admin (instant; all three are capability-narrowing or
    // --- reversible, and the solver-allowlist guardian remains the
    // --- protocol-level kill switch) ---

    function setLiquidator(address newLiquidator) external onlyOwner {
        liquidator = newLiquidator;
        emit LiquidatorChanged(newLiquidator);
    }

    function setVenue(address venue, bool allowed) external onlyOwner {
        require(venue != address(0), "OFL: venue is zero");
        venueAllowed[venue] = allowed;
        emit VenueSet(venue, allowed);
    }

    function setOutputToken(address token, bool allowed) external onlyOwner {
        require(token != address(0), "OFL: output token is zero");
        outputTokenAllowed[token] = allowed;
        emit OutputTokenSet(token, allowed);
    }

    // --- ops ---

    /// @notice Sweep accrued fees from the Settlement contract to the fee
    /// Safe. `amounts[i] == 0` sweeps the full balance of `tokens[i]`;
    /// `tokens[i] == address(0)` sweeps native ETH.
    /// @dev Post-settlement, every swept token's Settlement balance must have
    /// decreased by exactly the swept amount. This catches false-returning
    /// ERC20s (Settlement's interaction executor does not inspect return
    /// data) at the cost of rejecting sender-side fee-on-transfer tokens:
    /// those are swept via the documented DR fallback instead.
    function sweep(address[] calldata tokens, uint256[] calldata amounts)
        external
        onlyOps
        nonReentrant
    {
        require(tokens.length == amounts.length, "OFL: length mismatch");
        require(tokens.length > 0, "OFL: empty sweep");

        uint256[] memory resolved = new uint256[](tokens.length);
        uint256[] memory balancesBefore = new uint256[](tokens.length);
        uint256 transferCount = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            for (uint256 j = 0; j < i; j++) {
                require(tokens[j] != tokens[i], "OFL: duplicate token");
            }
            balancesBefore[i] = _settlementBalance(tokens[i]);
            uint256 amount = amounts[i];
            if (amount == 0) {
                amount = balancesBefore[i];
            }
            require(amount <= balancesBefore[i], "OFL: amount exceeds balance");
            resolved[i] = amount;
            if (amount > 0) {
                transferCount++;
            }
        }
        require(transferCount > 0, "OFL: nothing to sweep");

        GPv2Interaction.Data[] memory post = new GPv2Interaction.Data[](transferCount);
        uint256 k = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (resolved[i] == 0) {
                continue;
            }
            if (tokens[i] == NATIVE_ETH) {
                post[k] = GPv2Interaction.Data({target: feeSafe, value: resolved[i], callData: ""});
            } else {
                post[k] = GPv2Interaction.Data({
                    target: tokens[i],
                    value: 0,
                    callData: abi.encodeWithSelector(IERC20.transfer.selector, feeSafe, resolved[i])
                });
            }
            k++;
        }

        _settle(post);

        for (uint256 i = 0; i < tokens.length; i++) {
            if (resolved[i] == 0) {
                continue;
            }
            uint256 balanceAfter = _settlementBalance(tokens[i]);
            require(
                balancesBefore[i] - resolved[i] == balanceAfter,
                "OFL: sweep amount mismatch"
            );
            emit Swept(tokens[i], resolved[i]);
        }
        lastSweepAt = block.timestamp;
    }

    /// @notice Consolidate fee dust held by the Settlement contract into
    /// `tokenOut` via an owner-allowlisted venue. The output stays in the
    /// Settlement contract; a later `sweep` moves it to the fee Safe.
    /// @param inputs input tokens (`amount` 0 = full balance; native ETH not
    /// supported, sweep it, or wrap via a venue-side route from WETH dust).
    /// @param tokenOut owner-allowlisted output token (WETH per decision 53).
    /// @param amountOutMin mandatory floor on the Settlement contract's
    /// `tokenOut` balance increase; the runner derives it from the venue
    /// quote minus the slippage cap (100 bps default, see
    /// consolidate-fee-dust.sh).
    /// @param venue owner-allowlisted venue router the settlement calls.
    /// @param venueCallData venue calldata built off-chain by the runner with
    /// the Settlement contract as both payer and recipient.
    function consolidate(
        ConsolidateInput[] calldata inputs,
        address tokenOut,
        uint256 amountOutMin,
        address venue,
        bytes calldata venueCallData
    ) external onlyOps nonReentrant returns (uint256 amountOut) {
        require(inputs.length > 0, "OFL: empty consolidate");
        require(venueAllowed[venue], "OFL: venue not allowed");
        require(outputTokenAllowed[tokenOut], "OFL: output not allowed");
        require(amountOutMin > 0, "OFL: zero amountOutMin");

        uint256[] memory resolved = new uint256[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            address token = inputs[i].token;
            require(token != NATIVE_ETH, "OFL: native input");
            require(token != tokenOut, "OFL: input is output");
            for (uint256 j = 0; j < i; j++) {
                require(inputs[j].token != token, "OFL: duplicate input");
            }
            uint256 amount = inputs[i].amount;
            if (amount == 0) {
                amount = IERC20(token).balanceOf(address(settlement));
            }
            require(amount > 0, "OFL: nothing to consolidate");
            resolved[i] = amount;
        }

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(settlement));

        // Exact-amount approve per input, one venue call, then a same-settle
        // revoke per input so no allowance survives the settlement.
        GPv2Interaction.Data[] memory post =
            new GPv2Interaction.Data[](inputs.length * 2 + 1);
        for (uint256 i = 0; i < inputs.length; i++) {
            post[i] = GPv2Interaction.Data({
                target: inputs[i].token,
                value: 0,
                callData: abi.encodeWithSelector(IERC20.approve.selector, venue, resolved[i])
            });
            post[inputs.length + 1 + i] = GPv2Interaction.Data({
                target: inputs[i].token,
                value: 0,
                callData: abi.encodeWithSelector(IERC20.approve.selector, venue, uint256(0))
            });
        }
        post[inputs.length] = GPv2Interaction.Data({target: venue, value: 0, callData: venueCallData});

        _settle(post);

        uint256 outAfter = IERC20(tokenOut).balanceOf(address(settlement));
        require(outAfter >= outBefore, "OFL: output balance decreased");
        amountOut = outAfter - outBefore;
        require(amountOut >= amountOutMin, "OFL: slippage");
        for (uint256 i = 0; i < inputs.length; i++) {
            require(
                IERC20(inputs[i].token).allowance(address(settlement), venue) == 0,
                "OFL: allowance left"
            );
        }
        emit Consolidated(venue, tokenOut, amountOut);
    }

    /// @dev Empty-trade `settle()` with only post-interactions (slot 2). This
    /// contract is the solver, so Settlement's `onlySolver` gate applies:
    /// evicting this contract from the allowlist instantly disables both ops.
    function _settle(GPv2Interaction.Data[] memory post) private {
        IERC20[] memory noTokens = new IERC20[](0);
        uint256[] memory noPrices = new uint256[](0);
        GPv2Trade.Data[] memory noTrades = new GPv2Trade.Data[](0);
        GPv2Interaction.Data[][3] memory interactions;
        interactions[2] = post;
        settlement.settle(noTokens, noPrices, noTrades, interactions);
    }

    function _settlementBalance(address token) private view returns (uint256) {
        if (token == NATIVE_ETH) {
            return address(settlement).balance;
        }
        return IERC20(token).balanceOf(address(settlement));
    }
}
