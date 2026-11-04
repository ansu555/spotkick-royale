// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Config} from "./Config.sol";
import {RoyaleMath} from "./RoyaleMath.sol";

/// @notice Table-driven keeper model: target cell -> save probability (bps), then a seeded roll.
/// The 12x4 table (row 0 = top) is stored packed, 16 x uint16 per word, in 3 words.
library KeeperModel {
    function cell(int256 x, int256 y) internal pure returns (uint256) {
        int256 col = ((x + 3660) * 12) / 7320;
        int256 row = ((2440 - y) * 4) / 2440;
        if (col < 0) col = 0;
        if (col > 11) col = 11;
        if (row < 0) row = 0;
        if (row > 3) row = 3;
        return uint256(row * 12 + col);
    }

    /// @dev Saved iff rand(6) % 10000 < saveBps.
    function isSaved(bytes32 seed, uint16 saveBps) internal pure returns (bool) {
        return RoyaleMath.rand(seed, 6) % 10000 < saveBps;
    }

    function bpsFromWord(uint256 word, uint256 cellIdx) internal pure returns (uint16) {
        return uint16(word >> ((cellIdx & 15) * 16));
    }

    function pack(uint16[48] memory table) internal pure returns (uint256[3] memory w) {
        for (uint256 i = 0; i < Config.SAVE_CELLS; ++i) {
            require(table[i] <= 10000, "bps>10000");
            w[i >> 4] |= uint256(table[i]) << ((i & 15) * 16);
        }
    }

    function unpack(uint256[3] memory w) internal pure returns (uint16[48] memory t) {
        for (uint256 i = 0; i < Config.SAVE_CELLS; ++i) {
            t[i] = bpsFromWord(w[i >> 4], i);
        }
    }

    /// @notice Full outcome from an in-memory table (used by tests / off-chain parity).
    function outcome(bytes32 seed, int256 x, int256 y, uint16[48] memory table)
        internal
        pure
        returns (bool saved, uint16 saveBps)
    {
        saveBps = table[cell(x, y)];
        saved = isSaved(seed, saveBps);
    }
}
