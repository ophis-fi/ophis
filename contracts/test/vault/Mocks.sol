// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {GPv2Order} from "src/contracts/libraries/GPv2Order.sol";

/// @dev Minimal Safe stand-in: performs module calls like the real Safe
/// (plain CALL, returns success + return data) and serves `getOwners`.
contract MockSafe {
    address[] internal owners;
    address public enabledModule; // 0 = any caller allowed (pre-enable tests)
    /// @dev Mirrors the real Safe's `isModuleEnabled`. The module's deploy-time
    /// curator check reads this to reject a curator that is already a module.
    mapping(address => bool) public isModuleEnabled;

    constructor(address[] memory owners_) {
        owners = owners_;
    }

    function setEnabledModule(address module) external {
        enabledModule = module;
        if (module != address(0)) isModuleEnabled[module] = true;
    }

    /// @dev Mark an address as an enabled module WITHOUT making it the exec-gate
    /// module - used to exercise the curator-is-module rejection at deploy.
    function setModuleEnabled(address module, bool enabled) external {
        isModuleEnabled[module] = enabled;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation
    ) external returns (bool success, bytes memory returnData) {
        require(operation == 0, "MockSafe: no delegatecall");
        require(
            enabledModule == address(0) || msg.sender == enabledModule,
            "MockSafe: module not enabled"
        );
        (success, returnData) = to.call{value: value}(data);
    }
}

/// @dev Standard ERC20 surface the module touches; `approveReturn` lets a
/// test flip it into a token whose approve returns `false`.
contract MockERC20 {
    uint8 public decimals;
    bool public approveReturn = true;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setApproveReturn(bool value) external {
        approveReturn = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return approveReturn;
    }
}

/// @dev USDT-style token: approve returns NO data and reverts on a
/// nonzero -> nonzero allowance change (forces the reset-to-zero path).
contract MockUSDT {
    uint8 public decimals;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function approve(address spender, uint256 amount) external {
        require(
            amount == 0 || allowance[msg.sender][spender] == 0,
            "USDT: reset allowance first"
        );
        allowance[msg.sender][spender] = amount;
    }
}

/// @dev Chainlink AggregatorV3 stand-in with settable answer + freshness.
contract MockFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    /// @dev Set the round bookkeeping to exercise the stale-round guards
    /// (`answeredInRound < roundId`, or an incomplete round with `updatedAt == 0`).
    function setRounds(uint80 roundId_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @dev Chainlink L2 sequencer uptime feed stand-in. For these feeds
/// `answer == 0` means up, non-zero means down, and `startedAt` is when the
/// current status began.
contract MockSequencerUptimeFeed {
    uint8 public decimals = 0;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;

    constructor(int256 answer_, uint256 startedAt_, uint256 updatedAt_) {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function setStatus(int256 answer_, uint256 startedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = block.timestamp;
    }

    function setRounds(uint80 roundId_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

/// @dev Settlement stand-in with REAL GPv2 presign semantics: it enforces
/// `uid.owner == msg.sender` via the vendored `extractOrderUidParams` and
/// stores the real PRE_SIGNED marker, so a passing happy-path test
/// structurally proves the module packs the Safe as the uid owner.
contract MockSettlement {
    bytes32 public domainSeparator;
    address public vaultRelayer;
    mapping(bytes => uint256) public preSignature;

    uint256 public constant PRE_SIGNED =
        uint256(keccak256("GPv2Signing.Scheme.PreSign"));

    constructor(bytes32 domainSeparator_, address vaultRelayer_) {
        domainSeparator = domainSeparator_;
        vaultRelayer = vaultRelayer_;
    }

    function setPreSignature(bytes calldata orderUid, bool signed) external {
        (, address owner, ) = GPv2Order.extractOrderUidParams(orderUid);
        require(owner == msg.sender, "GPv2: cannot presign order");
        preSignature[orderUid] = signed ? PRE_SIGNED : 0;
    }
}
