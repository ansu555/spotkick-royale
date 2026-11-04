// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RoyaleMath} from "../src/libs/RoyaleMath.sol";
import {KeeperModel} from "../src/libs/KeeperModel.sol";

/// @notice Differential tests. `test/vectors/golden.json` is produced by an independent pure-Python implementation of
/// docs/INTERFACES.md section 2 (own keccak). If `../packages/shared/vectors/derivation.json` exists it is checked as well.
contract GoldenTest is Test {
    function _picksOf(string memory json, string memory k, bytes32 seed, uint16 mask)
        internal
        pure
        returns (int16[10] memory xs, int16[10] memory ys)
    {
        int256[] memory px = vm.parseJsonIntArray(json, string.concat(k, ".px"));
        int256[] memory py = vm.parseJsonIntArray(json, string.concat(k, ".py"));
        uint256[] memory pk = vm.parseJsonUintArray(json, string.concat(k, ".picked"));
        for (uint8 s = 0; s < 10; ++s) {
            if ((mask >> s) & 1 == 0) continue;
            if (pk[s] == 1) {
                xs[s] = int16(px[s]);
                ys[s] = int16(py[s]);
            } else {
                (xs[s], ys[s]) = RoyaleMath.autoPick(seed, s);
                int256[] memory a = vm.parseJsonIntArray(json, string.concat(k, ".autos.", vm.toString(uint256(s))));
                assertEq(int256(xs[s]), a[0], "autoX");
                assertEq(int256(ys[s]), a[1], "autoY");
            }
        }
    }

    struct Case {
        string json;
        string k;
        bytes32 seed;
        uint16 mask;
        int16[10] xs;
        int16[10] ys;
    }

    function _num(Case memory c, string memory f) internal pure returns (uint256) {
        return vm.parseJsonUint(c.json, string.concat(c.k, f));
    }

    function _verify(Case memory c, uint16[48] memory table) internal pure {
        (int16 tX, int16 tY) = RoyaleMath.target(c.seed, c.mask, c.xs, c.ys);
        assertEq(int256(tX), vm.parseJsonInt(c.json, string.concat(c.k, ".targetX")), "targetX");
        assertEq(int256(tY), vm.parseJsonInt(c.json, string.concat(c.k, ".targetY")), "targetY");
        (bool saved, uint16 bps) = KeeperModel.outcome(c.seed, tX, tY, table);
        assertEq(uint256(bps), _num(c, ".saveBps"), "saveBps");
        assertEq(saved ? 1 : 0, _num(c, ".saved"), "saved");
        (uint16 surv, uint16 rad,) = RoyaleMath.blast(c.mask, c.xs, c.ys, tX, tY, !saved);
        assertEq(uint256(surv), _num(c, ".survivorMask"), "survivors");
        assertEq(uint256(rad), _num(c, ".radiusMm"), "radius");
    }

    /// Checks every vector under "$.vectors[i]" against Solidity.
    function _check(string memory json, uint256 count, uint16[48] memory table) internal pure {
        for (uint256 i = 0; i < count; ++i) {
            Case memory c;
            c.json = json;
            c.k = string.concat("$.vectors[", vm.toString(i), "]");
            c.seed = vm.parseJsonBytes32(json, string.concat(c.k, ".seed"));
            c.mask = uint16(_num(c, ".aliveMask"));
            (c.xs, c.ys) = _picksOf(json, c.k, c.seed, c.mask);
            _verify(c, table);
        }
    }

    function _table(string memory json) internal pure returns (uint16[48] memory t) {
        uint256[] memory a = vm.parseJsonUintArray(json, "$.saveTable");
        for (uint256 i = 0; i < 48; ++i) t[i] = uint16(a[i]);
    }

    function test_golden_pythonReference() public view {
        string memory json = vm.readFile("test/vectors/golden.json");
        _check(json, 40, _table(json));
    }

    /// Cross-worker vectors (packages/shared). Same schema as golden.json; skipped until the file exists.
    function test_golden_sharedDerivation() public view {
        // converted from packages/shared/vectors/derivation.json by test/vectors/convert_shared.py
        string memory path = "test/vectors/shared.json";
        if (!vm.exists(path)) {
            console2_skip();
            return;
        }
        string memory json = vm.readFile(path);
        uint256 count;
        for (;; ++count) {
            try vm.parseJsonString(json, string.concat("$.vectors[", vm.toString(count), "].seed")) returns (string memory) {}
            catch {
                break;
            }
        }
        assertGt(count, 0, "no vectors in derivation.json");
        _check(json, count, _table(json));
    }

    function console2_skip() internal pure {}
}
