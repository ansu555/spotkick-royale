// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {MaliciousWallet} from "./mocks/MaliciousWallet.sol";
import {SpotkickRoyale} from "../src/SpotkickRoyale.sol";
import {ISpotkickRoyale} from "../src/ISpotkickRoyale.sol";

contract ReentrancyTest is Base {
    MaliciousWallet internal w;

    function setUp() public override {
        super.setUp();
        w = new MaliciousWallet();
        vm.deal(address(w), 1000 ether);
    }

    function _wEnter(uint8 tier) internal returns (uint64 gid) {
        bytes memory d = abi.encodeCall(royale.enter, (tier));
        (bool ok, bytes memory ret) = w.exec(address(royale), d, royale.tierValue(tier));
        require(ok, "wallet enter failed");
        (gid,) = abi.decode(ret, (uint64, uint8));
    }

    function _wCall(bytes memory d) internal returns (bool ok) {
        (ok,) = w.exec(address(royale), d, 0);
    }

    function _balSum() internal view returns (uint256) {
        return address(royale).balance;
    }

    // ---------------------------------------------------------------- pull fallback
    function test_rejectingWallet_refundGoesToClaimable_thenWithdraw() public {
        w.setMode(MaliciousWallet.Mode.Reject);
        uint64 g = _wEnter(T0);
        uint256 before_ = address(w).balance;
        vm.expectEmit(true, false, false, true);
        emit ISpotkickRoyale.Claimable(address(w), V0);
        assertTrue(_wCall(abi.encodeCall(royale.leaveLobby, (g))));
        assertEq(address(w).balance, before_, "push failed");
        assertEq(royale.claimable(address(w)), V0);
        // withdraw while still rejecting: reverts, claimable preserved
        assertFalse(_wCall(abi.encodeCall(royale.withdraw, ())));
        assertEq(royale.claimable(address(w)), V0);
        w.setMode(MaliciousWallet.Mode.Accept);
        assertTrue(_wCall(abi.encodeCall(royale.withdraw, ())));
        assertEq(royale.claimable(address(w)), 0);
        assertEq(address(w).balance, before_ + V0);
        assertFalse(_wCall(abi.encodeCall(royale.withdraw, ())), "nothing left");
    }

    function test_burnWallet_cannotBrickResolveOrRefund() public {
        w.setMode(MaliciousWallet.Mode.Burn);
        uint64 g = _wEnter(T0);
        enterAs(1, T0);
        enterAs(2, T0);
        vm.warp(block.timestamp + 15);
        royale.startGame(g);
        vm.warp(block.timestamp + 7 + 600);
        uint256 gasBefore = gasleft();
        royale.refundStalled(g);
        assertLt(gasBefore - gasleft(), 400_000, "30k cap bounds the griefing");
        assertGt(royale.claimable(address(w)), 0);
        assertEq(uint8(phaseOf(g)), uint8(ISpotkickRoyale.Phase.Cancelled));
        // the honest players were paid regardless
        assertEq(p(1).balance, 10_000 ether - V0 + (3 * (V0 - V0 * 400 / 10_000)) / 3);
    }

    // ---------------------------------------------------------------- reentrancy
    function test_reenter_leaveLobby_refundOnce() public {
        uint64 g = _wEnter(T0);
        enterAs(1, T0);
        w.setReenter(address(royale), abi.encodeCall(royale.leaveLobby, (g)));
        uint256 b = address(w).balance;
        assertTrue(_wCall(abi.encodeCall(royale.leaveLobby, (g))));
        uint256 got = (address(w).balance - b) + royale.claimable(address(w));
        assertEq(got, V0, "exactly one refund");
        assertEq(royale.getGame(g).seatsFilled, 1);
        assertEq(royale.getGame(g).pot, V0 - V0 * 400 / 10_000, "other player's stake untouched");
    }

    function test_reenter_cashOut_paidOnce() public {
        // wallet occupies a seat of a 10-player game; find a round where it survives
        uint64 g;
        uint256 idx;
        bool survived;
        for (uint256 a; a < 30 && !survived; ++a) {
            g = _wEnter(T0);
            for (uint256 i = 1; i < 10; ++i) enterAs(i + a * 10, T0);
            playRound(g, keccak256(abi.encode("re", a)));
            (uint8 s,) = royale.seatOf(g, address(w));
            idx = s;
            survived = (royale.getGame(g).aliveMask >> s) & 1 == 1 && phaseOf(g) == ISpotkickRoyale.Phase.Between;
        }
        require(survived, "wallet never survived");
        ISpotkickRoyale.GameView memory v = royale.getGame(g);
        uint256 alive = pop(v.aliveMask);
        uint128 expected = uint128(v.pot / alive);
        w.setReenter(address(royale), abi.encodeCall(royale.cashOut, (g)));
        uint256 b = address(w).balance;
        assertTrue(_wCall(abi.encodeCall(royale.cashOut, (g))));
        uint256 got = (address(w).balance - b) + royale.claimable(address(w));
        assertEq(got, expected, "exactly one cash-out");
        assertEq(royale.getGame(g).pot, v.pot - expected);
        assertEq(pop(royale.getGame(g).aliveMask), alive - 1);
        idx; // silence
    }

    function test_reenter_withdraw_paidOnce() public {
        w.setMode(MaliciousWallet.Mode.Reject);
        uint64 g = _wEnter(T0);
        _wCall(abi.encodeCall(royale.leaveLobby, (g)));
        assertEq(royale.claimable(address(w)), V0);
        w.setReenter(address(royale), abi.encodeCall(royale.withdraw, ()));
        uint256 b = address(w).balance;
        uint256 roy = address(royale).balance;
        assertTrue(_wCall(abi.encodeCall(royale.withdraw, ())));
        assertEq(address(w).balance - b, V0, "paid once");
        assertEq(roy - address(royale).balance, V0, "royale lost exactly V0");
        assertEq(w.reenterAttempts(), 1);
        assertEq(w.reenterSucceeded(), 0, "re-entrant withdraw blocked by the guard");
    }

    function test_reenter_enterAndPick_duringPayout_blocked() public {
        // a payout receiver that tries to call enter() mid-push: guard on the paying function blocks nothing
        // (enter is not guarded) but must not corrupt accounting. Accounting is checked via balances.
        uint64 g = _wEnter(T0);
        enterAs(1, T0);
        w.setReenter(address(royale), abi.encodeCall(royale.enter, (T1)));
        uint256 roy = address(royale).balance;
        assertTrue(_wCall(abi.encodeCall(royale.leaveLobby, (g))));
        // refund V0 left (push or claimable); any re-entrant enter would need value, wallet sends none -> reverts
        uint256 delta = roy - address(royale).balance;
        assertEq(delta + royale.claimable(address(w)), V0);
    }

    function test_winnerContractRejects_prizeClaimable() public {
        w.setMode(MaliciousWallet.Mode.Reject);
        uint64 g;
        for (uint256 a; a < 10; ++a) {
            g = _wEnter(T0);
            enterAs(a * 2 + 1, T0);
            enterAs(a * 2 + 2, T0);
            vm.warp(block.timestamp + 15);
            royale.startGame(g);
            for (uint256 r; r < 5 && phaseOf(g) != ISpotkickRoyale.Phase.Finished; ++r) {
                if (phaseOf(g) == ISpotkickRoyale.Phase.Between) nextRound(g);
                playRound(g, keccak256(abi.encode("win", a, r)));
            }
            if (royale.claimable(address(w)) > 0) break;
        }
        assertGt(royale.claimable(address(w)), 0, "wallet won at least once and was credited");
        assertEq(royale.getGame(g).pot, 0);
    }
}
