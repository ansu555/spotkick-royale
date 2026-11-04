// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Config} from "./Config.sol";

/// @notice Bit-exact port of the royale resolve maths (docs/INTERFACES.md section 2). Pure, integer-only.
/// Signed `/` in Solidity truncates toward zero, which is what the spec requires for the noise terms.
library RoyaleMath {
    uint256 internal constant BLAST_R2 = Config.BLAST_R_MM * Config.BLAST_R_MM; // 2_250_000
    int256 internal constant NOISE_DIV = 37837;

    /// @dev rand(i) = uint256(keccak256(abi.encode(seed, uint256(i))))
    function rand(bytes32 seed, uint256 i) internal pure returns (uint256 r) {
        assembly ("memory-safe") {
            mstore(0x00, seed)
            mstore(0x20, i)
            r := keccak256(0x00, 0x40)
        }
    }

    /// @notice Auto-pick for an alive seat that has not picked: r = rand(32 + seat).
    function autoPick(bytes32 seed, uint8 seat) internal pure returns (int16 x, int16 y) {
        uint256 r = rand(seed, 32 + uint256(seat));
        x = int16(-3500 + int256(r % 7001));
        y = int16(140 + int256((r >> 128) % 2161));
    }

    /// @dev four 16-bit chunks summed, centred: range +-131070.
    function _irwinHall(uint256 r) private pure returns (int256 s) {
        s = int256(r & 0xFFFF) + int256((r >> 16) & 0xFFFF) + int256((r >> 32) & 0xFFFF) + int256((r >> 48) & 0xFFFF)
            - 131070;
    }

    function popcount(uint16 m) internal pure returns (uint8 c) {
        uint256 v = m;
        while (v != 0) {
            v &= v - 1;
            ++c;
        }
    }

    /// @dev index of the idx-th (0-based, ascending) set bit of mask.
    function nthSeat(uint16 mask, uint256 idx) internal pure returns (uint8) {
        uint256 v = mask;
        for (uint8 s = 0; s < Config.MAX_SEATS; ++s) {
            if ((v >> s) & 1 == 1) {
                if (idx == 0) return s;
                --idx;
            }
        }
        revert("nthSeat");
    }

    function _clamp(int256 v, int256 lo, int256 hi) private pure returns (int256) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    /// @notice Target point for the round. xs/ys are post-auto-pick positions (indexed by seat).
    function target(bytes32 seed, uint16 aliveMask, int16[10] memory xs, int16[10] memory ys)
        internal
        pure
        returns (int16 tX, int16 tY)
    {
        int256 bx;
        int256 by;
        if (rand(seed, 0) % 10000 < 6000) {
            uint8 n = popcount(aliveMask);
            uint8 s = nthSeat(aliveMask, rand(seed, 1) % n);
            bx = xs[s];
            by = ys[s];
        } else {
            bx = -3300 + int256(rand(seed, 2) % 6601);
            by = 250 + int256(rand(seed, 3) % 1901);
        }
        int256 nx = (_irwinHall(rand(seed, 4)) * 350) / NOISE_DIV;
        int256 ny = (_irwinHall(rand(seed, 5)) * 250) / NOISE_DIV;
        tX = int16(_clamp(bx + nx, -Config.TARGET_X_MAX, Config.TARGET_X_MAX));
        tY = int16(_clamp(by + ny, Config.TARGET_Y_MIN, Config.TARGET_Y_MAX));
    }

    /// @notice Floor integer square root.
    function isqrt(uint256 x) internal pure returns (uint256 r) {
        if (x == 0) return 0;
        r = x;
        uint256 y = (x + 1) / 2;
        while (y < r) {
            r = y;
            y = (x / y + y) / 2;
        }
    }

    /// @dev Keys = (d2 << 8) | seat for alive seats, insertion-sorted ascending => (d2, seat) order. Also counts d2 <= R^2.
    function _sortedKeys(uint16 aliveMask, int16[10] memory xs, int16[10] memory ys, int16 tX, int16 tY)
        private
        pure
        returns (uint256[10] memory keys, uint256 inside)
    {
        uint256 cnt;
        for (uint8 s = 0; s < Config.MAX_SEATS; ++s) {
            if ((aliveMask >> s) & 1 == 0) continue;
            int256 dx = int256(xs[s]) - int256(tX);
            int256 dy = int256(ys[s]) - int256(tY);
            uint256 d2 = uint256(dx * dx + dy * dy);
            if (d2 <= BLAST_R2) ++inside;
            uint256 key = (d2 << 8) | s;
            uint256 j = cnt;
            while (j > 0 && keys[j - 1] > key) {
                keys[j] = keys[j - 1];
                --j;
            }
            keys[j] = key;
            ++cnt;
        }
    }

    /// @notice k = clamp(inside, max(1, ceil(n/4)), max(1, min(n-1, floor(3n/4)))).
    function clampK(uint256 n, uint256 inside) internal pure returns (uint256) {
        uint256 lo = (n + 3) / 4;
        if (lo < 1) lo = 1;
        uint256 hi = (3 * n) / 4;
        if (n - 1 < hi) hi = n - 1;
        if (hi < 1) hi = 1;
        return inside < lo ? lo : (inside > hi ? hi : inside);
    }

    /// @notice Blast ranking. `goal` true: the k closest survive; false (saved): the other n-k survive.
    /// @return survivors bitmask of surviving seats; radiusMm display-only radius; k the clamped inside count.
    function blast(uint16 aliveMask, int16[10] memory xs, int16[10] memory ys, int16 tX, int16 tY, bool goal)
        internal
        pure
        returns (uint16 survivors, uint16 radiusMm, uint8 k)
    {
        uint256 n = popcount(aliveMask);
        (uint256[10] memory keys, uint256 inside) = _sortedKeys(aliveMask, xs, ys, tX, tY);
        uint256 kk = clampK(n, inside);
        k = uint8(kk);

        uint256 closeMask;
        for (uint256 i = 0; i < kk; ++i) {
            closeMask |= uint256(1) << (keys[i] & 0xFF);
        }
        survivors = goal ? uint16(closeMask) : uint16(uint256(aliveMask) & ~closeMask);

        if (kk < n) {
            radiusMm = uint16((isqrt(keys[kk - 1] >> 8) + isqrt(keys[kk] >> 8)) / 2);
        } else {
            radiusMm = uint16(isqrt(keys[n - 1] >> 8) + 200);
        }
    }
}
