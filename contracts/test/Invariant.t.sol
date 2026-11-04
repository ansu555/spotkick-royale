// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {RoyaleHandler} from "./mocks/RoyaleHandler.sol";
import {ISpotkickRoyale} from "../src/ISpotkickRoyale.sol";

/// @notice Stateful invariant suite. The fuzzer randomly calls the handler (enter / leaveLobby / pick / pickFor /
/// cashOut / withdraw / startGame / lockPicks / resolveRound / advance / refundStalled / warp / drive) across many
/// actors, warping time; after every call the following invariants must hold.
contract InvariantTest is Base {
    RoyaleHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new RoyaleHandler(royale, rng);
        vm.deal(address(handler), 1_000_000 ether); // funds the actors' entries (value is fronted by the handler)
        targetContract(address(handler));
    }

    function _games() internal view returns (uint64[] memory) {
        return handler.trackedGames();
    }

    /// (a) The royale's on-chain balance must cover every game's pot, all outstanding claimable, and the treasury.
    /// (Exact equality holds; we assert >= because claimable for non-pool addresses is out of scope here.)
    function invariant_balanceAccounting() external view {
        uint256 potSum;
        uint64[] memory games = _games();
        for (uint256 i = 0; i < games.length; ++i) {
            potSum += royale.getGame(games[i]).pot;
        }
        uint256 claimableSum;
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            claimableSum += royale.claimable(handler.actor(i));
        }
        uint256 treasury = royale.treasury();
        assertGe(address(royale).balance, potSum + treasury + claimableSum, "balance covers pot+claimable+treasury");
    }

    /// (b) A Finished game has paid out its entire pot: dust already went to the winner at resolution.
    function invariant_finishedPotZero() external view {
        uint64[] memory games = _games();
        for (uint256 i = 0; i < games.length; ++i) {
            ISpotkickRoyale.GameView memory v = royale.getGame(games[i]);
            if (v.phase == ISpotkickRoyale.Phase.Finished) {
                assertEq(v.pot, 0, "finished game must have zero pot");
            }
        }
    }

    /// (c) No division-by-zero window: while a game is Picking or Between it always has at least one alive seat.
    function invariant_aliveNeverZero() external view {
        uint64[] memory games = _games();
        for (uint256 i = 0; i < games.length; ++i) {
            ISpotkickRoyale.GameView memory v = royale.getGame(games[i]);
            if (v.phase == ISpotkickRoyale.Phase.Picking || v.phase == ISpotkickRoyale.Phase.Between) {
                assertGt(pop(v.aliveMask), 0, "Picking/Between must keep an alive seat");
            }
        }
    }

    /// (d) Liveness: a non-terminal game is never permanently stuck. Each resolved round removes >= ceil(alive/4)
    /// seats, so a 10-seat game survives at most ~6 rounds; the handler's `drive` advances one round per iteration
    /// (lock -> seed -> resolve -> advance), therefore any game the handler keeps driving eventually terminates.
    function invariant_termination() external view {
        uint64[] memory games = _games();
        uint256 finished;
        for (uint256 i = 0; i < games.length; ++i) {
            ISpotkickRoyale.GameView memory v = royale.getGame(games[i]);
            ISpotkickRoyale.Phase ph = v.phase;
            if (ph == ISpotkickRoyale.Phase.Finished) ++finished;
            if (
                ph == ISpotkickRoyale.Phase.Finished || ph == ISpotkickRoyale.Phase.Cancelled
                    || ph == ISpotkickRoyale.Phase.None
            ) {
                continue;
            }
            assertLe(v.round, 12, "non-terminal game has an unbounded round count");
        }
        assertLe(finished, handler.opened(), "ghost opened >= finished");
    }
}