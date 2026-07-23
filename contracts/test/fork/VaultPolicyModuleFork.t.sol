// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "src/contracts/libraries/GPv2Order.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

import {MockFeed} from "../vault/Mocks.sol";

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

/// @title Fork proof: the vault policy module against REAL deployed contracts.
/// @notice Env-gated (like the @ophis/safe-swap fork tests). Deploys a REAL
/// canonical Safe v1.3.0 via the canonical factory, enables the module, and
/// against the chain's REAL GPv2Settlement + vault relayer proves:
///  1. a legit rebalance records the presignature in the REAL settlement and
///     leaves the EXACT relayer allowance on the Safe;
///  2. a COMPROMISED curator's drain order (attacker receiver) is REJECTED
///     on-chain before any approval or presignature;
///  3. a below-floor drain is rejected too.
///
/// Run: OPHIS_FORK_RPC=https://mainnet.optimism.io forge test \
///        --match-path 'test/fork/VaultPolicyModuleFork.t.sol'
contract VaultPolicyModuleFork is Test {
    // Canonical Safe v1.3.0 (same addresses on every chain).
    address internal constant SAFE_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address internal constant SAFE_L2_SINGLETON = 0xfb1bffC9d739B8D520DaF37dF666da4C687191EA;
    address internal constant SAFE_FALLBACK = 0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4;

    // Chain-specific addresses (env-overridable). Defaults = Optimism (10),
    // Ophis non-canonical settlement + native USDC/WETH. Set OPHIS_FORK_*
    // to run the same proof on Unichain (lead, non-canonical) or Base
    // (canonical CoW settlement).
    address internal settlementAddr = 0x310784c7FCE12d578dA6f53460777bAc9718B859;
    address internal sellTokenAddr = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85; // 6 dec
    address internal buyTokenAddr = 0x4200000000000000000000000000000000000006; // 18 dec

    address internal constant CURATOR = address(0xC0FFEE);
    address internal constant SAFE_OWNER = address(0xA11CE);
    address internal constant ATTACKER = address(0xBAD);
    bytes32 internal constant APP_DATA = keccak256("ophis-partner-fee-appdata");

    ISafeSetup internal safe;
    IGPv2Settlement internal settlement;
    address internal relayer;
    OphisVaultPolicyModule internal module;
    MockFeed internal usdcFeed;
    MockFeed internal wethFeed;

    function setUp() public {
        string memory rpc = vm.envOr("OPHIS_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return; // skipped without a fork RPC
        vm.createSelectFork(rpc);

        settlementAddr = vm.envOr("OPHIS_FORK_SETTLEMENT", settlementAddr);
        sellTokenAddr = vm.envOr("OPHIS_FORK_SELL", sellTokenAddr);
        buyTokenAddr = vm.envOr("OPHIS_FORK_BUY", buyTokenAddr);
        settlement = IGPv2Settlement(settlementAddr);
        relayer = settlement.vaultRelayer();

        // Deploy a REAL canonical Safe (owner = SAFE_OWNER, threshold 1).
        address[] memory owners = new address[](1);
        owners[0] = SAFE_OWNER;
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector,
            owners,
            uint256(1),
            address(0),
            bytes(""),
            SAFE_FALLBACK,
            address(0),
            uint256(0),
            payable(address(0))
        );
        address proxy = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(
            SAFE_L2_SINGLETON,
            initializer,
            uint256(keccak256("ophis-vault-fork"))
        );
        safe = ISafeSetup(proxy);

        // Mock oracle feeds (the settlement/relayer/Safe are the REAL contracts
        // under test; the oracle math is exhaustively unit + fuzz tested).
        usdcFeed = new MockFeed(8, 1e8, block.timestamp);
        wethFeed = new MockFeed(8, 2000e8, block.timestamp);

        OphisVaultPolicyModule.TokenFeed[] memory tokens =
            new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(sellTokenAddr, IAggregatorV3(address(usdcFeed)), 1 days);
        tokens[1] = OphisVaultPolicyModule.TokenFeed(buyTokenAddr, IAggregatorV3(address(wethFeed)), 1 days);

        module = new OphisVaultPolicyModule(
            OphisVaultPolicyModule.ModuleConfig({
                safe: ISafe(proxy),
                settlement: settlement,
                curator: CURATOR,
                appDataHash: APP_DATA,
                maxSlippageBps: 50,
                maxTtl: 1800,
                dailyUsdTurnoverCap: 1_000_000e18,
                sequencerUptimeFeed: IAggregatorV3(address(0)),
                sequencerGracePeriod: 0,
                tokens: tokens
            })
        );

        // The Safe enables the module (msg.sender == the Safe itself).
        vm.prank(proxy);
        safe.enableModule(address(module));
        assertTrue(safe.isModuleEnabled(address(module)));
    }

    function _forked() internal view returns (bool) {
        return address(settlement) != address(0);
    }

    function _order(address receiver, uint256 buyAmount)
        internal
        view
        returns (GPv2Order.Data memory)
    {
        return GPv2Order.Data({
            sellToken: IERC20(sellTokenAddr),
            buyToken: IERC20(buyTokenAddr),
            receiver: receiver,
            sellAmount: 1000e6, // 1000 USDC
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

    // ---- 1) legit rebalance records the presignature in the REAL settlement --
    function test_fork_legit_rebalance_presigns_in_real_settlement() public {
        if (!_forked()) return;
        // Floor: 1000 USDC / $2000 * 0.995 = 0.4975 WETH.
        GPv2Order.Data memory order = _order(address(safe), 5e17);
        vm.prank(CURATOR);
        bytes memory uid = module.rebalance(order, 0);

        // Real settlement recorded the presignature (owner == the Safe check in
        // the REAL GPv2Signing.setPreSignature passed).
        assertEq(settlement.preSignature(uid), _preSigned());
        // Exact allowance to the REAL vault relayer, never MaxUint.
        assertEq(IERC20(sellTokenAddr).allowance(address(safe), relayer), 1000e6);
    }

    // ---- 2) compromised curator's drain (attacker receiver) is rejected ------
    function test_fork_drain_order_rejected_onchain() public {
        if (!_forked()) return;
        GPv2Order.Data memory drain = _order(ATTACKER, 1); // receiver = attacker
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.ReceiverNotSafe.selector);
        module.rebalance(drain, 0);

        // Nothing was approved or presigned as a side effect.
        assertEq(IERC20(sellTokenAddr).allowance(address(safe), relayer), 0);
    }

    // ---- 3) below-floor drain (receiver == Safe but minOut ~ 0) is rejected --
    function test_fork_below_floor_rejected_onchain() public {
        if (!_forked()) return;
        GPv2Order.Data memory bad = _order(address(safe), 1); // 1 wei WETH << floor
        vm.prank(CURATOR);
        vm.expectRevert(
            abi.encodeWithSelector(OphisVaultPolicyModule.BelowFloor.selector, 1, 4975e14)
        );
        module.rebalance(bad, 0);
        assertEq(IERC20(sellTokenAddr).allowance(address(safe), relayer), 0);
    }

    function _preSigned() internal pure returns (uint256) {
        return uint256(keccak256("GPv2Signing.Scheme.PreSign"));
    }
}
