// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal interface for Robinhood Chain's canonical USDG token.
interface IOphisRewardsToken {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address recipient, uint256 amount) external returns (bool);
}

/// @title OphisRewardsDistributor
/// @notice Finite, non-expiring USDG rewards for eligible Ophis swaps.
/// @dev A signer authorizes assignments; any relayer may submit assignments and
///      claims. Tokens are always paid directly to the assigned recipient.
contract OphisRewardsDistributor {
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 public constant ONE_DOLLAR_REWARD = 1_000_000;
    uint256 public constant TEN_DOLLAR_REWARD = 10_000_000;
    uint256 public constant MAX_ONE_DOLLAR_REWARDS = 100;
    uint256 public constant MAX_TEN_DOLLAR_REWARDS = 5;
    uint256 public constant MAX_TICKETS = 105;
    uint256 public constant MAX_LIFETIME_PAYOUT = 150_000_000;

    bytes32 public constant ASSIGNMENT_TYPEHASH =
        keccak256("Assignment(address recipient,uint256 ticketId,uint256 amount,uint256 signerEpoch)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Ophis Rewards");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IOphisRewardsToken public immutable rewardToken;
    address public immutable owner;
    bytes32 public immutable DOMAIN_SEPARATOR;

    address public rewardSigner;
    uint256 public signerEpoch;
    bool public paused;
    uint256 public oneDollarAssigned;
    uint256 public tenDollarAssigned;
    uint256 public totalAssigned;
    uint256 public totalAssignedValue;
    uint256 public totalClaimed;
    uint256 public totalClaimedValue;

    mapping(address => uint256) public rewardOf;
    mapping(address => uint256) public ticketOf;
    mapping(address => bool) public claimed;
    mapping(uint256 => bool) public assignedTicket;

    error AlreadyAssigned();
    error AlreadyClaimed();
    error CampaignInventoryExhausted();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidChain();
    error InvalidSignature();
    error InvalidTicket();
    error InsufficientFunding();
    error NotAssigned();
    error NotOwner();
    error Paused();
    error TokenTransferFailed();

    event Assigned(address indexed recipient, uint256 indexed ticketId, uint256 amount);
    event Claimed(address indexed recipient, uint256 indexed ticketId, uint256 amount, address relayer);
    event PausedStateChanged(bool paused);
    event RewardSignerChanged(address indexed previousSigner, address indexed newSigner);

    constructor(address token, address safeOwner, address initialRewardSigner) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert InvalidChain();
        if (token == address(0) || safeOwner == address(0) || initialRewardSigner == address(0)) {
            revert InvalidAddress();
        }

        rewardToken = IOphisRewardsToken(token);
        owner = safeOwner;
        rewardSigner = initialRewardSigner;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    /// @notice Permanently reserves a signed prize for one wallet.
    function assign(
        address recipient,
        uint256 ticketId,
        uint256 amount,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();
        if (ticketId == 0 || ticketId > MAX_TICKETS) revert InvalidTicket();
        if (rewardOf[recipient] != 0) revert AlreadyAssigned();
        if (assignedTicket[ticketId]) revert AlreadyAssigned();
        if (totalAssigned >= MAX_TICKETS) revert CampaignInventoryExhausted();

        if (amount == ONE_DOLLAR_REWARD) {
            if (oneDollarAssigned >= MAX_ONE_DOLLAR_REWARDS) revert CampaignInventoryExhausted();
        } else if (amount == TEN_DOLLAR_REWARD) {
            if (tenDollarAssigned >= MAX_TEN_DOLLAR_REWARDS) revert CampaignInventoryExhausted();
        } else {
            revert InvalidAmount();
        }

        uint256 nextAssignedValue = totalAssignedValue + amount;
        uint256 outstandingAfterAssignment = nextAssignedValue - totalClaimedValue;
        if (rewardToken.balanceOf(address(this)) < outstandingAfterAssignment) revert InsufficientFunding();

        bytes32 structHash = keccak256(
            abi.encode(ASSIGNMENT_TYPEHASH, recipient, ticketId, amount, signerEpoch)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > SECP256K1N_DIV_2) revert InvalidSignature();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != rewardSigner) revert InvalidSignature();

        assignedTicket[ticketId] = true;
        rewardOf[recipient] = amount;
        ticketOf[recipient] = ticketId;
        totalAssigned += 1;
        totalAssignedValue = nextAssignedValue;
        if (amount == ONE_DOLLAR_REWARD) oneDollarAssigned += 1;
        else tenDollarAssigned += 1;

        assert(totalAssignedValue <= MAX_LIFETIME_PAYOUT);
        emit Assigned(recipient, ticketId, amount);
    }

    /// @notice Pays an assigned prize. Anyone may relay; only the recipient is paid.
    function claim(address recipient) external whenNotPaused {
        uint256 amount = rewardOf[recipient];
        if (amount == 0) revert NotAssigned();
        if (claimed[recipient]) revert AlreadyClaimed();

        claimed[recipient] = true;
        totalClaimed += 1;
        totalClaimedValue += amount;
        uint256 ticketId = ticketOf[recipient];

        assert(totalClaimed <= totalAssigned);
        assert(totalClaimedValue <= totalAssignedValue);
        // Emitting before the external call prevents callback-induced event
        // reordering; an unsuccessful transfer reverts this log atomically.
        emit Claimed(recipient, ticketId, amount, msg.sender);

        (bool success, bytes memory returnData) = address(rewardToken).call(
            abi.encodeCall(IOphisRewardsToken.transfer, (recipient, amount))
        );
        if (!success || (returnData.length != 0 && (returnData.length != 32 || !abi.decode(returnData, (bool))))) {
            revert TokenTransferFailed();
        }

    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PausedStateChanged(nextPaused);
    }

    function setRewardSigner(address nextRewardSigner) external onlyOwner {
        if (nextRewardSigner == address(0)) revert InvalidAddress();
        address previousSigner = rewardSigner;
        rewardSigner = nextRewardSigner;
        signerEpoch += 1;
        emit RewardSignerChanged(previousSigner, nextRewardSigner);
    }
}
