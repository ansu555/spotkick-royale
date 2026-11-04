// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {SpotkickRoyale} from "../src/SpotkickRoyale.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Rain} from "../src/Rain.sol";
import {MockRandomness} from "../test/mocks/MockRandomness.sol";
import {ISessionRegistry, IRandomness, ISpotkickRoyale} from "../src/ISpotkickRoyale.sol";

/// @notice Local/anvil deploy with MockRandomness (the driver fulfils seeds by calling `fulfill`/`fulfillDefault`).
/// Never use on a public network: anyone can fulfil the mock with any seed.
/// anvil &  forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///   --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployLocal is DeployBase {
    function run() external {
        uint256[] memory tiers = _tiers();
        (uint16[48] memory table, bool placeholder) = _saveTable();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        SessionRegistry registry = new SessionRegistry();
        MockRandomness rng = new MockRandomness();
        SpotkickRoyale royale =
            new SpotkickRoyale(deployer, ISessionRegistry(address(registry)), IRandomness(address(rng)), table);
        rng.setRoyale(address(royale));
        Rain rain = new Rain(deployer, ISpotkickRoyale(address(royale)), uint128(vm.envOr("RAIN_MIN_WAGER", uint256(0))));
        for (uint256 i; i < tiers.length; ++i) {
            royale.setTier(uint8(i), uint128(tiers[i]));
        }
        royale.fundEntropy{value: vm.envOr("ENTROPY_FUND_WEI", uint256(1 ether))}();
        vm.stopBroadcast();

        console2.log("royale    ", address(royale));
        console2.log("sessions  ", address(registry));
        console2.log("rain      ", address(rain));
        console2.log("randomness", address(rng));
        _writeDeployment(address(royale), address(registry), address(rain), address(rng), address(0), deployer, placeholder);
    }
}
