// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "src/contracts/libraries/GPv2Order.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function enableModule(address module) external;
    function isModuleEnabled(address module) external view returns (bool);
}

/// @title B5 preflight: the vault policy module against REAL Unichain state.
/// @notice Constructs the module with the EXACT production config we intend to
/// deploy - REAL Unichain Chainlink ETH/USD + USDC/USD feeds (18-decimal, 24h
/// heartbeat), the REAL L2 sequencer-uptime feed, and the REAL Ophis settlement
/// - on a Unichain fork, and proves: the constructor's feed liveness probe
/// passes against real fresh feeds; a legit rebalance presigns in the real
/// settlement with exact allowance; the real oracle produces a nonzero floor
/// (a below-floor order reverts); and a drain order is rejected. This is the
/// gate before the mainnet deploy.
///
/// Run: OPHIS_FORK_RPC_UNICHAIN=https://mainnet.unichain.org forge test \
///        --match-path 'test/fork/VaultPolicyModuleUnichainReal.t.sol'
contract VaultPolicyModuleUnichainReal is Test {
    // Canonical Safe v1.3.0 (same on every chain).
    address internal constant SAFE_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address internal constant SAFE_L2_SINGLETON = 0xfb1bffC9d739B8D520DaF37dF666da4C687191EA;
    address internal constant SAFE_FALLBACK = 0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4;

    // Unichain (130) production addresses.
    address internal constant SETTLEMENT = 0x108A678716e5E1776036eF044CAB7064226F714E;
    address internal constant USDC = 0x078D782b760474a361dDA0AF3839290b0EF57AD6; // 6 dec
    address internal constant WETH = 0x4200000000000000000000000000000000000006; // 18 dec
    address internal constant USDC_USD_FEED = 0xbd1cD1518eFB92a92100da62D4C488c810dFd75b; // 18 dec
    address internal constant ETH_USD_FEED = 0xBcE70e194940a157f3A80566505a7E96f5238CCa; // 18 dec
    address internal constant SEQUENCER_FEED = 0x495639D9914e7D270c5dCC641BfB1d807423F813;

    uint256 internal constant MAX_STALENESS = 26 hours; // 24h heartbeat + buffer
    uint256 internal constant SEQ_GRACE = 1 hours;

    address internal constant CURATOR = address(0xC0FFEE);
    address internal constant SAFE_OWNER = address(0xA11CE);
    bytes32 internal constant APP_DATA = keccak256("ophis-unichain-appdata");

    ISafeSetup internal safe;
    OphisVaultPolicyModule internal module;

    function setUp() public {
        string memory rpc = vm.envOr("OPHIS_FORK_RPC_UNICHAIN", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);

        address[] memory owners = new address[](1);
        owners[0] = SAFE_OWNER;
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector,
            owners, uint256(1), address(0), bytes(""), SAFE_FALLBACK, address(0), uint256(0), payable(address(0))
        );
        address proxy = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(
            SAFE_L2_SINGLETON, initializer, uint256(keccak256("ophis-b5-preflight"))
        );
        safe = ISafeSetup(proxy);

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(USDC, IAggregatorV3(USDC_USD_FEED), MAX_STALENESS);
        tokens[1] = OphisVaultPolicyModule.TokenFeed(WETH, IAggregatorV3(ETH_USD_FEED), MAX_STALENESS);

        // Deploy through the factory with the EXACT production config. If the
        // constructor's per-feed liveness probe reverted (stale / invalid feed),
        // this would fail - so a passing setUp is itself the proof the real
        // feeds serve a fresh price.
        OphisVaultPolicyModuleFactory factory = new OphisVaultPolicyModuleFactory();
        module = factory.deploy(
            OphisVaultPolicyModule.ModuleConfig({
                safe: ISafe(proxy),
                settlement: IGPv2Settlement(SETTLEMENT),
                curator: CURATOR,
                appDataHash: APP_DATA,
                maxSlippageBps: 50,
                maxTtl: 1800,
                dailyUsdTurnoverCap: 1_000e18,
                sequencerUptimeFeed: IAggregatorV3(SEQUENCER_FEED),
                sequencerGracePeriod: SEQ_GRACE,
                tokens: tokens
            })
        );
        vm.prank(proxy);
        safe.enableModule(address(module));
    }

    function _forked() internal view returns (bool) {
        return address(module) != address(0);
    }

    function _order(address receiver, uint256 buyAmount) internal view returns (GPv2Order.Data memory) {
        return GPv2Order.Data({
            sellToken: IERC20(USDC),
            buyToken: IERC20(WETH),
            receiver: receiver,
            sellAmount: 100e6, // 100 USDC
            buyAmount: buyAmount,
            validTo: uint32(block.timestamp + 1800),
            appData: APP_DATA,
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
    }

    /// The module constructed against REAL feeds (probe passed) and a legit
    /// rebalance presigns in the REAL settlement with an exact relayer allowance.
    function test_unichain_real_construct_and_presign() public {
        if (!_forked()) vm.skip(true);
        assertTrue(safe.isModuleEnabled(address(module)));
        // buyAmount high enough to clear any real floor; the point is the real
        // oracle read + real settlement presign, not the floor value.
        GPv2Order.Data memory order = _order(address(safe), 1e30);
        vm.prank(CURATOR);
        bytes memory uid = module.rebalance(order, 0);
        IGPv2Settlement s = IGPv2Settlement(SETTLEMENT);
        assertEq(s.preSignature(uid), uint256(keccak256("GPv2Signing.Scheme.PreSign")));
        assertEq(IERC20(USDC).allowance(address(safe), s.vaultRelayer()), 100e6);
    }

    /// The REAL oracle produces a nonzero floor: a 1-wei buyAmount reverts
    /// BelowFloor (proves read18 against the real 18-decimal feeds works).
    function test_unichain_real_below_floor_reverts() public {
        if (!_forked()) vm.skip(true);
        vm.prank(CURATOR);
        vm.expectRevert(); // BelowFloor(1, realFloor)
        module.rebalance(_order(address(safe), 1), 0);
    }

    /// A drain order (attacker receiver) is rejected on-chain.
    function test_unichain_real_drain_rejected() public {
        if (!_forked()) vm.skip(true);
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.ReceiverNotSafe.selector);
        module.rebalance(_order(address(0xBAD), 1e30), 0);
    }
}
