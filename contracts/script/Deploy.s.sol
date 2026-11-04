// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Script.sol";
import {DeployBase} from "./DeployBase.s.sol";
import {SpotkickRoyale} from "../src/SpotkickRoyale.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {Rain} from "../src/Rain.sol";
import {PythEntropyAdapter} from "../src/adapters/PythEntropyAdapter.sol";
import {ISessionRegistry, IRandomness, ISpotkickRoyale} from "../src/ISpotkickRoyale.sol";

/// @notice Production-style deploy: registry + Pyth adapter + royale + rain.
/// Env: ENTROPY_ADDRESS (required), ENTROPY_PROVIDER (optional, else Entropy's default provider),
///      ENTROPY_CALLBACK_GAS (default 150000), TIERS_WEI (default 3,5,10,25 ether),
///      OWNER (final owner, Safe/timelock; default = deployer; handed over via Ownable2Step so OWNER must call acceptOwnership),
///      RAIN_MIN_WAGER (default 10 ether), ENTROPY_FUND_WEI (value sent to fundEntropy, default 0).
/// Dry run:  forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC
/// Broadcast only after review (see DEPLOY.md).
contract Deploy is DeployBase {
    function run() external {
        address entropy = vm.envAddress("ENTROPY_ADDRESS");
        address provider = vm.envOr("ENTROPY_PROVIDER", address(0));
        uint32 cbGas = uint32(vm.envOr("ENTROPY_CALLBACK_GAS", uint256(150_000)));
        uint256[] memory tiers = _tiers();
        uint128 minWager = uint128(vm.envOr("RAIN_MIN_WAGER", uint256(10 ether)));
        uint256 fundWei = vm.envOr("ENTROPY_FUND_WEI", uint256(0));
        (uint16[48] memory table, bool placeholder) = _saveTable();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address finalOwner = vm.envOr("OWNER", deployer);

        SessionRegistry registry = new SessionRegistry();
        PythEntropyAdapter adapter = new PythEntropyAdapter(entropy, deployer, cbGas);
        if (provider != address(0)) adapter.setProvider(provider);
        SpotkickRoyale royale =
            new SpotkickRoyale(deployer, ISessionRegistry(address(registry)), IRandomness(address(adapter)), table);
        adapter.setRoyale(address(royale));
        Rain rain = new Rain(deployer, ISpotkickRoyale(address(royale)), minWager);

        for (uint256 i; i < tiers.length; ++i) {
            royale.setTier(uint8(i), uint128(tiers[i]));
        }
        if (fundWei != 0) royale.fundEntropy{value: fundWei}();

        if (finalOwner != deployer) {
            royale.transferOwnership(finalOwner);
            adapter.transferOwnership(finalOwner);
            rain.transferOwnership(finalOwner);
        }
        vm.stopBroadcast();

        console2.log("royale     ", address(royale));
        console2.log("sessions   ", address(registry));
        console2.log("rain       ", address(rain));
        console2.log("pythAdapter", address(adapter));
        console2.log("entropy fee (wei) per round:", adapter.fee());
        if (finalOwner != deployer) console2.log("PENDING: OWNER must call acceptOwnership() on royale, adapter, rain:", finalOwner);
        if (placeholder) console2.log("!!! PLACEHOLDER SAVE TABLE DEPLOYED: call setSaveTable() with the calibrated table before real money");
        _writeDeployment(address(royale), address(registry), address(rain), address(adapter), address(adapter), finalOwner, placeholder);
    }
}
