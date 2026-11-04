// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base} from "./Base.t.sol";
import {SpotkickRoyale} from "../src/SpotkickRoyale.sol";
import {ISpotkickRoyale} from "../src/ISpotkickRoyale.sol";
import {RoyaleMath} from "../src/libs/RoyaleMath.sol";
import {KeeperModel} from "../src/libs/KeeperModel.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract SpotkickRoyaleTest is Base {
    function seed(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("seed", i));
    }

    // =============================================================== enter / lobby
    function test_setTier_opensLobby() public view {
        assertEq(royale.openGameForTier(T0), 1);
        assertEq(royale.openGameForTier(T1), 2);
        assertEq(uint8(royale.getGame(1).phase), uint8(ISpotkickRoyale.Phase.Lobby));
        assertEq(royale.getGame(1).entry, V0);
    }

    function test_enter_seatsFeeAndWager() public {
        uint256 t0 = royale.treasury();
        vm.expectEmit(true, false, true, true);
        emit ISpotkickRoyale.SeatTaken(1, 0, p(0));
        (uint64 gid, uint8 seat) = enterAs(0, T0);
        assertEq(gid, 1);
        assertEq(seat, 0);
        ISpotkickRoyale.GameView memory v = royale.getGame(gid);
        assertEq(v.seatsFilled, 1);
        assertEq(v.aliveMask, 1);
        assertEq(v.pot, V0 - V0 * 400 / 10_000);
        assertEq(royale.treasury() - t0, V0 * 400 / 10_000);
        assertEq(royale.wagered(p(0)), V0);
        assertEq(royale.getSeats(gid)[0], p(0));
        (uint8 sOf, bool seated) = royale.seatOf(gid, p(0));
        assertTrue(seated);
        assertEq(sOf, 0);
        (, seat) = enterAs(1, T0);
        assertEq(seat, 1);
    }

    function test_enter_revertsWrongValue() public {
        vm.prank(p(0));
        vm.expectRevert(abi.encodeWithSelector(SpotkickRoyale.WrongValue.selector, V0 - 1, V0));
        royale.enter{value: V0 - 1}(T0);
        vm.prank(p(0));
        vm.expectRevert(abi.encodeWithSelector(SpotkickRoyale.WrongValue.selector, V0 + 1, V0));
        royale.enter{value: V0 + 1}(T0);
    }

    function test_enter_revertsTierDisabled() public {
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.TierDisabled.selector);
        royale.enter{value: 1 ether}(9);
    }

    function test_enter_revertsAlreadySeated() public {
        enterAs(0, T0);
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.AlreadySeated.selector);
        royale.enter{value: V0}(T0);
    }

    function test_enter_samePlayerDifferentTiers() public {
        (uint64 a,) = enterAs(0, T0);
        (uint64 b,) = enterAs(0, T1);
        assertTrue(a != b);
    }

    function test_enter_revertsWhenPaused() public {
        vm.prank(owner);
        royale.pause();
        vm.prank(p(0));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        royale.enter{value: V0}(T0);
    }

    function test_enter_emptyLobbyAdoptsNewPrice() public {
        vm.prank(owner);
        royale.setTier(T0, 4 ether);
        vm.prank(p(0));
        vm.expectRevert(abi.encodeWithSelector(SpotkickRoyale.WrongValue.selector, 3 ether, 4 ether));
        royale.enter{value: 3 ether}(T0);
        vm.prank(p(0));
        royale.enter{value: 4 ether}(T0);
        // lobby with a player keeps its entry even if the tier is re-priced
        vm.prank(owner);
        royale.setTier(T0, 6 ether);
        vm.prank(p(1));
        royale.enter{value: 4 ether}(T0);
    }

    function test_countdown_startsAtMinPlayers() public {
        enterAs(0, T0);
        enterAs(1, T0);
        assertEq(royale.getGame(1).phaseEndsAt, 0);
        vm.expectEmit(true, false, false, true);
        emit ISpotkickRoyale.LobbyCountdownStarted(1, uint64(block.timestamp + 15));
        enterAs(2, T0);
        assertEq(royale.getGame(1).phaseEndsAt, block.timestamp + 15);
        // a later entrant does not extend it
        vm.warp(block.timestamp + 5);
        enterAs(3, T0);
        assertEq(royale.getGame(1).phaseEndsAt, block.timestamp + 10);
    }

    function test_leaveLobby_fullRefundIncludingFee() public {
        enterAs(0, T0);
        enterAs(1, T0);
        uint256 bal = p(0).balance;
        uint256 tre = royale.treasury();
        vm.prank(p(0));
        royale.leaveLobby(1);
        assertEq(p(0).balance - bal, V0, "full refund");
        assertEq(tre - royale.treasury(), V0 * 400 / 10_000, "fee returned");
        assertEq(royale.wagered(p(0)), 0);
        assertEq(royale.getGame(1).seatsFilled, 1);
        assertEq(royale.getGame(1).aliveMask, 2);
        assertEq(royale.getGame(1).pot, V0 - V0 * 400 / 10_000);
        assertEq(royale.getSeats(1)[0], address(0));
        // seat is reusable (lowest free)
        (, uint8 seat) = enterAs(2, T0);
        assertEq(seat, 0);
        // can re-enter
        (, seat) = enterAs(0, T0);
        assertEq(seat, 2);
    }

    function test_leaveLobby_resetsCountdownBelowMin() public {
        for (uint256 i; i < 3; ++i) enterAs(i, T0);
        assertGt(royale.getGame(1).phaseEndsAt, 0);
        vm.prank(p(2));
        royale.leaveLobby(1);
        assertEq(royale.getGame(1).phaseEndsAt, 0);
        vm.warp(block.timestamp + 100);
        vm.expectRevert(SpotkickRoyale.CountdownNotReady.selector);
        royale.startGame(1);
        enterAs(5, T0);
        assertEq(royale.getGame(1).phaseEndsAt, block.timestamp + 15);
    }

    function test_leaveLobby_reverts() public {
        enterAs(0, T0);
        vm.prank(p(9));
        vm.expectRevert(SpotkickRoyale.NotSeated.selector);
        royale.leaveLobby(1);
        uint64 g = toPicking(3, T1);
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.NotLobby.selector);
        royale.leaveLobby(g);
        vm.expectRevert(SpotkickRoyale.NotLobby.selector);
        vm.prank(p(0));
        royale.leaveLobby(999);
    }

    function test_leaveLobby_worksWhilePaused() public {
        enterAs(0, T0);
        vm.prank(owner);
        royale.pause();
        uint256 bal = p(0).balance;
        vm.prank(p(0));
        royale.leaveLobby(1);
        assertEq(p(0).balance - bal, V0);
    }

    function test_emptyAndUnderfilledRoomNeverStarts() public {
        enterAs(0, T0);
        enterAs(1, T0);
        vm.warp(block.timestamp + 10_000);
        vm.expectRevert(SpotkickRoyale.CountdownNotReady.selector);
        royale.startGame(1);
        vm.prank(p(0));
        royale.leaveLobby(1);
        vm.prank(p(1));
        royale.leaveLobby(1);
        assertEq(royale.getGame(1).pot, 0);
        assertEq(royale.wagered(p(0)) + royale.wagered(p(1)), 0);
    }

    function test_startGame_afterCountdown() public {
        for (uint256 i; i < 3; ++i) enterAs(i, T0);
        vm.expectRevert(SpotkickRoyale.CountdownNotReady.selector);
        royale.startGame(1);
        vm.warp(block.timestamp + 15);
        vm.expectEmit(true, false, false, true);
        emit ISpotkickRoyale.GameStarted(1, 3, 3 * (V0 - V0 * 400 / 10_000));
        royale.startGame(1);
        ISpotkickRoyale.GameView memory v = royale.getGame(1);
        assertEq(uint8(v.phase), uint8(ISpotkickRoyale.Phase.Picking));
        assertEq(v.round, 1);
        assertEq(v.aliveMask, 7);
        assertEq(v.phaseEndsAt, block.timestamp + 7);
        // a fresh lobby is opened for the tier
        assertEq(royale.openGameForTier(T0), 3);
        assertEq(uint8(royale.getGame(3).phase), uint8(ISpotkickRoyale.Phase.Lobby));
        vm.expectRevert(SpotkickRoyale.NotLobby.selector);
        royale.startGame(1);
    }

    function test_autoStartAtTenSeats() public {
        uint64 g = toPicking(10, T0);
        assertEq(uint8(phaseOf(g)), uint8(ISpotkickRoyale.Phase.Picking));
        assertEq(royale.getGame(g).aliveMask, 0x3FF);
        assertEq(royale.getGame(g).seatsFilled, 10);
        assertEq(royale.openGameForTier(T0), 3);
    }

    function test_startGame_revertsWhenPaused_noNewLobby() public {
        for (uint256 i; i < 3; ++i) enterAs(i, T0);
        vm.warp(block.timestamp + 15);
        vm.prank(owner);
        royale.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        royale.startGame(1);
        vm.prank(owner);
        royale.unpause();
        royale.startGame(1);
    }

    function test_noNewLobbyWhilePaused_lazyOpenAfterUnpause() public {
        for (uint256 i; i < 10; ++i) enterAs(i, T0); // auto-starts, opens game 3
        assertEq(royale.openGameForTier(T0), 3);
        for (uint256 i; i < 10; ++i) enterAs(i + 20, T0); // starts game 3, opens 4
        vm.prank(owner);
        royale.pause();
        // finish nothing; just check pause blocks reopen path via setTier
        vm.prank(owner);
        royale.setTier(5, 1 ether);
        assertEq(royale.openGameForTier(5), 0);
        vm.prank(owner);
        royale.unpause();
        (uint64 g,) = enterAs(40, 5);
        assertEq(royale.openGameForTier(5), g);
    }

    function test_setMinPlayers() public {
        vm.startPrank(owner);
        royale.setMinPlayers(2);
        vm.stopPrank();
        enterAs(0, T0);
        enterAs(1, T0);
        assertEq(royale.getGame(1).phaseEndsAt, block.timestamp + 15);
        vm.warp(block.timestamp + 15);
        royale.startGame(1);
    }

    // =============================================================== picking
    function test_pick_storesLatestAndCounts() public {
        uint64 g = toPicking(3, T0);
        for (int16 i = 1; i <= 5; ++i) {
            vm.expectEmit(true, false, false, true);
            emit ISpotkickRoyale.PickPlaced(g, 1, 1, i * 100, 500 + i, uint8(uint16(i)));
            doPick(g, 1, i * 100, 500 + i);
        }
        vm.prank(p(1));
        vm.expectRevert(SpotkickRoyale.RepickCap.selector);
        royale.pick(g, 1, 1000);
        (int16[10] memory xs, int16[10] memory ys, bool[10] memory picked) = royale.getPicks(g);
        assertEq(xs[1], 500);
        assertEq(ys[1], 505);
        assertTrue(picked[1]);
        assertFalse(picked[0]);
        assertEq(xs[0], 0);
    }

    function test_pick_boundsAreInclusive() public {
        uint64 g = toPicking(3, T0);
        doPick(g, 0, -3500, 140);
        doPick(g, 0, 3500, 2300);
        (int16[10] memory xs, int16[10] memory ys,) = royale.getPicks(g);
        assertEq(xs[0], 3500);
        assertEq(ys[0], 2300);
        doPick(g, 1, -3500, 2300);
        (xs, ys,) = royale.getPicks(g);
        assertEq(xs[1], -3500);
    }

    function test_pick_revertsBadPick() public {
        uint64 g = toPicking(3, T0);
        int16[2][4] memory bad = [[int16(3501), 1000], [int16(-3501), 1000], [int16(0), 139], [int16(0), 2301]];
        for (uint256 i; i < 4; ++i) {
            vm.prank(p(0));
            vm.expectRevert(SpotkickRoyale.BadPick.selector);
            royale.pick(g, bad[i][0], bad[i][1]);
        }
    }

    function test_pick_revertsWindowClosedWrongPhaseNotSeated() public {
        for (uint256 i; i < 3; ++i) enterAs(i, T0);
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.NotPicking.selector); // lobby
        royale.pick(1, 0, 1000);
        vm.warp(block.timestamp + 15);
        royale.startGame(1);
        vm.prank(p(7));
        vm.expectRevert(SpotkickRoyale.NotSeated.selector);
        royale.pick(1, 0, 1000);
        vm.warp(block.timestamp + 7);
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.PickWindowClosed.selector);
        royale.pick(1, 0, 1000);
    }

    function test_pick_revertsWhenLocked() public {
        uint64 g = toPicking(3, T0);
        vm.warp(block.timestamp + 7);
        royale.lockPicks(g);
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.NotPicking.selector);
        royale.pick(g, 0, 1000);
    }

    function test_pick_deadSeatReverts_andPicksResetEachRound() public {
        uint64 g = toPicking(10, T0);
        for (uint256 i; i < 10; ++i) doPick(g, i, int16(int256(i) * 100), 1000);
        playRound(g, seed(1));
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        assertEq(uint8(v.phase), uint8(ISpotkickRoyale.Phase.Between));
        nextRound(g);
        (,, bool[10] memory picked) = royale.getPicks(g);
        for (uint256 i; i < 10; ++i) assertFalse(picked[i]);
        v = royale.getGame(g);
        for (uint256 i; i < 10; ++i) {
            if ((v.aliveMask >> i) & 1 == 0) {
                vm.prank(p(i));
                vm.expectRevert(SpotkickRoyale.NotAlive.selector);
                royale.pick(g, 0, 1000);
            } else {
                doPick(g, i, 0, 1000); // counter restarted
            }
        }
    }

    // =============================================================== sessions
    function test_pickFor_sessionKey() public {
        uint64 g = toPicking(3, T0);
        address key = makeAddr("key");
        vm.prank(p(0));
        reg.authorize(key, uint64(block.timestamp + 1 hours));
        vm.prank(key);
        royale.pickFor(g, p(0), 123, 456);
        (int16[10] memory xs, int16[10] memory ys, bool[10] memory picked) = royale.getPicks(g);
        assertEq(xs[0], 123);
        assertEq(ys[0], 456);
        assertTrue(picked[0]);
        // key can only act for its player
        vm.prank(key);
        vm.expectRevert(SpotkickRoyale.NotAuthorized.selector);
        royale.pickFor(g, p(1), 1, 1000);
        // player may call pickFor on self
        vm.prank(p(1));
        royale.pickFor(g, p(1), 10, 1000);
    }

    function test_pickFor_expiredAndRevoked() public {
        uint64 g = toPicking(3, T0);
        address key = makeAddr("key");
        vm.prank(p(0));
        reg.authorize(key, uint64(block.timestamp + 3));
        vm.warp(block.timestamp + 4);
        // g's pick window (7s) is still open (started at warp-0... game started at t+0) -> window closes at +7
        vm.prank(key);
        vm.expectRevert(SpotkickRoyale.NotAuthorized.selector);
        royale.pickFor(g, p(0), 1, 1000);
        vm.prank(p(0));
        reg.authorize(key, uint64(block.timestamp + 100));
        vm.prank(key);
        royale.pickFor(g, p(0), 1, 1000);
        vm.prank(p(0));
        reg.revoke(key);
        vm.prank(key);
        vm.expectRevert(SpotkickRoyale.NotAuthorized.selector);
        royale.pickFor(g, p(0), 2, 1000);
    }

    function test_registry_rules() public {
        address key = makeAddr("k");
        vm.startPrank(p(0));
        vm.expectRevert();
        reg.authorize(address(0), uint64(block.timestamp + 10));
        vm.expectRevert();
        reg.authorize(key, uint64(block.timestamp));
        vm.expectRevert();
        reg.authorize(key, uint64(block.timestamp + 8 days));
        reg.authorize(key, uint64(block.timestamp + 10));
        assertTrue(reg.isAuthorized(p(0), key));
        assertFalse(reg.isAuthorized(p(1), key));
        vm.warp(block.timestamp + 10);
        assertFalse(reg.isAuthorized(p(0), key));
        vm.stopPrank();
    }

    // =============================================================== lock / seed / resolve
    function test_lockPicks_revertsEarlyAndWrongPhase() public {
        for (uint256 i; i < 3; ++i) enterAs(i, T0);
        vm.expectRevert(SpotkickRoyale.NotPicking.selector);
        royale.lockPicks(1);
        vm.warp(block.timestamp + 15);
        royale.startGame(1);
        vm.warp(block.timestamp + 6);
        vm.expectRevert(SpotkickRoyale.TooEarly.selector);
        royale.lockPicks(1);
        vm.warp(block.timestamp + 1);
        royale.lockPicks(1);
        vm.expectRevert(SpotkickRoyale.NotPicking.selector);
        royale.lockPicks(1);
    }

    function test_lockPicks_hashAndUserRandomness() public {
        uint64 g = toPicking(4, T0);
        doPick(g, 0, 100, 900);
        doPick(g, 2, -3500, 2300);
        doPick(g, 2, -200, 700); // repick
        vm.warp(block.timestamp + 7);
        int16[10] memory xs;
        int16[10] memory ys;
        bool[10] memory pk;
        (xs[0], ys[0], pk[0]) = (100, 900, true);
        (xs[2], ys[2], pk[2]) = (-200, 700, true);
        bytes32 h = keccak256(abi.encode(xs, ys, pk, uint16(0xF)));
        vm.expectEmit(true, false, false, true);
        emit ISpotkickRoyale.RoundLocked(g, 1, h, 1);
        uint256 tre = royale.treasury();
        royale.lockPicks(g);
        assertEq(tre - royale.treasury(), rng.feeWei(), "entropy fee paid from treasury");
        assertEq(rng.userRand(1), keccak256(abi.encode(uint64(g), uint8(1), h)));
        assertEq(uint8(phaseOf(g)), uint8(ISpotkickRoyale.Phase.Locked));
        assertEq(royale.entropyRequestGame(1), g);
    }

    function test_lockPicks_insufficientTreasury_thenFundEntropy() public {
        uint64 g = toPicking(3, T0);
        uint256 all = royale.treasury();
        vm.prank(owner);
        royale.withdrawTreasury(owner, all);
        vm.warp(block.timestamp + 7);
        vm.expectRevert(abi.encodeWithSelector(SpotkickRoyale.InsufficientTreasury.selector, 0, rng.feeWei()));
        royale.lockPicks(g);
        vm.prank(owner);
        royale.fundEntropy{value: 1 ether}();
        royale.lockPicks(g);
    }

    function test_onSeed_accessAndStaleHandling() public {
        uint64 g = toPicking(3, T0);
        vm.expectRevert(SpotkickRoyale.NotRandomness.selector);
        royale.onSeed(1, seed(1));
        // unknown request: silently ignored
        rng.fulfill(77, seed(1));
        // request for a game not yet Locked is unknown too
        vm.warp(block.timestamp + 7);
        royale.lockPicks(g);
        vm.expectEmit(true, false, false, true);
        emit ISpotkickRoyale.SeedReceived(g, 1, seed(5));
        rng.fulfill(1, seed(5));
        assertEq(royale.getRound(g, 1).seed, seed(5));
        // second delivery cannot overwrite the seed
        rng.fulfill(1, seed(6));
        assertEq(royale.getRound(g, 1).seed, seed(5));
        // callback does NOT advance the phase
        assertEq(uint8(phaseOf(g)), uint8(ISpotkickRoyale.Phase.Locked));
    }

    function test_resolve_revertsPendingAndWrongPhase() public {
        uint64 g = toPicking(3, T0);
        vm.expectRevert(SpotkickRoyale.NotLocked.selector);
        royale.resolveRound(g);
        vm.warp(block.timestamp + 7);
        royale.lockPicks(g);
        vm.expectRevert(SpotkickRoyale.SeedPending.selector);
        royale.resolveRound(g);
        rng.fulfill(1, seed(1));
        royale.resolveRound(g);
        vm.expectRevert(SpotkickRoyale.NotLocked.selector);
        royale.resolveRound(g);
    }

    function test_resolve_matchesMathLibrary_withAutoPicks() public {
        uint64 g = toPicking(10, T0);
        // seats 0..4 pick, 5..9 are auto-picked
        for (uint256 i; i < 5; ++i) doPick(g, i, int16(int256(i) * 300 - 600), int16(int256(1000 + i * 100)));
        bytes32 sd = seed(42);
        lockAndSeed(g, sd);
        vm.recordLogs();
        royale.resolveRound(g);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 autos;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ISpotkickRoyale.AutoPicked.selector) ++autos;
        }
        assertEq(autos, 5, "AutoPicked per unpicked alive seat");

        int16[10] memory xs;
        int16[10] memory ys;
        for (uint8 s; s < 10; ++s) {
            if (s < 5) {
                xs[s] = int16(int256(uint256(s)) * 300 - 600);
                ys[s] = int16(int256(1000 + uint256(s) * 100));
            } else {
                (xs[s], ys[s]) = RoyaleMath.autoPick(sd, s);
            }
        }
        (int16 tx_, int16 ty_) = RoyaleMath.target(sd, 0x3FF, xs, ys);
        uint256 cell = KeeperModel.cell(tx_, ty_);
        bool saved = KeeperModel.isSaved(sd, 3500);
        (uint16 surv, uint16 rad,) = RoyaleMath.blast(0x3FF, xs, ys, tx_, ty_, !saved);
        ISpotkickRoyale.RoundResult memory r = royale.getRound(g, 1);
        assertEq(r.targetX, tx_);
        assertEq(r.targetY, ty_);
        assertEq(uint8(r.outcome), saved ? 2 : 1);
        assertEq(r.survivorMask, surv);
        assertEq(r.radiusMm, rad);
        assertEq(r.saveBps, 3500);
        assertEq(r.seed, sd);
        assertLt(cell, 48);
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        assertEq(v.aliveMask, surv);
        assertEq(uint8(v.phase), uint8(ISpotkickRoyale.Phase.Between));
        assertEq(v.phaseEndsAt, block.timestamp + 9);
        assertGe(pop(surv), 3);
        assertLe(pop(surv), 7);
    }

    function test_resolve_roundResolvedEvent() public {
        uint64 g = toPicking(10, T0);
        lockAndSeed(g, seed(3));
        vm.recordLogs();
        royale.resolveRound(g);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ISpotkickRoyale.RoundResolved.selector) {
                found = true;
                ISpotkickRoyale.RoundResult memory r = royale.getRound(g, 1);
                (, int16 tX, int16 tY, ISpotkickRoyale.Outcome o, uint16 m, uint16 rad, uint16 bps, uint64 nxt) = abi.decode(
                    logs[i].data, (uint8, int16, int16, ISpotkickRoyale.Outcome, uint16, uint16, uint16, uint64)
                );
                assertEq(tX, r.targetX);
                assertEq(tY, r.targetY);
                assertEq(uint8(o), uint8(r.outcome));
                assertEq(m, r.survivorMask);
                assertEq(rad, r.radiusMm);
                assertEq(bps, 3500);
                assertEq(nxt, block.timestamp + 9);
            }
        }
        assertTrue(found);
    }

    function test_fullGame_terminatesAndPaysWinner() public {
        uint64 g = toPicking(10, T0);
        uint128 pot = royale.getGame(g).pot;
        uint256 rounds;
        for (uint256 r = 1; r <= 12; ++r) {
            if (phaseOf(g) == ISpotkickRoyale.Phase.Finished) break;
            playRound(g, seed(r + 100));
            ++rounds;
            if (phaseOf(g) == ISpotkickRoyale.Phase.Between) nextRound(g);
        }
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        assertEq(uint8(v.phase), uint8(ISpotkickRoyale.Phase.Finished));
        assertEq(v.pot, 0);
        assertEq(pop(v.aliveMask), 1);
        assertLe(rounds, 9);
        // winner got the whole pot
        uint8 ws;
        for (uint8 s; s < 10; ++s) {
            if ((v.aliveMask >> s) & 1 == 1) ws = s;
        }
        address w = royale.getSeats(g)[ws];
        assertEq(w.balance, 10_000 ether - V0 + pot);
        // finished game rejects everything
        vm.expectRevert(SpotkickRoyale.NotPicking.selector);
        royale.lockPicks(g);
        vm.expectRevert(SpotkickRoyale.CashOutNotAllowed.selector);
        vm.prank(w);
        royale.cashOut(g);
        vm.expectRevert(SpotkickRoyale.NotStalled.selector);
        royale.refundStalled(g);
    }

    function test_gameFinished_event() public {
        uint64 g = toPicking(3, T0);
        uint128 pot = royale.getGame(g).pot;
        vm.recordLogs();
        for (uint256 r = 1; r <= 4 && phaseOf(g) != ISpotkickRoyale.Phase.Finished; ++r) {
            playRound(g, seed(r + 7));
            if (phaseOf(g) == ISpotkickRoyale.Phase.Between) nextRound(g);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ISpotkickRoyale.GameFinished.selector) {
                found = true;
                (uint8 seat, uint128 prize, uint8 rounds) = abi.decode(logs[i].data, (uint8, uint128, uint8));
                assertEq(prize, pot);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), royale.getSeats(g)[seat]);
                assertGe(rounds, 1);
            }
        }
        assertTrue(found);
    }

    // =============================================================== cash-out
    function test_cashOut_blockedRound1PickingLockedAndSeedKnown() public {
        uint64 g = toPicking(10, T0);
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.CashOutNotAllowed.selector);
        royale.cashOut(g); // Picking, round 1
        vm.warp(block.timestamp + 7);
        royale.lockPicks(g);
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.CashOutNotAllowed.selector);
        royale.cashOut(g); // Locked, seed pending
        rng.fulfill(1, seed(1));
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.CashOutNotAllowed.selector);
        royale.cashOut(g); // Locked, seed public: still blocked
        royale.resolveRound(g);
    }

    function _alivePlayer(uint64 g) internal view returns (uint256 idx) {
        uint16 m = royale.getGame(g).aliveMask;
        for (idx = 0; idx < 10; ++idx) {
            if ((m >> idx) & 1 == 1) return idx;
        }
    }

    function test_cashOut_inBetween_paysPotOverAlive() public {
        uint64 g = toPicking(10, T0);
        playRound(g, seed(1));
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        uint256 alive = pop(v.aliveMask);
        uint256 i = _alivePlayer(g);
        uint256 bal = p(i).balance;
        uint128 expected = uint128(v.pot / alive);
        vm.expectEmit(true, true, false, true);
        emit ISpotkickRoyale.CashedOut(g, 1, uint8(i), p(i), expected);
        vm.prank(p(i));
        royale.cashOut(g);
        assertEq(p(i).balance - bal, expected);
        v = royale.getGame(g);
        assertEq(pop(v.aliveMask), alive - 1);
        assertEq(v.pot, royale.getGame(g).pot);
        // cannot cash twice
        vm.prank(p(i));
        vm.expectRevert(SpotkickRoyale.NotAlive.selector);
        royale.cashOut(g);
    }

    function test_cashOut_inPickingRound2_andClearsPick() public {
        uint64 g = toPicking(10, T0);
        playRound(g, seed(1));
        nextRound(g);
        uint256 i = _alivePlayer(g);
        doPick(g, i, 500, 500);
        vm.prank(p(i));
        royale.cashOut(g);
        (,, bool[10] memory picked) = royale.getPicks(g);
        assertFalse(picked[i], "leaver's pick cleared");
    }

    function test_cashOutFor_paysPlayerNotSessionKey() public {
        uint64 g = toPicking(10, T0);
        playRound(g, seed(1));
        uint256 i = _alivePlayer(g);
        address key = makeAddr("sess");
        vm.deal(key, 0);
        vm.prank(p(i));
        reg.authorize(key, uint64(block.timestamp + 1 hours));
        uint256 bal = p(i).balance;
        vm.prank(key);
        royale.cashOutFor(g, p(i));
        assertGt(p(i).balance, bal);
        assertEq(key.balance, 0, "session key never paid");
        // unauthorised caller
        uint256 j = i + 1;
        while ((royale.getGame(g).aliveMask >> j) & 1 == 0) ++j;
        vm.prank(key);
        vm.expectRevert(SpotkickRoyale.NotAuthorized.selector);
        royale.cashOutFor(g, p(j));
    }

    function test_cashOut_lastTwo_remainingPlayerWins() public {
        // find a 3-player game that has exactly 2 alive after round 1
        uint64 g;
        for (uint256 a = 0; a < 40; ++a) {
            g = toPicking(3, T0);
            playRound(g, seed(a + 500));
            if (phaseOf(g) == ISpotkickRoyale.Phase.Between) break;
        }
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        require(uint8(v.phase) == uint8(ISpotkickRoyale.Phase.Between), "no 2-alive game found");
        assertEq(pop(v.aliveMask), 2);
        uint256 a0 = _alivePlayer(g);
        uint256 a1 = a0 + 1;
        while ((v.aliveMask >> a1) & 1 == 0) ++a1;
        uint256 b0 = p(a0).balance;
        uint256 b1 = p(a1).balance;
        vm.prank(p(a0));
        royale.cashOut(g);
        v = royale.getGame(g);
        assertEq(uint8(v.phase), uint8(ISpotkickRoyale.Phase.Finished));
        assertEq(v.pot, 0);
        assertEq((p(a0).balance - b0) + (p(a1).balance - b1), 3 * (V0 - V0 * 400 / 10_000), "all pot paid out");
    }

    function test_cashOut_worksWhilePaused() public {
        uint64 g = toPicking(10, T0);
        playRound(g, seed(1));
        vm.prank(owner);
        royale.pause();
        uint256 i = _alivePlayer(g);
        vm.prank(p(i));
        royale.cashOut(g);
        // and the game can still be driven to the end
        nextRound(g);
        for (uint256 r; r < 10 && phaseOf(g) != ISpotkickRoyale.Phase.Finished; ++r) {
            if (phaseOf(g) == ISpotkickRoyale.Phase.Between) nextRound(g);
            playRound(g, seed(r + 9));
        }
        assertEq(uint8(phaseOf(g)), uint8(ISpotkickRoyale.Phase.Finished));
    }

    // =============================================================== advance
    function test_advance_rules() public {
        uint64 g = toPicking(10, T0);
        vm.expectRevert(SpotkickRoyale.NotBetween.selector);
        royale.advance(g);
        playRound(g, seed(1));
        vm.expectRevert(SpotkickRoyale.TooEarly.selector);
        royale.advance(g);
        vm.warp(block.timestamp + 9);
        uint16 mask = royale.getGame(g).aliveMask;
        vm.expectEmit(true, false, false, true);
        emit ISpotkickRoyale.RoundStarted(g, 2, uint64(block.timestamp + 7), mask);
        royale.advance(g);
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        assertEq(uint8(v.phase), uint8(ISpotkickRoyale.Phase.Picking));
        assertEq(v.round, 2);
    }

    // =============================================================== refundStalled
    function test_refundStalled_picking() public {
        uint64 g = toPicking(3, T0);
        uint128 pot = royale.getGame(g).pot;
        uint256 deadline = royale.getGame(g).phaseEndsAt;
        vm.warp(deadline + 599);
        vm.expectRevert(SpotkickRoyale.NotStalled.selector);
        royale.refundStalled(g);
        vm.warp(deadline + 600);
        uint256 b0 = p(0).balance;
        vm.expectEmit(true, false, false, true);
        emit ISpotkickRoyale.GameRefunded(g, pot / 3);
        royale.refundStalled(g);
        assertEq(p(0).balance - b0, pot / 3);
        assertEq(p(1).balance, 10_000 ether - V0 + pot / 3);
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        assertEq(uint8(v.phase), uint8(ISpotkickRoyale.Phase.Cancelled));
        assertEq(v.pot, 0);
        vm.expectRevert(SpotkickRoyale.NotStalled.selector);
        royale.refundStalled(g);
    }

    function test_refundStalled_lockedNoSeed_entropyTimeout() public {
        uint64 g = toPicking(4, T0);
        vm.warp(block.timestamp + 7);
        royale.lockPicks(g);
        uint256 lockedAt = block.timestamp;
        vm.warp(lockedAt + 119);
        vm.expectRevert(SpotkickRoyale.NotStalled.selector);
        royale.refundStalled(g);
        vm.warp(lockedAt + 120);
        royale.refundStalled(g);
        assertEq(uint8(phaseOf(g)), uint8(ISpotkickRoyale.Phase.Cancelled));
        // a late seed is ignored and cannot resurrect the game
        rng.fulfill(1, seed(1));
        vm.expectRevert(SpotkickRoyale.NotLocked.selector);
        royale.resolveRound(g);
    }

    function test_refundStalled_lockedWithSeedButNobodyResolves() public {
        uint64 g = toPicking(4, T0);
        lockAndSeed(g, seed(1));
        uint256 lockedAt = block.timestamp;
        vm.warp(lockedAt + 120 + 599);
        vm.expectRevert(SpotkickRoyale.NotStalled.selector);
        royale.refundStalled(g);
        vm.warp(lockedAt + 120 + 600);
        royale.refundStalled(g);
        assertEq(uint8(phaseOf(g)), uint8(ISpotkickRoyale.Phase.Cancelled));
    }

    function test_refundStalled_between_paysAliveOnly() public {
        uint64 g = toPicking(10, T0);
        playRound(g, seed(1));
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        uint256 alive = pop(v.aliveMask);
        uint256 i = _alivePlayer(g);
        uint256 dead = 0;
        while ((v.aliveMask >> dead) & 1 == 1) ++dead;
        uint256 bDead = p(dead).balance;
        uint256 bAlive = p(i).balance;
        vm.warp(v.phaseEndsAt + 600);
        royale.refundStalled(g);
        assertEq(p(dead).balance, bDead);
        assertEq(p(i).balance - bAlive, v.pot / alive);
    }

    function test_refundStalled_notForLobbyOrHealthy() public {
        enterAs(0, T0);
        vm.warp(block.timestamp + 100_000);
        vm.expectRevert(SpotkickRoyale.NotStalled.selector);
        royale.refundStalled(1);
        vm.expectRevert(SpotkickRoyale.NotStalled.selector);
        royale.refundStalled(12345);
    }

    function test_refundStalled_dustGoesToTreasury() public {
        uint64 g = toPicking(10, T0);
        playRound(g, seed(1));
        // cash one out so pot/alive may have a remainder next time
        uint256 i = _alivePlayer(g);
        vm.prank(p(i));
        royale.cashOut(g);
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        uint256 alive = pop(v.aliveMask);
        uint256 tre = royale.treasury();
        vm.warp(v.phaseEndsAt + 600);
        royale.refundStalled(g);
        assertEq(royale.treasury() - tre, v.pot % alive);
        assertEq(royale.getGame(g).pot, 0);
    }

    // =============================================================== withdraw / admin
    function test_withdraw_nothing() public {
        vm.prank(p(0));
        vm.expectRevert(SpotkickRoyale.NothingToWithdraw.selector);
        royale.withdraw();
    }

    function test_admin_onlyOwner() public {
        address x = p(0);
        vm.startPrank(x);
        bytes memory e = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, x);
        vm.expectRevert(e);
        royale.setTier(3, 1 ether);
        uint16[48] memory t;
        vm.expectRevert(e);
        royale.setSaveTable(t);
        vm.expectRevert(e);
        royale.withdrawTreasury(x, 1);
        vm.expectRevert(e);
        royale.fundEntropy{value: 1}();
        vm.expectRevert(e);
        royale.pause();
        vm.expectRevert(e);
        royale.unpause();
        vm.expectRevert(e);
        royale.setMinPlayers(4);
        vm.stopPrank();
    }

    function test_admin_setSaveTable_affectsResolve() public {
        uint16[48] memory t;
        for (uint256 i; i < 48; ++i) t[i] = 10_000; // always saved
        vm.prank(owner);
        royale.setSaveTable(t);
        uint64 g = toPicking(10, T0);
        playRound(g, seed(1));
        ISpotkickRoyale.RoundResult memory r = royale.getRound(g, 1);
        assertEq(uint8(r.outcome), uint8(ISpotkickRoyale.Outcome.Saved));
        assertEq(r.saveBps, 10_000);
        assertEq(royale.saveTable()[47], 10_000);
        t[3] = 10_001;
        vm.prank(owner);
        vm.expectRevert();
        royale.setSaveTable(t);
    }

    function test_admin_withdrawTreasury() public {
        uint256 tre = royale.treasury();
        address to = makeAddr("safe");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpotkickRoyale.InsufficientTreasury.selector, tre, tre + 1));
        royale.withdrawTreasury(to, tre + 1);
        vm.prank(owner);
        vm.expectRevert(SpotkickRoyale.ZeroAddress.selector);
        royale.withdrawTreasury(address(0), 1);
        vm.prank(owner);
        royale.withdrawTreasury(to, 1 ether);
        assertEq(to.balance, 1 ether);
        assertEq(royale.treasury(), tre - 1 ether);
    }

    function test_admin_twoStepOwnership() public {
        address n = makeAddr("newOwner");
        vm.prank(owner);
        royale.transferOwnership(n);
        assertEq(royale.owner(), owner);
        vm.prank(n);
        royale.acceptOwnership();
        assertEq(royale.owner(), n);
    }

    function test_admin_minPlayersBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(SpotkickRoyale.BadMinPlayers.selector);
        royale.setMinPlayers(1);
        vm.expectRevert(SpotkickRoyale.BadMinPlayers.selector);
        royale.setMinPlayers(11);
        vm.stopPrank();
    }

    function test_noPlainEthAccepted() public {
        (bool ok,) = address(royale).call{value: 1}("");
        assertFalse(ok);
    }

    function test_getGame_unknownIsNone() public view {
        assertEq(uint8(royale.getGame(999).phase), uint8(ISpotkickRoyale.Phase.None));
    }
}

