// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

/// @title EIP-7702 Settlement Forwarder for CoW Protocol
/// @notice When used with EIP-7702, the solver EOA delegates its code to this
/// contract. Approved submission EOAs call `forward(target, data)` to execute
/// settlement transactions through the solver EOA, preserving
/// `msg.sender = solver EOA` from the target's perspective.
///
/// Storage lives in the solver EOA's account (EIP-7702 semantics). The contract
/// is deployed once and shared across all solver EOAs. Each gets its own
/// independent `isApprovedCaller` mapping in its own storage.
///
/// @dev Trust model. An approved caller has unrestricted authority over the
/// solver EOA: `forward` performs an arbitrary CALL with arbitrary value and
/// calldata from the solver EOA's context, which already lets an approved caller
/// move the account's full balance and manage its approvals. Approvals are
/// therefore only meaningful as an operational allowlist of already-trusted
/// submission EOAs, not as a security boundary between approved callers.
///
/// Approvals are managed exclusively by the solver EOA itself (the
/// `msg.sender == address(this)` gate on `setApprovedCallers`), so an outside
/// party cannot grant itself access. Because storage persists in the solver
/// EOA's account under EIP-7702, approvals survive across transactions and even
/// across a change of delegated code. Operators must explicitly clear approvals
/// when retiring a submission EOA or repurposing the solver account. Self
/// granting by an already-approved caller (routing `setApprovedCallers` back
/// through `forward`) is possible and is within this trust model by design,
/// since such a caller already controls the account outright.
contract CowSettlementForwarder {
    mapping(address => bool) public isApprovedCaller;

    event ApprovedCallerSet(address indexed caller, bool approved);

    error Unauthorized();
    error InvalidTarget();

    /// @notice Forward `data` to `target` via CALL.
    /// @dev Only approved callers can invoke this. In EIP-7702 context,
    /// `address(this)` = solver EOA, so `target` sees `msg.sender = solver EOA`.
    /// Rejects the zero address, and any value bearing call to a target without
    /// code, so native value cannot be silently burned by the solver EOA.
    function forward(address target, bytes calldata data) external payable {
        if (!isApprovedCaller[msg.sender]) revert Unauthorized();
        if (target == address(0)) revert InvalidTarget();
        if (msg.value > 0 && target.code.length == 0) revert InvalidTarget();
        (bool success, bytes memory result) = target.call{value: msg.value}(data);
        assembly {
            switch success
            case 0 { revert(add(result, 32), mload(result)) }
            default { return(add(result, 32), mload(result)) }
        }
    }

    /// @notice Set approved callers.
    /// @dev Restricted to the solver EOA itself under EIP-7702
    /// (`msg.sender == address(this)`). See the contract level trust model note:
    /// approved callers are fully trusted and approvals persist in the solver
    /// EOA's storage until explicitly cleared.
    function setApprovedCallers(address[] calldata callers, bool approved) external {
        if (msg.sender != address(this)) revert Unauthorized();
        for (uint256 i = 0; i < callers.length; i++) {
            isApprovedCaller[callers[i]] = approved;
            emit ApprovedCallerSet(callers[i], approved);
        }
    }
}
