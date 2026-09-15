// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;
import {Script} from "forge-std/Script.sol";
import {OphisHooklessUniswapV4Adapter} from "../../src/contracts/OphisHooklessUniswapV4Adapter.sol";
import {OphisFablesAdapter} from "../../src/contracts/OphisFablesAdapter.sol";

/// @notice Run with FOUNDRY_PROFILE=direct-routes. Dry-run first; broadcasting
/// requires an explicitly supplied signer. Addresses are pinned by both engines.
contract DeployDirectAdapters is Script {
    address constant PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        bytes memory initcode;
        bytes32 salt;
        bytes32 expectedHash;
        address expected;
        if (block.chainid == 130) {
            initcode = abi.encodePacked(
                type(OphisHooklessUniswapV4Adapter).creationCode,
                abi.encode(
                    0x108A678716e5E1776036eF044CAB7064226F714E,
                    0x1F98400000000000000000000000000000000004,
                    0x4200000000000000000000000000000000000006,
                    0x078D782b760474a361dDA0AF3839290b0EF57AD6,
                    uint24(500),
                    int24(10)
                )
            );
            salt = keccak256("ophis.unichain.hookless-v4.v1");
            expectedHash = 0x85e71c0c1fefc982dfaa5a0aaba6417a94e53d63233c6867caed92aa45dc5580;
            expected = 0x4C41eC6850300d2D6Ba65d602fd31eC07F255b2C;
        } else if (block.chainid == 4663) {
            initcode = abi.encodePacked(
                type(OphisFablesAdapter).creationCode,
                abi.encode(
                    0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD,
                    0x8366a39CC670B4001A1121B8F6A443A643e40951,
                    0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
                    0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
                )
            );
            salt = keccak256("ophis.robinhood.fables.v1");
            expectedHash = 0xdfa065d1a6d577ca0cc7b13b09e867d5e0f3385237fe53643fd6060ae37b44b6;
            expected = 0xa0C33928831cB4518b8c4A7BE6c0f98BA8A22de5;
        } else {
            revert("unsupported chain");
        }
        require(keccak256(initcode) == expectedHash, "build differs from reviewed initcode");
        require(vm.computeCreate2Address(salt, expectedHash, PROXY) == expected, "unexpected adapter address");
        require(PROXY.code.length != 0, "CREATE2 proxy absent");
        if (expected.code.length != 0) return;
        vm.startBroadcast();
        (bool ok,) = PROXY.call(bytes.concat(salt, initcode));
        vm.stopBroadcast();
        require(ok && expected.code.length != 0, "adapter deployment failed");
    }
}
