// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Shared helpers for Deploy / DeployLocal. Nothing here broadcasts.
abstract contract DeployBase is Script {
    string internal constant SAVE_TABLE_PATH = "../packages/shared/save-table.json";

    /// @dev TIERS_WEI = comma-separated wei values; tier index = position. Default 3,5,10,25 MON (placeholder tiers).
    function _tiers() internal view returns (uint256[] memory t) {
        uint256[] memory def = new uint256[](4);
        def[0] = 3 ether;
        def[1] = 5 ether;
        def[2] = 10 ether;
        def[3] = 25 ether;
        t = vm.envOr("TIERS_WEI", ",", def);
        require(t.length > 0 && t.length <= 255, "TIERS_WEI length");
    }

    /// @dev packages/shared/save-table.json: either a top-level array of 48 bps, or {"saveBps"|"table": [48]}.
    /// Falls back to a flat 3500 bps PLACEHOLDER (loudly flagged) when the file is absent.
    function _saveTable() internal view returns (uint16[48] memory out, bool placeholder) {
        if (!vm.exists(SAVE_TABLE_PATH)) {
            for (uint256 i; i < 48; ++i) out[i] = 3500;
            console2.log("!!! PLACEHOLDER save table (flat 3500 bps): packages/shared/save-table.json not found");
            return (out, true);
        }
        string memory json = vm.readFile(SAVE_TABLE_PATH);
        uint256[] memory a;
        try vm.parseJsonUintArray(json, "$") returns (uint256[] memory r) {
            a = r;
        } catch {
            try vm.parseJsonUintArray(json, ".saveBps") returns (uint256[] memory r2) {
                a = r2;
            } catch {
                a = vm.parseJsonUintArray(json, ".table");
            }
        }
        require(a.length == 48, "save table must have 48 entries");
        for (uint256 i; i < 48; ++i) {
            require(a[i] <= 10_000, "bps > 10000");
            out[i] = uint16(a[i]);
        }
        console2.log("save table loaded from", SAVE_TABLE_PATH);
    }

    function _writeDeployment(
        address royale,
        address registry,
        address rain,
        address randomness,
        address adapter,
        address owner,
        bool placeholderTable
    ) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "royale", royale);
        vm.serializeAddress(k, "sessions", registry);
        vm.serializeAddress(k, "rain", rain);
        vm.serializeAddress(k, "randomness", randomness);
        vm.serializeAddress(k, "pythAdapter", adapter);
        vm.serializeAddress(k, "owner", owner);
        vm.serializeBool(k, "placeholderSaveTable", placeholderTable);
        string memory out = vm.serializeUint(k, "deployBlock", block.number);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
