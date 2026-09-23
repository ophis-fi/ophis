// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Deliberately unauthenticated local fixtures. Never deploy to a public chain.
contract LocalBridgeHost {
    function run(address target, bytes calldata data) external {
        require(target.code.length != 0, "missing VM");
        (bool ok, bytes memory result) = target.delegatecall(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
}

contract LocalCreate2Proxy {
    fallback() external {
        bytes memory data = msg.data;
        address deployed;
        assembly { deployed := create2(0, add(data, 64), sub(mload(data), 32), mload(add(data, 32))) }
        require(deployed != address(0), "create2 failed");
    }
}

interface IBridgeToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract LocalSpokePool {
    bool public fail;
    uint256 public deposits;
    event Deposit(address caller, bytes arguments);
    event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount,
        uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline,
        uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message);
    function setFail(bool value) external { fail = value; }
    function depositV3(
        address depositor, address recipient, address inputToken, address outputToken,
        uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer,
        uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes calldata message
    ) external {
        require(depositor == msg.sender, "depositor");
        require(destinationChainId == 5042, "destination");
        require(quoteTimestamp <= block.timestamp && block.timestamp <= fillDeadline, "deadline");
        require(IBridgeToken(inputToken).transferFrom(msg.sender, address(this), inputAmount), "input");
        // Revert AFTER the transfer to verify rollback of the whole hook.
        require(!fail, "fixture Spoke revert");
        deposits++;
        emit Deposit(msg.sender, msg.data[4:]);
        emit FundsDeposited(bytes32(uint256(uint160(inputToken))), bytes32(uint256(uint160(outputToken))),
            inputAmount, outputAmount, destinationChainId, deposits, quoteTimestamp, fillDeadline, exclusivityDeadline,
            bytes32(uint256(uint160(depositor))), bytes32(uint256(uint160(recipient))),
            bytes32(uint256(uint160(exclusiveRelayer))), message);
    }
}

// Source swap fixture for the browser test. The real Arc solver/backend is tested separately.
// The test verifies the user's EIP-712 order before invoking this local-only executor.
contract LocalSourceRelayer {
    function pull(address token, address owner, uint256 amount) external {
        require(msg.sender == 0x9008D19f58AAbD9eD0D60971565AA8510560ab41, "fixture settlement only");
        require(IBridgeToken(token).transferFrom(owner, msg.sender, amount), "source input");
    }
}

interface IFixtureMint { function mint(address receiver, uint256 amount) external; }

contract LocalSourceSettlement {
    struct Hook { address target; uint256 value; bytes data; }
    event Trade(address indexed owner, address sellToken, address buyToken,
        uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid);
    function execute(address owner, address receiver, uint256 sellAmount, uint256 buyAmount,
        bytes calldata uid, Hook[] calldata hooks) external {
        address weth = 0x4200000000000000000000000000000000000006;
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        LocalSourceRelayer(0xC92E8bdf79f0507f65a392b0ab4667716BFE0110).pull(weth, owner, sellAmount);
        IFixtureMint(usdc).mint(receiver, buyAmount);
        emit Trade(owner, weth, usdc, sellAmount, buyAmount, 0, uid);
        for (uint256 i; i < hooks.length; ++i) {
            (bool ok, bytes memory reason) = hooks[i].target.call{value: hooks[i].value}(hooks[i].data);
            if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        }
    }
}
