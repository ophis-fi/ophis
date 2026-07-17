// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Actor} from "./Actor.sol";
import {Clamp} from "./utils/Clamp.sol";
import {DecimalPrinter} from "./utils/DecimalPrinter.sol";
import {Deployer} from "./utils/Deployer.sol";
import {vm} from "./utils/Hevm.sol";
import {Logger} from "./utils/Logger.sol";
import {Math} from "./utils/Math.sol";
import {StringUtils} from "./utils/StringUtils.sol";
import {EnumerableSet} from "./utils/EnumerableSet.sol";

import {AllowListGuardian} from "../../src/contracts/AllowListGuardian.sol";
import {GPv2AllowListAuthentication} from "../../src/contracts/GPv2AllowListAuthentication.sol";
import {GPv2EIP1967} from "../../src/contracts/libraries/GPv2EIP1967.sol";
// Reused from the project's own Foundry unit tests (Source Priority: reuse
// existing setup logic). This harness is functionally identical to
// GPv2AllowListAuthentication but sets the EIP-1967 proxy-admin storage slot
// in its constructor, emulating being deployed behind an EIP-1967 proxy
// without needing a real proxy contract (solc 0.7.6 also can't read
// immutables during construction, which is why upstream avoids a real proxy
// here too).
import {GPv2AllowListAuthenticationHarness} from "../GPv2AllowListAuthenticator/Helper.sol";

/// @notice Base contract with state variables and setup functions
abstract contract Base is StringUtils, Clamp, Deployer, Math {
    using DecimalPrinter for uint256;

    string[] internal ACTOR_LABELS = ["Alice", "Bob", "Charlie"];
    uint256 internal constant BLOCK_INTERVAL = 12 seconds;
    uint256 internal constant INITIAL_ETH_BALANCE = 1_000 ether;
    uint256 internal constant INITIAL_TOKEN_BALANCE = 10_000;

    // These two contracts hold no funds and encode no economic parameters
    // (x-ray §4/Economic: None) -- actors need no ETH/token seeding to reach
    // meaningful states here, only the right caller identity.

    // ―――――――――――――――――――――――――― Ghosts ――――――――――――――――――――――――――

    struct Ghosts {
        // Tag identifying which op the most recently completed handler
        // performed (see the lastOp tag constants below). Set at the top of
        // every handler; read by GL-08/GL-10/GL-11/GL-12 and SP-11.
        uint8 lastOp;
        // GL-02: guardian-path unauthorized add/handoff/rotation. Must stay false.
        bool unauthorizedGuardianAdd;
        bool unauthorizedGuardianManagerChange;
        bool unauthorizedGuardianRotation;
        // GL-03: guardian-path unauthorized removeSolver. Must stay false.
        bool unauthorizedGuardianRemove;
        // GL-04: direct-path unauthorized mutation. Must stay false.
        bool unauthorizedDirectAdd;
        bool unauthorizedDirectRemove;
        bool unauthorizedDirectManagerMutation;
        // SP-19: anti-grief pendingManager mutation by a non-{manager,admin}. Must stay false.
        bool unauthorizedPendingManagerMutation;
        // GL-09 / SP-02: most-recently proposeManager'd address.
        address lastProposedManager;
        // GL-09: an accept ever succeeded for a non-exact/stale pending manager. Must stay false.
        bool nonExactAcceptSucceeded;
        // SP-17: cross-role rejection at the Guardian layer. Must stay false.
        bool guardianSucceededOnTimelockOnlyFn;
        bool timelockSucceededOnGuardianOnlyFn;
        // SP-18: guardian rotated itself while msg.sender != timelock. Must stay false.
        bool guardianSelfRotated;
        // GL-17: initializeManager succeeded a second time. Must stay false.
        bool initializeManagerSucceededTwice;
        // SP-21 [EXPECTED-VIOLATED lead]: guardian became manager then instant-added.
        bool guardianBecameManagerThenInstantAdded;
        // SP-23 [EXPECTED-VIOLATED lead]: timelock broke the X-1 evict binding.
        bool timelockBrokeEvictBinding;
        bool evictBlockedByBrokenBinding;
        // SP-24 [EXPECTED-VIOLATED lead]: manager==0 observed / bricked both paths.
        bool managerEverZeroed;
        bool bothPathsBrickedByZeroManager;
        // SP-25: admin rescue path unexpectedly failed. Must stay false.
        bool adminRescueEverFailed;
        // SP-16: acceptManagership ever zeroed the manager. Must stay false.
        bool acceptManagershipEverZeroedManager;
        // GL-16: EIP-1967 admin slot, captured once live at the end of setup().
        address initialAdmin;
        // SP-15: true only inside acceptManagership handlers; false at entry
        // of setManager/proposeManager/cancelManagerTransfer handlers.
        bool lastCallWasAccept;
    }

    Ghosts internal ghosts;

    // lastOp tag values -- referenced by both the (7B-owned) handler files
    // and the global properties in Properties.sol.
    uint8 internal constant NONE = 0;
    uint8 internal constant GUARD_ADD = 1;
    uint8 internal constant GUARD_REMOVE = 2;
    uint8 internal constant GUARD_SETMGR = 3;
    uint8 internal constant GUARD_SETGUARD = 4;
    uint8 internal constant DIR_ADD = 5;
    uint8 internal constant DIR_REMOVE = 6;
    uint8 internal constant DIR_SETMGR = 7;
    uint8 internal constant DIR_PROPOSE = 8;
    uint8 internal constant DIR_ACCEPT = 9;
    uint8 internal constant DIR_CANCEL = 10;
    uint8 internal constant INIT = 11;

    // Solver-candidate address that handlers set immediately before
    // `snapshotBefore()`/`snapshotAfter()` so `Snapshots.isSolverTarget` can
    // read `authentication.isSolver(currentTarget)`.
    address internal currentTarget;

    // ―――――――――――――――――――――――――― Actors ――――――――――――――――――――――――――

    address[] internal actors;
    address internal actor;
    address internal admin;

    // Dedicated governance-role addresses, deliberately OUTSIDE the `actors`
    // pool (mirrors contracts/echidna/E2EAllowListGuardian.sol's convention)
    // so that `asActor`-driven calls are a genuine "unauthorized stranger"
    // test, never accidentally the timelock or guardian.
    //
    // TIMELOCK_ROLE plays BOTH the Guardian's immutable `timelock` AND the
    // GPv2AllowListAuthentication EIP-1967 proxy admin -- matching the
    // documented production intent (x-ray.md §2: "proxy admin should be
    // transferred to the SAME timelock"). This makes the `onlyManagerOrOwner`
    // admin-escape-hatch path (G-7) reachable and 24h-gated in practice, as
    // intended, rather than permanently dead code in the harness.
    address internal constant TIMELOCK_ROLE = address(0x1111);
    address internal constant GUARDIAN_ROLE = address(0x2222);

    modifier asActor() virtual {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    modifier asAdmin() virtual {
        vm.startPrank(admin);
        _;
        vm.stopPrank();
    }

    modifier asTimelock() virtual {
        vm.startPrank(TIMELOCK_ROLE);
        _;
        vm.stopPrank();
    }

    modifier asGuardian() virtual {
        vm.startPrank(GUARDIAN_ROLE);
        _;
        vm.stopPrank();
    }

    // ―――――――――――――――――――――――― Contracts ―――――――――――――――――――――――――

    GPv2AllowListAuthenticationHarness internal authentication;
    AllowListGuardian internal allowListGuardian;

    // ―――――――――――――――――――――――――― Setup ―――――――――――――――――――――――――――

    function setup() internal {
        vm.label(TIMELOCK_ROLE, "TimelockRole");
        vm.label(GUARDIAN_ROLE, "GuardianRole");

        // Deploy order mirrors entry-points.md's "Install (script)" flow and
        // test/GPv2AllowListAuthenticator/AllowListGuardian.t.sol:
        //   1. authenticator (EIP-1967 admin = TIMELOCK_ROLE)
        //   2. Guardian, wired to (authenticator, TIMELOCK_ROLE, GUARDIAN_ROLE)
        //   3. bind the Guardian as authenticator.manager() from tx #0 (X-1
        //      binding) via the one-time initializer -- the realistic
        //      steady-state deployment topology, from block zero.
        authentication = new GPv2AllowListAuthenticationHarness(TIMELOCK_ROLE);
        allowListGuardian = new AllowListGuardian(address(authentication), TIMELOCK_ROLE, GUARDIAN_ROLE);
        authentication.initializeManager(address(allowListGuardian));
        vm.label(address(authentication), "GPv2AllowListAuthentication");
        vm.label(address(allowListGuardian), "AllowListGuardian");

        setupActors();

        // GL-16: capture the EIP-1967 admin slot once, live, right after
        // deployment (never hardcoded). The harness constructor sets this
        // slot to TIMELOCK_ROLE (see GPv2AllowListAuthenticationHarness in
        // test/GPv2AllowListAuthenticator/Helper.sol), so
        // `ghosts.initialAdmin == TIMELOCK_ROLE` holds from block zero here.
        ghosts.initialAdmin = address(uint160(uint256(vm.load(address(authentication), GPv2EIP1967.ADMIN_SLOT))));
    }

    function setupActors() internal {
        admin = address(this);
        vm.label(admin, "Admin");

		for (uint256 i; i < ACTOR_LABELS.length; i++) {
			address _actor = address(new Actor{value: INITIAL_ETH_BALANCE}());
            actors.push(_actor);
            if (ACTOR_LABELS.length > i) {
                vm.label(_actor, ACTOR_LABELS[i]);
            }
            // No token/approval seeding needed: AllowListGuardian and
            // GPv2AllowListAuthentication are pure access-control state
            // machines with no funds (x-ray.md §4/Economic: None). Actors
            // only ever need to be able to be pranked as a caller -- see
            // handlers for `toActor(...)`-mapped address parameters
            // (candidate managers/solvers) and the plain `asActor` modifier
            // (an "unauthorized stranger" caller, since actors are never
            // TIMELOCK_ROLE/GUARDIAN_ROLE).
		}
        actor = actors[0];
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    // Maps an arbitrary address to an actor address
    function toActor(address addy) internal view returns (address) {
        return actors[uint256(uint160(addy)) % actors.length];
    }

    // Maps an arbitrary address to an actor address that is different from the current actor
    function toActorNotCurrent(address addy) internal view returns (address) {
        address _actor = actors[uint256(uint160(addy)) % actors.length];
        if (_actor == actor) {
            _actor = actors[(uint256(uint160(addy)) + 1) % actors.length];
        }
        return _actor;
    }

    // Maps an arbitrary address to one of the governance-meaningful
    // candidates for a manager/solver-style parameter: the 3 actors, the
    // AllowListGuardian contract itself (re-proposing/re-handing-off to the
    // Guardian), or the two fixed role addresses (TIMELOCK_ROLE /
    // GUARDIAN_ROLE). Raw/unmapped addresses are still reachable through the
    // sibling unclamped handlers -- this helper exists purely to bias the
    // clamped layer toward the state transitions that are actually
    // interesting to fuzz for a governance-handoff state machine, since a
    // purely random address almost never repeats across an add/remove or
    // propose/accept pair.
    function toGovernanceCandidate(address addy) internal view returns (address) {
        uint256 n = uint256(uint160(addy)) % (actors.length + 3);
        if (n < actors.length) return actors[n];
        if (n == actors.length) return address(allowListGuardian);
        if (n == actors.length + 1) return TIMELOCK_ROLE;
        return GUARDIAN_ROLE;
    }

    // Sums the native token balances of all actors
    function sumActorsBalances() internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            sumOfBalances += actors[i].balance;
        }
    }

    // Sums the ERC-20 token balances of all actors for a given token
    function sumActorsERC20Balances(address _token) internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            bytes memory data = abi.encodeWithSignature("balanceOf(address)", actors[i]);
            (bool success, bytes memory result) = _token.staticcall(data);
            require(success, "sumActorsERC20Balances: failed to get balance");
            sumOfBalances += abi.decode(result, (uint256));
        }
    }

    function skipBlocks(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + blocks * BLOCK_INTERVAL);
    }

    function skipTime(uint256 time) internal {
        uint256 blocks = (time + BLOCK_INTERVAL - 1) / BLOCK_INTERVAL;
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + time);
    }
}
