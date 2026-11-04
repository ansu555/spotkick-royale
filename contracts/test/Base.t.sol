// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpotkickRoyale} from "../src/SpotkickRoyale.sol";
import {SessionRegistry} from "../src/SessionRegistry.sol";
import {ISpotkickRoyale} from "../src/ISpotkickRoyale.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

abstract contract Base is Test {
    SpotkickRoyale internal royale;
    SessionRegistry internal reg;
    MockRandomness internal rng;

    address internal owner = makeAddr("owner");
    uint8 internal constant T0 = 0;
    uint8 internal constant T1 = 1;
    uint128 internal constant V0 = 3 ether;
    uint128 internal constant V1 = 5 ether;

    function setUp() public virtual {
        reg = new SessionRegistry();
        rng = new MockRandomness();
        uint16[48] memory t;
        for (uint256 i = 0; i < 48; ++i) t[i] = 3500;
        royale = new SpotkickRoyale(owner, reg, rng, t);
        rng.setRoyale(address(royale));
        vm.deal(owner, 1000 ether);
        vm.startPrank(owner);
        royale.setTier(T0, V0);
        royale.setTier(T1, V1);
        royale.fundEntropy{value: 50 ether}();
        royale.setMinPlayers(3); // unit tests exercise multi-player lobby rules; solo covered explicitly
        vm.stopPrank();
    }

    function p(uint256 i) internal returns (address a) {
        a = address(uint160(0x10000 + i));
        if (a.balance == 0) vm.deal(a, 10_000 ether);
    }

    function enterAs(uint256 i, uint8 tier) internal returns (uint64 gid, uint8 seat) {
        address a = p(i);
        uint128 v = royale.tierValue(tier);
        vm.prank(a);
        (gid, seat) = royale.enter{value: v}(tier);
    }

    /// @dev n players enter tier; if n < 10 the countdown is waited out and the game started.
    function toPicking(uint256 n, uint8 tier) internal returns (uint64 gid) {
        for (uint256 i = 0; i < n; ++i) {
            (gid,) = enterAs(i, tier);
        }
        if (n < 10) {
            vm.warp(block.timestamp + 15);
            royale.startGame(gid);
        }
    }

    function doPick(uint64 gid, uint256 i, int16 x, int16 y) internal {
        vm.prank(p(i));
        royale.pick(gid, x, y);
    }

    /// @dev lock after the pick window, fulfil with `seed`, return nothing (caller resolves).
    function lockAndSeed(uint64 gid, bytes32 seed) internal {
        ISpotkickRoyale.GameView memory v = royale.getGame(gid);
        if (block.timestamp < v.phaseEndsAt) vm.warp(v.phaseEndsAt);
        royale.lockPicks(gid);
        rng.fulfill(rng.lastId(), seed);
    }

    function playRound(uint64 gid, bytes32 seed) internal {
        lockAndSeed(gid, seed);
        royale.resolveRound(gid);
    }

    function nextRound(uint64 gid) internal {
        ISpotkickRoyale.GameView memory v = royale.getGame(gid);
        vm.warp(v.phaseEndsAt);
        royale.advance(gid);
    }

    function phaseOf(uint64 gid) internal view returns (ISpotkickRoyale.Phase) {
        return royale.getGame(gid).phase;
    }

    function pop(uint16 m) internal pure returns (uint256 c) {
        for (; m != 0; m &= m - 1) ++c;
    }
}
