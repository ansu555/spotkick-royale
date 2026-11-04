// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SpotkickRoyale} from "../../src/SpotkickRoyale.sol";
import {MockRandomness} from "./MockRandomness.sol";
import {ISpotkickRoyale} from "../../src/ISpotkickRoyale.sol";

/// @notice Invariant-test handler. The invariant runner calls its external functions with random arguments;
/// each maps those onto real royale actions across a fixed pool of actors, warping time to make progress.
///
/// Ghost counter `opened` counts every distinct game id the handler has touched. Liveness is enforced by
/// round-boundedness (see InvariantTest.invariant_termination): a round kills >= ceil(alive/4) seats, so a
/// 10-seat game can survive at most ~6 rounds, and `drive` advances a full round every iteration — hence every
/// driven game terminates.
contract RoyaleHandler {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    SpotkickRoyale internal immutable royale;
    MockRandomness internal immutable rng;

    address[20] internal actors;
    uint64[] public gameIds;
    mapping(uint64 => bool) public tracked;
    uint256 public opened; // ghost: distinct games opened

    constructor(SpotkickRoyale royale_, MockRandomness rng_) {
        royale = royale_;
        rng = rng_;
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = address(uint160(uint256(0xA1000) + i));
        }
    }

    // ------------------------------------------------------------ views for invariants
    function actorCount() external pure returns (uint256) {
        return 20;
    }

    function trackedGames() external view returns (uint64[] memory) {
        return gameIds;
    }

    function actor(uint256 i) external view returns (address) {
        return actors[i % 20];
    }

    // ------------------------------------------------------------ helpers
    function _track(uint64 gid) internal {
        if (gid == 0 || tracked[gid]) return;
        tracked[gid] = true;
        gameIds.push(gid);
        ++opened;
    }

    function _game(uint256 idx) internal view returns (uint64) {
        uint256 n = gameIds.length;
        if (n == 0) return 0;
        return gameIds[idx % n];
    }

    /// @dev map an arbitrary int to [lo, lo+span-1] deterministically.
    function _coord(int256 v, int256 lo, int256 span) internal pure returns (int16) {
        v %= span;
        if (v < 0) v += span;
        return int16(lo + v);
    }

    // ------------------------------------------------------------ player actions
    function enter(uint256 actorIdx, uint8 tier) external {
        uint8 t = tier % 2;
        uint128 tv = royale.tierValue(t);
        if (tv == 0) return;
        address a = actors[actorIdx % 20];
        vm.prank(a);
        try royale.enter{value: tv}(t) returns (uint64 gid, uint8) {
            _track(gid);
        } catch {}
    }

    function leaveLobby(uint256 actorIdx, uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        vm.prank(actors[actorIdx % 20]);
        try royale.leaveLobby(g) {} catch {}
    }

    function pick(uint256 actorIdx, uint256 gameIdx, int256 x, int256 y) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        vm.prank(actors[actorIdx % 20]);
        try royale.pick(g, _coord(x, -3500, 7001), _coord(y, 140, 2161)) {} catch {}
    }

    function pickFor(uint256 actorIdx, uint256 gameIdx, int256 x, int256 y) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        address a = actors[actorIdx % 20];
        vm.prank(a);
        // player acting for self exercises the pickFor authorisation branch
        try royale.pickFor(g, a, _coord(x, -3500, 7001), _coord(y, 140, 2161)) {} catch {}
    }

    function cashOut(uint256 actorIdx, uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        vm.prank(actors[actorIdx % 20]);
        try royale.cashOut(g) {} catch {}
    }

    function withdraw(uint256 actorIdx) external {
        vm.prank(actors[actorIdx % 20]);
        try royale.withdraw() {} catch {}
    }

    // ------------------------------------------------------------ permissionless drivers
    function startGame(uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        try royale.startGame(g) {} catch {}
    }

    function lockPicks(uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        try royale.lockPicks(g) {
            rng.fulfillDefault(rng.lastId());
        } catch {}
    }

    function resolveRound(uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        try royale.resolveRound(g) {} catch {}
    }

    function advance(uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        try royale.advance(g) {} catch {}
    }

    function refundStalled(uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        try royale.refundStalled(g) {} catch {}
    }

    /// @dev jump time to the game's current phase deadline (if any) so drivers become legal.
    function warpToDeadline(uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        uint64 d = royale.getGame(g).phaseEndsAt;
        if (d == 0 || block.timestamp >= d) return;
        vm.warp(d);
    }

    /// @dev drive a single game forward, resolving/advancing a bounded number of steps so that a
    /// non-terminal game always makes progress (and a live game eventually reaches Finished).
    function drive(uint256 gameIdx) external {
        uint64 g = _game(gameIdx);
        if (g == 0) return;
        for (uint256 i = 0; i < 40; ++i) {
            ISpotkickRoyale.GameView memory v = royale.getGame(g);
            ISpotkickRoyale.Phase ph = v.phase;
            if (ph == ISpotkickRoyale.Phase.None) return;
            if (ph == ISpotkickRoyale.Phase.Finished || ph == ISpotkickRoyale.Phase.Cancelled) return;

            if (ph == ISpotkickRoyale.Phase.Lobby) {
                if (v.phaseEndsAt == 0) return; // waiting for minimum players; not stuck, players can leave
                vm.warp(v.phaseEndsAt);
                try royale.startGame(g) {} catch {
                    return;
                }
                continue;
            }
            if (ph == ISpotkickRoyale.Phase.Picking) {
                vm.warp(v.phaseEndsAt);
                try royale.lockPicks(g) {} catch {
                    return;
                }
                rng.fulfillDefault(rng.lastId());
                continue; // -> Locked with a delivered seed
            }
            if (ph == ISpotkickRoyale.Phase.Locked) {
                try royale.resolveRound(g) {} catch {
                    return;
                }
                continue; // -> Between or Finished
            }
            if (ph == ISpotkickRoyale.Phase.Between) {
                vm.warp(v.phaseEndsAt);
                try royale.advance(g) {} catch {
                    return;
                }
                continue; // -> Picking (next round)
            }
            return;
        }
    }
}