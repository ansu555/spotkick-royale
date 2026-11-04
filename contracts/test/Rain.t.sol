// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {Rain} from "../src/Rain.sol";
import {IRain} from "../src/ISpotkickRoyale.sol";

contract RainAttacker {
    Rain public rain;
    uint64 public id;
    uint256 public reentries;
    bool public attack = true;

    constructor(Rain r) {
        rain = r;
    }

    function join(uint64 rainId) external {
        id = rainId;
        rain.join(rainId);
    }

    function claim() external {
        rain.claim(id);
    }

    receive() external payable {
        if (attack) {
            try rain.claim(id) {} catch {
                ++reentries;
            }
        }
    }
}

contract RainTest is Base {
    Rain internal rain;
    address internal funder = makeAddr("funder");

    function setUp() public override {
        super.setUp();
        rain = new Rain(owner, royale, V0);
        vm.deal(funder, 1000 ether);
    }

    function _eligible(uint256 i) internal {
        enterAs(i, T0); // wagers V0 == minWager
    }

    function _open(uint64 dur, uint256 amt) internal returns (uint64 id) {
        vm.prank(funder);
        id = rain.openRain{value: amt}(dur);
    }

    function test_open_fund_join_settle_claim() public {
        uint64 id = _open(60, 10 ether);
        vm.prank(p(5));
        rain.fund{value: 2 ether}(id);
        for (uint256 i; i < 3; ++i) {
            _eligible(i);
            vm.prank(p(i));
            rain.join(id);
        }
        vm.expectRevert(Rain.RainNotEnded.selector);
        rain.settle(id);
        vm.warp(block.timestamp + 60);
        rain.settle(id);
        uint256 b = p(0).balance;
        vm.prank(p(0));
        rain.claim(id);
        assertEq(p(0).balance - b, 12 ether / 3);
        vm.prank(p(0));
        vm.expectRevert(Rain.AlreadyClaimed.selector);
        rain.claim(id);
        vm.prank(p(9));
        vm.expectRevert(Rain.NotJoined.selector);
        rain.claim(id);
    }

    function test_join_requiresWagered() public {
        uint64 id = _open(60, 1 ether);
        vm.prank(p(0));
        vm.expectRevert(abi.encodeWithSelector(Rain.NotEligible.selector, 0, V0));
        rain.join(id);
        _eligible(0);
        vm.prank(p(0));
        rain.join(id);
        vm.prank(p(0));
        vm.expectRevert(Rain.AlreadyJoined.selector);
        rain.join(id);
    }

    function test_leavingLobbyRemovesEligibility() public {
        uint64 id = _open(60, 1 ether);
        (uint64 g,) = enterAs(0, T0);
        vm.prank(p(0));
        royale.leaveLobby(g);
        vm.prank(p(0));
        vm.expectRevert();
        rain.join(id);
    }

    function test_minWagerSnapshotAtOpen() public {
        uint64 id = _open(60, 1 ether);
        vm.prank(owner);
        rain.setMinWager(100 ether);
        _eligible(0);
        vm.prank(p(0));
        rain.join(id); // still the old threshold
        uint64 id2 = _open(60, 1 ether);
        vm.prank(p(0));
        vm.expectRevert();
        rain.join(id2);
    }

    function test_join_afterEnd_reverts_settleOnce() public {
        uint64 id = _open(60, 1 ether);
        vm.warp(block.timestamp + 60);
        _eligible(0);
        vm.prank(p(0));
        vm.expectRevert(Rain.RainEnded.selector);
        rain.join(id);
        rain.settle(id);
        vm.expectRevert(Rain.AlreadySettled.selector);
        rain.settle(id);
        vm.prank(funder);
        vm.expectRevert(Rain.AlreadySettled.selector);
        rain.fund{value: 1}(id);
    }

    function test_badInputs() public {
        vm.expectRevert(Rain.NoValue.selector);
        rain.openRain(60);
        vm.expectRevert(Rain.BadDuration.selector);
        rain.openRain{value: 1}(5);
        vm.expectRevert(Rain.BadDuration.selector);
        rain.openRain{value: 1}(8 days);
        vm.expectRevert(Rain.UnknownRain.selector);
        rain.join(77);
        vm.expectRevert(Rain.UnknownRain.selector);
        rain.settle(77);
        vm.expectRevert(Rain.UnknownRain.selector);
        rain.fund{value: 1}(77);
        vm.expectRevert(Rain.NotSettled.selector);
        rain.claim(1);
    }

    function test_noJoiners_fundersReclaim() public {
        uint64 id = _open(60, 10 ether);
        vm.prank(p(5));
        rain.fund{value: 2 ether}(id);
        vm.warp(block.timestamp + 60);
        rain.settle(id);
        uint256 b = funder.balance;
        vm.prank(funder);
        rain.reclaim(id);
        assertEq(funder.balance - b, 10 ether);
        vm.prank(p(5));
        rain.reclaim(id);
        assertEq(address(rain).balance, 0);
        vm.prank(funder);
        vm.expectRevert(Rain.NothingToReclaim.selector);
        rain.reclaim(id);
    }

    function test_reclaim_blockedWhenJoined() public {
        uint64 id = _open(60, 10 ether);
        _eligible(0);
        vm.prank(p(0));
        rain.join(id);
        vm.warp(block.timestamp + 60);
        rain.settle(id);
        vm.prank(funder);
        vm.expectRevert(Rain.NothingToReclaim.selector);
        rain.reclaim(id);
    }

    function testFuzz_splitNeverExceedsTotal(uint96 amt, uint8 nRaw) public {
        uint256 n = bound(nRaw, 1, 10);
        amt = uint96(bound(amt, 1, 1_000_000 ether));
        vm.deal(funder, uint256(amt) + 1 ether);
        vm.prank(funder);
        uint64 id = rain.openRain{value: amt}(60);
        for (uint256 i; i < n; ++i) {
            _eligible(i);
            vm.prank(p(i));
            rain.join(id);
        }
        vm.warp(block.timestamp + 60);
        rain.settle(id);
        uint256 paid;
        for (uint256 i; i < n; ++i) {
            uint256 b = p(i).balance;
            vm.prank(p(i));
            rain.claim(id);
            paid += p(i).balance - b;
        }
        assertLe(paid, amt);
        assertLt(uint256(amt) - paid, n); // dust < joined
        assertEq(address(rain).balance, uint256(amt) - paid);
    }

    function test_reentrancyAttacker_claimsOnce() public {
        RainAttacker atk = new RainAttacker(rain);
        vm.deal(address(atk), 10 ether);
        uint64 id = _open(60, 9 ether);
        // attacker needs wager history: enter as contract
        vm.prank(address(atk));
        royale.enter{value: V0}(T0);
        atk.join(id);
        _eligible(1);
        vm.prank(p(1));
        rain.join(id);
        vm.warp(block.timestamp + 60);
        rain.settle(id);
        uint256 b = address(atk).balance;
        atk.claim();
        assertEq(address(atk).balance - b, 4.5 ether, "paid exactly once");
        assertEq(atk.reentries(), 1, "re-entry was attempted and blocked");
        assertEq(address(rain).balance, 4.5 ether, "other joiner's share intact");
    }

    function test_ownable2Step() public {
        address n = makeAddr("n");
        vm.prank(owner);
        rain.transferOwnership(n);
        vm.prank(n);
        rain.acceptOwnership();
        assertEq(rain.owner(), n);
    }
}
