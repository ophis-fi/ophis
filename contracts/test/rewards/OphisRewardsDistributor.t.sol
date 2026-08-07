// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {OphisRewardsDistributor} from "../../src/contracts/rewards/OphisRewardsDistributor.sol";

contract RewardsMockUSDG {
    mapping(address => uint256) public balanceOf;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        require(balance >= amount, "insufficient balance");
        balanceOf[msg.sender] = balance - amount;
        balanceOf[recipient] += amount;
        return true;
    }
}

contract NoReturnMockUSDG {
    mapping(address => uint256) public balanceOf;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function transfer(address recipient, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
    }
}

contract OphisRewardsDistributorTest is Test {
    uint256 private constant SIGNER_KEY = 0xA11CE;
    address private constant SAFE = address(0x5AFE);
    address private constant ALICE = address(0xA11CE1);
    address private constant BOB = address(0xB0B);

    RewardsMockUSDG private token;
    OphisRewardsDistributor private distributor;

    function setUp() public {
        vm.chainId(4663);
        token = new RewardsMockUSDG();
        distributor = new OphisRewardsDistributor(address(token), SAFE, vm.addr(SIGNER_KEY));
        token.mint(address(distributor), distributor.MAX_LIFETIME_PAYOUT());
    }

    function testAssignPermanentlyReservesAndRelayerClaims() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE, 1, distributor.TEN_DOLLAR_REWARD());

        distributor.assign(ALICE, 1, distributor.TEN_DOLLAR_REWARD(), v, r, s);

        assertEq(distributor.rewardOf(ALICE), 10_000_000);
        assertEq(distributor.ticketOf(ALICE), 1);
        assertEq(distributor.totalAssignedValue(), 10_000_000);

        vm.prank(BOB);
        distributor.claim(ALICE);

        assertEq(token.balanceOf(ALICE), 10_000_000);
        assertEq(token.balanceOf(BOB), 0);
        assertEq(distributor.totalClaimedValue(), 10_000_000);
        assertTrue(distributor.claimed(ALICE));
    }

    function testRejectsSecondTicketForWallet() public {
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign(ALICE, 1, distributor.ONE_DOLLAR_REWARD());
        distributor.assign(ALICE, 1, distributor.ONE_DOLLAR_REWARD(), v1, r1, s1);

        (uint8 v2, bytes32 r2, bytes32 s2) = _sign(ALICE, 2, distributor.ONE_DOLLAR_REWARD());
        vm.expectRevert(OphisRewardsDistributor.AlreadyAssigned.selector);
        distributor.assign(ALICE, 2, 1_000_000, v2, r2, s2);
    }

    function testRejectsTicketReplayForDifferentWallet() public {
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign(ALICE, 1, distributor.ONE_DOLLAR_REWARD());
        distributor.assign(ALICE, 1, distributor.ONE_DOLLAR_REWARD(), v1, r1, s1);

        (uint8 v2, bytes32 r2, bytes32 s2) = _sign(BOB, 1, distributor.ONE_DOLLAR_REWARD());
        vm.expectRevert(OphisRewardsDistributor.AlreadyAssigned.selector);
        distributor.assign(BOB, 1, 1_000_000, v2, r2, s2);
    }

    function testRejectsWrongSignerAndArbitraryAmount() public {
        (uint8 v, bytes32 r, bytes32 s) = _signWithKey(0xBAD, ALICE, 1, distributor.ONE_DOLLAR_REWARD());
        vm.expectRevert(OphisRewardsDistributor.InvalidSignature.selector);
        distributor.assign(ALICE, 1, 1_000_000, v, r, s);

        (v, r, s) = _sign(ALICE, 1, 2_000_000);
        vm.expectRevert(OphisRewardsDistributor.InvalidAmount.selector);
        distributor.assign(ALICE, 1, 2_000_000, v, r, s);
    }

    function testCannotClaimTwice() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE, 1, distributor.ONE_DOLLAR_REWARD());
        distributor.assign(ALICE, 1, distributor.ONE_DOLLAR_REWARD(), v, r, s);
        distributor.claim(ALICE);

        vm.expectRevert(OphisRewardsDistributor.AlreadyClaimed.selector);
        distributor.claim(ALICE);
    }

    function testAssignmentFailsClosedWhenUnderfunded() public {
        RewardsMockUSDG emptyToken = new RewardsMockUSDG();
        OphisRewardsDistributor emptyDistributor =
            new OphisRewardsDistributor(address(emptyToken), SAFE, vm.addr(SIGNER_KEY));
        distributor = emptyDistributor;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE, 1, emptyDistributor.ONE_DOLLAR_REWARD());
        vm.expectRevert(OphisRewardsDistributor.InsufficientFunding.selector);
        emptyDistributor.assign(ALICE, 1, 1_000_000, v, r, s);
    }

    function testClaimAcceptsCanonicalNoReturnToken() public {
        NoReturnMockUSDG noReturnToken = new NoReturnMockUSDG();
        OphisRewardsDistributor noReturnDistributor =
            new OphisRewardsDistributor(address(noReturnToken), SAFE, vm.addr(SIGNER_KEY));
        noReturnToken.mint(address(noReturnDistributor), noReturnDistributor.MAX_LIFETIME_PAYOUT());
        distributor = noReturnDistributor;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE, 1, noReturnDistributor.ONE_DOLLAR_REWARD());
        noReturnDistributor.assign(ALICE, 1, 1_000_000, v, r, s);
        noReturnDistributor.claim(ALICE);
        assertEq(noReturnToken.balanceOf(ALICE), 1_000_000);
    }

    function testSafeCanPauseAndRotateSigner() public {
        vm.prank(SAFE);
        distributor.setPaused(true);

        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE, 1, distributor.ONE_DOLLAR_REWARD());
        vm.expectRevert(OphisRewardsDistributor.Paused.selector);
        distributor.assign(ALICE, 1, 1_000_000, v, r, s);

        address nextSigner = vm.addr(0xBEEF);
        vm.prank(SAFE);
        distributor.setRewardSigner(nextSigner);
        assertEq(distributor.rewardSigner(), nextSigner);
        assertEq(distributor.signerEpoch(), 1);

        vm.prank(SAFE);
        distributor.setPaused(false);
        vm.expectRevert(OphisRewardsDistributor.InvalidSignature.selector);
        distributor.assign(ALICE, 1, 1_000_000, v, r, s);
    }

    function testOnlySafeCanAdminister() public {
        vm.expectRevert(OphisRewardsDistributor.NotOwner.selector);
        distributor.setPaused(true);

        vm.expectRevert(OphisRewardsDistributor.NotOwner.selector);
        distributor.setRewardSigner(BOB);
    }

    function testFullInventoryNeverExceedsOneHundredFiftyUSDG() public {
        for (uint256 ticketId = 1; ticketId <= 105; ++ticketId) {
            address recipient = address(uint160(10_000 + ticketId));
            uint256 amount = ticketId <= 5 ? distributor.TEN_DOLLAR_REWARD() : distributor.ONE_DOLLAR_REWARD();
            (uint8 v, bytes32 r, bytes32 s) = _sign(recipient, ticketId, amount);
            distributor.assign(recipient, ticketId, amount, v, r, s);
        }

        assertEq(distributor.tenDollarAssigned(), 5);
        assertEq(distributor.oneDollarAssigned(), 100);
        assertEq(distributor.totalAssigned(), 105);
        assertEq(distributor.totalAssignedValue(), 150_000_000);

        address extra = address(0xEEEE);
        (uint8 extraV, bytes32 extraR, bytes32 extraS) =
            _sign(extra, 105, distributor.ONE_DOLLAR_REWARD());
        vm.expectRevert(OphisRewardsDistributor.AlreadyAssigned.selector);
        distributor.assign(
            extra,
            105,
            1_000_000,
            extraV,
            extraR,
            extraS
        );
    }

    function testDeploymentRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(OphisRewardsDistributor.InvalidChain.selector);
        new OphisRewardsDistributor(address(token), SAFE, vm.addr(SIGNER_KEY));
    }

    function _sign(address recipient, uint256 ticketId, uint256 amount)
        private
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return _signWithKey(SIGNER_KEY, recipient, ticketId, amount);
    }

    function _signWithKey(uint256 key, address recipient, uint256 ticketId, uint256 amount)
        private
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(distributor.ASSIGNMENT_TYPEHASH(), recipient, ticketId, amount, distributor.signerEpoch())
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", distributor.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(key, digest);
    }
}
