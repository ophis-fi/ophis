// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

interface ExecutionNonce {
    function nonce() external view returns (uint256);
}

/// @notice Enforces canonical execution for an already fee/proof-validated operator request.
/// @dev Reverts are still gas-paying transactions if a builder includes them outside its private policy.
contract RailgunExecutionGuard {
    address public immutable operator;
    address public immutable delegate;
    bytes32 public immutable delegateCodeHash;
    bytes32 private immutable authorizationCodeHash;

    // Nonce-aware execute selector from the pinned Railgun engine 9.9.1 ABI.
    bytes4 private constant EXECUTE = 0x3e12cc2e;

    error UnauthorizedOperator();
    error UnsupportedExecution();
    error UnexpectedDelegate();
    error InvalidExecutionNonce();
    error ExecutionFailed();

    constructor(address operator_, address delegate_) {
        if (operator_ == address(0) || delegate_.code.length == 0) revert UnsupportedExecution();
        operator = operator_;
        delegate = delegate_;
        delegateCodeHash = delegate_.codehash;
        authorizationCodeHash = keccak256(abi.encodePacked(hex"ef0100", delegate_));
    }

    function execute(address account, bytes calldata execution, uint256 expectedNonce) external {
        if (msg.sender != operator) revert UnauthorizedOperator();
        if (account == operator || execution.length < 4 || bytes4(execution[:4]) != EXECUTE) {
            revert UnsupportedExecution();
        }
        if (delegate.codehash != delegateCodeHash || keccak256(account.code) != authorizationCodeHash) {
            revert UnexpectedDelegate();
        }
        if (ExecutionNonce(account).nonce() != expectedNonce) revert InvalidExecutionNonce();
        (bool success,) = account.call(execution);
        if (!success) revert ExecutionFailed();
        if (ExecutionNonce(account).nonce() != expectedNonce + 1) revert InvalidExecutionNonce();
    }
}
