// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {RailgunExecutionGuard} from "../RailgunExecutionGuard.sol";

interface GuardVM {
    function etch(address target, bytes calldata code) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

contract TestDelegate {
    uint256 public nonce;

    fallback() external {
        (uint256 expected, uint256 advance, bool fail) = abi.decode(msg.data[4:], (uint256, uint256, bool));
        require(expected == nonce);
        nonce += advance;
        require(!fail);
    }
}

contract RailgunExecutionGuardTest {
    GuardVM private constant vm = GuardVM(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ACCOUNT = address(0x1234);
    TestDelegate private delegate;
    RailgunExecutionGuard private guard;

    function setUp() public {
        delegate = new TestDelegate();
        guard = new RailgunExecutionGuard(address(this), address(delegate));
        vm.etch(ACCOUNT, abi.encodePacked(hex"ef0100", address(delegate)));
    }

    function execution(uint256 expected, uint256 advance, bool fail) private pure returns (bytes memory) {
        return abi.encodePacked(bytes4(0x3e12cc2e), abi.encode(expected, advance, fail));
    }

    function testExecutesCanonicalDelegationOnce() public {
        guard.execute(ACCOUNT, execution(0, 1, false), 0);
        require(TestDelegate(ACCOUNT).nonce() == 1);
        vm.expectRevert(RailgunExecutionGuard.InvalidExecutionNonce.selector);
        guard.execute(ACCOUNT, execution(0, 1, false), 0);
    }

    function testRejectsClearedDelegationInsteadOfAcceptingASuccessfulNoOp() public {
        vm.etch(ACCOUNT, hex"");
        vm.expectRevert(RailgunExecutionGuard.UnexpectedDelegate.selector);
        guard.execute(ACCOUNT, execution(0, 1, false), 0);
    }

    function testRejectsDifferentDelegationEvenWithTheSameInterface() public {
        TestDelegate alternative = new TestDelegate();
        vm.etch(ACCOUNT, abi.encodePacked(hex"ef0100", address(alternative)));
        vm.expectRevert(RailgunExecutionGuard.UnexpectedDelegate.selector);
        guard.execute(ACCOUNT, execution(0, 1, false), 0);
    }

    function testRejectsChangedImplementationCode() public {
        vm.etch(address(delegate), hex"00");
        vm.expectRevert(RailgunExecutionGuard.UnexpectedDelegate.selector);
        guard.execute(ACCOUNT, execution(0, 1, false), 0);
    }

    function testRejectsNonOperatorCalls() public {
        vm.expectRevert(RailgunExecutionGuard.UnauthorizedOperator.selector);
        vm.prank(address(0x4567));
        guard.execute(ACCOUNT, execution(0, 1, false), 0);
    }

    function testRejectsOtherSelectorsAndShortCalldata() public {
        vm.expectRevert(RailgunExecutionGuard.UnsupportedExecution.selector);
        guard.execute(ACCOUNT, hex"12345678", 0);
        vm.expectRevert(RailgunExecutionGuard.UnsupportedExecution.selector);
        guard.execute(ACCOUNT, hex"3e12cc", 0);
    }

    function testRollsBackAnInnerFailure() public {
        vm.expectRevert(RailgunExecutionGuard.ExecutionFailed.selector);
        guard.execute(ACCOUNT, execution(0, 1, true), 0);
        require(TestDelegate(ACCOUNT).nonce() == 0);
    }

    function testRejectsSuccessWithoutConsumingTheExecutionNonce() public {
        vm.expectRevert(RailgunExecutionGuard.InvalidExecutionNonce.selector);
        guard.execute(ACCOUNT, execution(0, 0, false), 0);
        require(TestDelegate(ACCOUNT).nonce() == 0);
    }

    function testRollsBackUnexpectedAdditionalExecutions() public {
        vm.expectRevert(RailgunExecutionGuard.InvalidExecutionNonce.selector);
        guard.execute(ACCOUNT, execution(0, 2, false), 0);
        require(TestDelegate(ACCOUNT).nonce() == 0);
    }

    function testFuzzBindsTheExactExecutionNonce(uint128 nonce) public {
        vm.store(ACCOUNT, bytes32(0), bytes32(uint256(nonce)));
        guard.execute(ACCOUNT, execution(nonce, 1, false), nonce);
        require(TestDelegate(ACCOUNT).nonce() == uint256(nonce) + 1);
    }
}
