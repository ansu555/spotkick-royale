// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RoyaleMath} from "../src/libs/RoyaleMath.sol";
import {KeeperModel} from "../src/libs/KeeperModel.sol";

contract RoyaleMathTest is Test {
    function test_rand_isKeccakAbiEncode() public pure {
        bytes32 seed = keccak256("s");
        assertEq(RoyaleMath.rand(seed, 7), uint256(keccak256(abi.encode(seed, uint256(7)))));
    }

    function test_isqrt() public pure {
        assertEq(RoyaleMath.isqrt(0), 0);
        assertEq(RoyaleMath.isqrt(1), 1);
        assertEq(RoyaleMath.isqrt(3), 1);
        assertEq(RoyaleMath.isqrt(4), 2);
        assertEq(RoyaleMath.isqrt(2_250_000), 1500);
        assertEq(RoyaleMath.isqrt(2_249_999), 1499);
    }

    function testFuzz_isqrt(uint128 x) public pure {
        uint256 r = RoyaleMath.isqrt(x);
        assertLe(r * r, x);
        assertGt((r + 1) * (r + 1), x);
    }

    function test_noiseTruncatesTowardZero() public pure {
        // signed division must truncate toward zero: -1 * 350 / 37837 == 0 (not -1)
        int256 s = -1;
        assertEq((s * 350) / 37837, 0);
        s = -108;
        assertEq((s * 350) / 37837, 0); // -37800/37837 -> 0
        s = -109;
        assertEq((s * 350) / 37837, -1);
    }

    function test_cellMapping() public pure {
        assertEq(KeeperModel.cell(-3300, 2150), 0 * 12 + 0); // top-left: col (360*12)/7320=0, row (290*4)/2440=0
        assertEq(KeeperModel.cell(3300, 250), 3 * 12 + 11); // bottom-right
    }

    function test_cellMapping_row() public pure {
        // y=1200 -> (2440-1200)*4/2440 = 2
        assertEq(KeeperModel.cell(0, 1200), 2 * 12 + 6);
    }

    function testFuzz_cellInRange(int16 x, int16 y) public pure {
        assertLt(KeeperModel.cell(x, y), 48);
    }

    function test_packUnpack() public pure {
        uint16[48] memory t;
        for (uint256 i = 0; i < 48; ++i) t[i] = uint16(i * 200 + 1);
        uint16[48] memory u = KeeperModel.unpack(KeeperModel.pack(t));
        for (uint256 i = 0; i < 48; ++i) assertEq(u[i], t[i]);
    }

    function test_clampK() public pure {
        // n=10: lo=3 hi=7
        assertEq(RoyaleMath.clampK(10, 0), 3);
        assertEq(RoyaleMath.clampK(10, 5), 5);
        assertEq(RoyaleMath.clampK(10, 10), 7);
        // n=2: lo=hi=1
        assertEq(RoyaleMath.clampK(2, 0), 1);
        assertEq(RoyaleMath.clampK(2, 2), 1);
        // n=3: 1..2 ; n=5: 2..3
        assertEq(RoyaleMath.clampK(3, 3), 2);
        assertEq(RoyaleMath.clampK(5, 0), 2);
        assertEq(RoyaleMath.clampK(5, 5), 3);
    }

    function test_blast_tieBreakBySeat() public pure {
        // all picks identical -> equal d2 -> seats ordered ascending; goal keeps lowest k seats
        int16[10] memory xs;
        int16[10] memory ys;
        uint16 mask = 0x3FF;
        for (uint256 i = 0; i < 10; ++i) {
            xs[i] = 100;
            ys[i] = 500;
        }
        (uint16 surv,, uint8 k) = RoyaleMath.blast(mask, xs, ys, 100, 500, true);
        assertEq(k, 7); // inside=10 -> clamp hi=7
        assertEq(surv, 0x7F); // seats 0..6
        (surv,,) = RoyaleMath.blast(mask, xs, ys, 100, 500, false);
        assertEq(surv, 0x380); // the other 3: seats 7,8,9
    }

    function test_blast_radius() public pure {
        int16[10] memory xs;
        int16[10] memory ys;
        // 4 alive seats {0,3,5,9} at distances 100, 200, 3000, 4000 along x from target (0,1000)
        xs[0] = 100;
        xs[3] = 200;
        xs[5] = 3000;
        xs[9] = 3500;
        ys[0] = 1000;
        ys[3] = 1000;
        ys[5] = 1000;
        ys[9] = 1000;
        uint16 mask = (1 << 0) | (1 << 3) | (1 << 5) | (1 << 9);
        (uint16 surv, uint16 rad, uint8 k) = RoyaleMath.blast(mask, xs, ys, 0, 1000, true);
        assertEq(k, 2); // inside=2, lo=1, hi=3
        assertEq(surv, (1 << 0) | (1 << 3));
        assertEq(rad, (200 + 3000) / 2);
        (surv,,) = RoyaleMath.blast(mask, xs, ys, 0, 1000, false);
        assertEq(surv, (1 << 5) | (1 << 9));
    }

    // ------------------------------------------------------------- fuzz
    function _mkPicks(uint256 salt, uint16 mask)
        internal
        pure
        returns (int16[10] memory xs, int16[10] memory ys)
    {
        for (uint8 s = 0; s < 10; ++s) {
            if ((mask >> s) & 1 == 0) continue;
            uint256 r = uint256(keccak256(abi.encode(salt, s)));
            xs[s] = int16(-3500 + int256(r % 7001));
            ys[s] = int16(140 + int256((r >> 128) % 2161));
        }
    }

    function testFuzz_blast_survivorsInRange(bytes32 seed, uint16 rawMask, int16 tX, int16 tY, bool goal) public pure {
        uint16 mask = rawMask & 0x3FF;
        uint256 n = RoyaleMath.popcount(mask);
        vm.assume(n >= 2);
        tX = int16(bound(int256(tX), -3300, 3300));
        tY = int16(bound(int256(tY), 250, 2150));
        (int16[10] memory xs, int16[10] memory ys) = _mkPicks(uint256(seed), mask);
        (uint16 surv, uint16 rad, uint8 k) = RoyaleMath.blast(mask, xs, ys, tX, tY, goal);
        uint256 sc = RoyaleMath.popcount(surv);
        assertGe(sc, 1);
        assertLe(sc, n - 1);
        assertEq(uint256(surv) & ~uint256(mask), 0, "survivors subset of alive");
        assertEq(sc, goal ? k : n - k);
        assertLe(rad, 8000);
    }

    function testFuzz_fullDerivation(bytes32 seed, uint16 rawMask, uint16 pickedBits, uint256 salt) public pure {
        uint16 mask = rawMask & 0x3FF;
        uint256 n = RoyaleMath.popcount(mask);
        vm.assume(n >= 2);
        (int16[10] memory xs, int16[10] memory ys) = _mkPicks(salt, mask);
        for (uint8 s = 0; s < 10; ++s) {
            if ((mask >> s) & 1 == 1 && (pickedBits >> s) & 1 == 0) (xs[s], ys[s]) = RoyaleMath.autoPick(seed, s);
        }
        (int16 tX, int16 tY) = RoyaleMath.target(seed, mask, xs, ys);
        assertGe(tX, -3300);
        assertLe(tX, 3300);
        assertGe(tY, 250);
        assertLe(tY, 2150);
        uint256 cell = KeeperModel.cell(tX, tY);
        assertLt(cell, 48);
        bool saved = RoyaleMath.rand(seed, 6) % 10000 < 3500;
        (uint16 surv,,) = RoyaleMath.blast(mask, xs, ys, tX, tY, !saved);
        uint256 sc = RoyaleMath.popcount(surv);
        assertGe(sc, 1);
        assertLe(sc, n - 1);
        assertEq(uint256(surv) & ~uint256(mask), 0);
    }

    function testFuzz_autoPickInBounds(bytes32 seed, uint8 seat) public pure {
        seat = seat % 10;
        (int16 x, int16 y) = RoyaleMath.autoPick(seed, seat);
        assertGe(x, -3500);
        assertLe(x, 3500);
        assertGe(y, 140);
        assertLe(y, 2300);
    }

    function testFuzz_blastNoOverflowExtremes(bytes32 seed, int16 tX, int16 tY, int16 ax, int16 ay) public pure {
        // even wild (out-of-range) coordinates must not overflow
        int16[10] memory xs;
        int16[10] memory ys;
        for (uint8 s = 0; s < 10; ++s) {
            xs[s] = s % 2 == 0 ? ax : int16(-int32(ax) / 2);
            ys[s] = s % 3 == 0 ? ay : int16(-int32(ay) / 3);
        }
        (uint16 surv,,) = RoyaleMath.blast(0x3FF, xs, ys, tX, tY, uint256(seed) % 2 == 0);
        assertGe(RoyaleMath.popcount(surv), 1);
        assertLe(RoyaleMath.popcount(surv), 9);
    }
}
