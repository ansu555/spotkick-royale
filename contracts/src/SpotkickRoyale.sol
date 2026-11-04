// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ISpotkickRoyale, ISessionRegistry, IRandomness} from "./ISpotkickRoyale.sol";
import {Config} from "./libs/Config.sol";
import {RoyaleMath} from "./libs/RoyaleMath.sol";
import {KeeperModel} from "./libs/KeeperModel.sol";

/// @title SpotkickRoyale
/// @notice Real-money, 10-seat penalty royale. Not upgradeable. Owner = intended Safe/timelock.
/// @dev Gas on Monad is charged on the gas LIMIT and a cold SLOAD is ~8100, so per-game state is packed:
///  - `Core` (one slot): ids, phase, round, masks, deadline, entropy request id
///  - `Money` (one slot): entry + pot
///  - picks: uint32 x 10 in uint256[2] (8 per word)
/// Pausable stops ONLY `enter`, `startGame` and the opening of new lobbies. It never blocks an exit
/// (leaveLobby, cashOut, resolveRound, advance, refundStalled, withdraw).
contract SpotkickRoyale is ISpotkickRoyale, Ownable2Step, Pausable, ReentrancyGuardTransient {
    // ------------------------------------------------------------------ types
    struct Core {
        uint64 id;
        uint8 tier;
        Phase phase;
        uint8 round;
        uint8 seatsFilled;
        uint16 aliveMask;
        uint64 phaseEndsAt;
        uint64 requestId;
    }

    struct Money {
        uint128 entry; // gross wei per seat
        uint128 pot; // net of fee, minus cash-outs
    }

    // ------------------------------------------------------------------ errors
    error TierDisabled();
    error WrongValue(uint256 sent, uint256 required);
    error AlreadySeated();
    error NotSeated();
    error NotAlive();
    error NotLobby();
    error NotPicking();
    error NotLocked();
    error NotBetween();
    error PickWindowClosed();
    error BadPick();
    error RepickCap();
    error NotAuthorized();
    error TooEarly();
    error CountdownNotReady();
    error SeedPending();
    error CashOutNotAllowed();
    error NotStalled();
    error NothingToWithdraw();
    error TransferFailed();
    error InsufficientTreasury(uint256 have, uint256 need);
    error NotRandomness();
    error ZeroAddress();
    error BadTable();
    error BadMinPlayers();

    // ------------------------------------------------------------------ admin events
    event TierSet(uint8 indexed tier, uint128 value);
    event SaveTableSet();
    event MinPlayersSet(uint8 minPlayers);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event EntropyFunded(address indexed from, uint256 amount);

    // ------------------------------------------------------------------ storage
    ISessionRegistry public immutable registry;
    IRandomness public immutable randomness;

    // slot: nextGameId + minPlayers + treasury share one word (all touched together in enter)
    uint64 private _nextGameId = 1;
    uint8 public minPlayers = Config.MIN_PLAYERS;
    uint128 public treasury;

    mapping(uint64 => Core) private _core;
    mapping(uint64 => Money) private _money;
    mapping(uint64 => uint256[2]) private _picks;
    mapping(uint64 => address[10]) private _seats;
    mapping(uint64 => mapping(address => uint8)) private _seatOf; // seat + 1
    mapping(uint64 => mapping(uint8 => RoundResult)) private _rounds;
    mapping(uint64 => uint64) private _requestGame;

    mapping(uint8 => uint128) private _tierValue;
    mapping(uint8 => uint64) private _openGame;
    mapping(address => uint128) private _wagered;
    mapping(address => uint128) private _claimable;

    uint256[3] private _saveTable; // 48 x uint16 bps, row-major, row 0 = top

    // ------------------------------------------------------------------ constructor
    constructor(address owner_, ISessionRegistry registry_, IRandomness randomness_, uint16[48] memory saveTable_)
        Ownable(owner_)
    {
        if (address(registry_) == address(0) || address(randomness_) == address(0)) revert ZeroAddress();
        registry = registry_;
        randomness = randomness_;
        _saveTable = KeeperModel.pack(saveTable_);
        emit SaveTableSet();
    }

    // ================================================================== player actions
    /// @inheritdoc ISpotkickRoyale
    function enter(uint8 tier) external payable whenNotPaused returns (uint64 gameId, uint8 seat) {
        uint128 tv = _tierValue[tier];
        if (tv == 0) revert TierDisabled();

        gameId = _openGame[tier];
        Core memory c;
        Money memory m;
        if (gameId == 0) {
            gameId = _nextGameId++;
            _openGame[tier] = gameId;
            c.id = gameId;
            c.tier = tier;
            c.phase = Phase.Lobby;
            m.entry = tv;
            emit GameOpened(gameId, tier, tv);
        } else {
            c = _core[gameId];
            m = _money[gameId];
            // an empty lobby adopts a re-priced tier
            if (c.seatsFilled == 0 && m.entry != tv) m.entry = tv;
        }
        if (msg.value != m.entry) revert WrongValue(msg.value, m.entry);
        if (_seatOf[gameId][msg.sender] != 0) revert AlreadySeated();

        // lowest free seat
        seat = 0;
        while ((c.aliveMask >> seat) & 1 == 1) ++seat;

        uint128 fee = uint128((uint256(m.entry) * Config.FEE_BPS) / 10_000);
        m.pot += m.entry - fee;
        treasury += fee;
        _wagered[msg.sender] += m.entry;

        c.aliveMask |= uint16(1 << seat);
        ++c.seatsFilled;
        _seats[gameId][seat] = msg.sender;
        _seatOf[gameId][msg.sender] = seat + 1;
        emit SeatTaken(gameId, seat, msg.sender);

        if (c.seatsFilled >= minPlayers && c.phaseEndsAt == 0) {
            c.phaseEndsAt = uint64(block.timestamp) + Config.LOBBY_COUNTDOWN_SECS;
            emit LobbyCountdownStarted(gameId, c.phaseEndsAt);
        }

        _money[gameId] = m;
        if (c.seatsFilled == Config.MAX_SEATS) {
            _startGame(c);
        } else {
            _core[gameId] = c;
        }
    }

    /// @inheritdoc ISpotkickRoyale
    function leaveLobby(uint64 gameId) external nonReentrant {
        Core memory c = _core[gameId];
        if (c.phase != Phase.Lobby) revert NotLobby();
        uint8 sp1 = _seatOf[gameId][msg.sender];
        if (sp1 == 0) revert NotSeated();
        uint8 seat = sp1 - 1;

        Money memory m = _money[gameId];
        uint128 fee = uint128((uint256(m.entry) * Config.FEE_BPS) / 10_000);
        m.pot -= m.entry - fee;
        treasury -= fee;
        _wagered[msg.sender] -= m.entry;

        c.aliveMask &= ~uint16(1 << seat);
        --c.seatsFilled;
        if (c.seatsFilled < minPlayers) c.phaseEndsAt = 0;
        delete _seatOf[gameId][msg.sender];
        delete _seats[gameId][seat];
        _money[gameId] = m;
        _core[gameId] = c;
        emit SeatLeft(gameId, seat, msg.sender);

        _pay(msg.sender, m.entry); // full refund incl. fee
    }

    /// @inheritdoc ISpotkickRoyale
    function pick(uint64 gameId, int16 x, int16 y) external {
        _pick(gameId, msg.sender, x, y);
    }

    /// @inheritdoc ISpotkickRoyale
    function pickFor(uint64 gameId, address player, int16 x, int16 y) external {
        if (msg.sender != player && !registry.isAuthorized(player, msg.sender)) revert NotAuthorized();
        _pick(gameId, player, x, y);
    }

    /// @inheritdoc ISpotkickRoyale
    function cashOut(uint64 gameId) external nonReentrant {
        _cashOut(gameId, msg.sender);
    }

    /// @inheritdoc ISpotkickRoyale
    function cashOutFor(uint64 gameId, address player) external nonReentrant {
        if (msg.sender != player && !registry.isAuthorized(player, msg.sender)) revert NotAuthorized();
        _cashOut(gameId, player);
    }

    /// @inheritdoc ISpotkickRoyale
    function withdraw() external nonReentrant {
        uint128 amt = _claimable[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        _claimable[msg.sender] = 0;
        emit Withdrawn(msg.sender, amt);
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }

    // ================================================================== permissionless drivers
    /// @inheritdoc ISpotkickRoyale
    function startGame(uint64 gameId) external whenNotPaused nonReentrant {
        Core memory c = _core[gameId];
        if (c.phase != Phase.Lobby) revert NotLobby();
        if (c.seatsFilled < minPlayers) revert CountdownNotReady();
        if (c.seatsFilled != Config.MAX_SEATS && (c.phaseEndsAt == 0 || block.timestamp < c.phaseEndsAt)) {
            revert CountdownNotReady();
        }
        _startGame(c);
    }

    /// @inheritdoc ISpotkickRoyale
    function lockPicks(uint64 gameId) external nonReentrant {
        Core memory c = _core[gameId];
        if (c.phase != Phase.Picking) revert NotPicking();
        if (block.timestamp < c.phaseEndsAt) revert TooEarly();

        (int16[10] memory xs, int16[10] memory ys, bool[10] memory picked) = _readPicks(gameId, c.aliveMask);
        bytes32 picksHash = keccak256(abi.encode(xs, ys, picked, c.aliveMask));
        bytes32 userRandomness = keccak256(abi.encode(gameId, c.round, picksHash));

        uint256 fee = randomness.fee();
        uint128 t = treasury;
        if (t < fee) revert InsufficientTreasury(t, fee);
        treasury = t - uint128(fee);

        uint64 requestId = randomness.requestSeed{value: fee}(userRandomness);
        c.requestId = requestId;
        c.phase = Phase.Locked;
        c.phaseEndsAt = uint64(block.timestamp) + Config.ENTROPY_TIMEOUT_SECS;
        _core[gameId] = c;
        _requestGame[requestId] = gameId;
        emit RoundLocked(gameId, c.round, picksHash, requestId);
    }

    /// @notice Entropy callback path. Stores the seed ONLY (no heavy compute, never reverts on stale requests).
    function onSeed(uint64 requestId, bytes32 seed) external {
        if (msg.sender != address(randomness)) revert NotRandomness();
        uint64 gameId = _requestGame[requestId];
        if (gameId == 0) return;
        Core memory c = _core[gameId];
        if (c.phase != Phase.Locked || c.requestId != requestId) return;
        RoundResult storage rr = _rounds[gameId][c.round];
        if (rr.seed != bytes32(0)) return;
        rr.seed = seed;
        emit SeedReceived(gameId, c.round, seed);
    }

    /// @inheritdoc ISpotkickRoyale
    function resolveRound(uint64 gameId) external nonReentrant {
        Core memory c = _core[gameId];
        if (c.phase != Phase.Locked) revert NotLocked();
        bytes32 seed = _rounds[gameId][c.round].seed;
        if (seed == bytes32(0)) revert SeedPending();

        RoundResult memory rr = _computeRound(gameId, c, seed);
        _rounds[gameId][c.round] = rr;

        c.aliveMask = rr.survivorMask;
        bool finished = RoyaleMath.popcount(rr.survivorMask) == 1;
        if (finished) {
            c.phase = Phase.Finished;
            c.phaseEndsAt = 0;
        } else {
            c.phase = Phase.Between;
            c.phaseEndsAt = uint64(block.timestamp) + Config.BETWEEN_SECS;
        }
        _core[gameId] = c;
        _emitResolved(gameId, c.round, rr, c.phaseEndsAt);

        if (finished) {
            Money memory m = _money[gameId];
            uint128 prize = m.pot;
            m.pot = 0;
            _money[gameId] = m;
            _announceWinner(gameId, c, prize);
        }
    }

    /// @inheritdoc ISpotkickRoyale
    function advance(uint64 gameId) external {
        Core memory c = _core[gameId];
        if (c.phase != Phase.Between) revert NotBetween();
        if (block.timestamp < c.phaseEndsAt) revert TooEarly();
        ++c.round;
        c.phase = Phase.Picking;
        c.phaseEndsAt = uint64(block.timestamp) + Config.PICK_SECS;
        _core[gameId] = c;
        _picks[gameId][0] = 0;
        _picks[gameId][1] = 0;
        emit RoundStarted(gameId, c.round, c.phaseEndsAt, c.aliveMask);
    }

    /// @inheritdoc ISpotkickRoyale
    function refundStalled(uint64 gameId) external nonReentrant {
        Core memory c = _core[gameId];
        Phase p = c.phase;
        bool stalled;
        if (p == Phase.Picking || p == Phase.Between) {
            stalled = block.timestamp >= uint256(c.phaseEndsAt) + Config.STALL_TIMEOUT_SECS;
        } else if (p == Phase.Locked) {
            if (_rounds[gameId][c.round].seed == bytes32(0)) {
                stalled = block.timestamp >= c.phaseEndsAt; // seed not delivered within ENTROPY_TIMEOUT
            } else {
                stalled = block.timestamp >= uint256(c.phaseEndsAt) + Config.STALL_TIMEOUT_SECS; // nobody resolved
            }
        }
        if (!stalled) revert NotStalled();

        uint8 alive = RoyaleMath.popcount(c.aliveMask);
        Money memory m = _money[gameId];
        uint128 per = m.pot / alive;
        uint128 dust = m.pot - per * alive;
        m.pot = 0;
        if (dust != 0) treasury += dust;
        c.phase = Phase.Cancelled;
        c.phaseEndsAt = 0;
        _money[gameId] = m;
        _core[gameId] = c;
        emit GameCancelled(gameId);
        emit GameRefunded(gameId, per);

        for (uint8 s = 0; s < Config.MAX_SEATS; ++s) {
            if ((c.aliveMask >> s) & 1 == 1) _pay(_seats[gameId][s], per);
        }
    }

    // ================================================================== views
    function getGame(uint64 gameId) external view returns (GameView memory v) {
        Core memory c = _core[gameId];
        Money memory m = _money[gameId];
        v = GameView(c.id, c.tier, c.phase, c.round, c.seatsFilled, c.aliveMask, m.entry, m.pot, c.phaseEndsAt);
    }

    function getSeats(uint64 gameId) external view returns (address[10] memory) {
        return _seats[gameId];
    }

    function getPicks(uint64 gameId)
        external
        view
        returns (int16[10] memory xs, int16[10] memory ys, bool[10] memory picked)
    {
        uint256 w0 = _picks[gameId][0];
        uint256 w1 = _picks[gameId][1];
        for (uint256 s = 0; s < Config.MAX_SEATS; ++s) {
            uint32 e = uint32(((s < 8 ? w0 : w1) >> ((s & 7) * 32)));
            (xs[s], ys[s],, picked[s]) = _decodePick(e);
        }
    }

    function getRound(uint64 gameId, uint8 round) external view returns (RoundResult memory) {
        return _rounds[gameId][round];
    }

    function openGameForTier(uint8 tier) external view returns (uint64) {
        return _openGame[tier];
    }

    function tierValue(uint8 tier) external view returns (uint128) {
        return _tierValue[tier];
    }

    function wagered(address player) external view returns (uint128) {
        return _wagered[player];
    }

    function claimable(address player) external view returns (uint128) {
        return _claimable[player];
    }

    function nextGameId() external view returns (uint64) {
        return _nextGameId;
    }

    function seatOf(uint64 gameId, address player) external view returns (uint8 seat, bool seated) {
        uint8 sp1 = _seatOf[gameId][player];
        return (sp1 == 0 ? 0 : sp1 - 1, sp1 != 0);
    }

    function saveTable() external view returns (uint16[48] memory) {
        return KeeperModel.unpack(_saveTable);
    }

    function entropyRequestGame(uint64 requestId) external view returns (uint64) {
        return _requestGame[requestId];
    }

    // ================================================================== admin (owner = Safe/timelock)
    /// @notice value 0 disables a tier for new entries (existing lobby players may still leave).
    function setTier(uint8 tier, uint128 value) external onlyOwner {
        _tierValue[tier] = value;
        emit TierSet(tier, value);
        if (value != 0 && _openGame[tier] == 0 && !paused()) _openNewGame(tier);
    }

    function setSaveTable(uint16[48] calldata table) external onlyOwner {
        uint16[48] memory t = table;
        _saveTable = KeeperModel.pack(t);
        emit SaveTableSet();
    }

    function setMinPlayers(uint8 n) external onlyOwner {
        if (n < 2 || n > Config.MAX_SEATS) revert BadMinPlayers();
        minPlayers = n;
        emit MinPlayersSet(n);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Top up the treasury that pays Entropy fees.
    function fundEntropy() external payable onlyOwner {
        treasury += uint128(msg.value);
        emit EntropyFunded(msg.sender, msg.value);
    }

    function withdrawTreasury(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint128 t = treasury;
        if (amount > t) revert InsufficientTreasury(t, amount);
        treasury = t - uint128(amount);
        emit TreasuryWithdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ================================================================== internals
    function _openNewGame(uint8 tier) private {
        uint128 tv = _tierValue[tier];
        if (tv == 0) return;
        uint64 id = _nextGameId++;
        _openGame[tier] = id;
        _core[id] = Core(id, tier, Phase.Lobby, 0, 0, 0, 0, 0);
        _money[id] = Money(tv, 0);
        emit GameOpened(id, tier, tv);
    }

    function _startGame(Core memory c) private {
        c.phase = Phase.Picking;
        c.round = 1;
        c.phaseEndsAt = uint64(block.timestamp) + Config.PICK_SECS;
        _core[c.id] = c;
        delete _openGame[c.tier];
        emit GameStarted(c.id, c.seatsFilled, _money[c.id].pot);
        emit RoundStarted(c.id, 1, c.phaseEndsAt, c.aliveMask);
        if (!paused()) _openNewGame(c.tier);
    }

    function _computeRound(uint64 gameId, Core memory c, bytes32 seed) private returns (RoundResult memory rr) {
        (int16[10] memory xs, int16[10] memory ys, bool[10] memory picked) = _readPicks(gameId, c.aliveMask);
        for (uint8 s = 0; s < Config.MAX_SEATS; ++s) {
            if ((c.aliveMask >> s) & 1 == 1 && !picked[s]) {
                (xs[s], ys[s]) = RoyaleMath.autoPick(seed, s);
                emit AutoPicked(gameId, c.round, s, xs[s], ys[s]);
            }
        }
        rr.seed = seed;
        (rr.targetX, rr.targetY) = RoyaleMath.target(seed, c.aliveMask, xs, ys);
        uint256 cell = KeeperModel.cell(rr.targetX, rr.targetY);
        rr.saveBps = KeeperModel.bpsFromWord(_saveTable[cell >> 4], cell);
        bool saved = KeeperModel.isSaved(seed, rr.saveBps);
        rr.outcome = saved ? Outcome.Saved : Outcome.Goal;
        (rr.survivorMask, rr.radiusMm,) = RoyaleMath.blast(c.aliveMask, xs, ys, rr.targetX, rr.targetY, !saved);
    }

    function _emitResolved(uint64 gameId, uint8 round, RoundResult memory rr, uint64 nextPhaseAt) private {
        emit RoundResolved(
            gameId, round, rr.targetX, rr.targetY, rr.outcome, rr.survivorMask, rr.radiusMm, rr.saveBps, nextPhaseAt
        );
    }

    function _pick(uint64 gameId, address player, int16 x, int16 y) private {
        Core memory c = _core[gameId];
        if (c.phase != Phase.Picking) revert NotPicking();
        if (block.timestamp >= c.phaseEndsAt) revert PickWindowClosed();
        if (x < -Config.PICK_X_MAX || x > Config.PICK_X_MAX || y < Config.PICK_Y_MIN || y > Config.PICK_Y_MAX) {
            revert BadPick();
        }
        uint8 sp1 = _seatOf[gameId][player];
        if (sp1 == 0) revert NotSeated();
        uint8 seat = sp1 - 1;
        if ((c.aliveMask >> seat) & 1 == 0) revert NotAlive();

        uint256 word = _picks[gameId][seat >> 3];
        uint256 shift = (seat & 7) * 32;
        (,, uint8 cnt,) = _decodePick(uint32(word >> shift));
        if (cnt >= Config.REPICK_CAP) revert RepickCap();
        ++cnt;
        word = (word & ~(uint256(0xFFFFFFFF) << shift)) | (uint256(_encodePick(x, y, cnt)) << shift);
        _picks[gameId][seat >> 3] = word;
        emit PickPlaced(gameId, c.round, seat, x, y, cnt);
    }

    function _cashOut(uint64 gameId, address player) private {
        Core memory c = _core[gameId];
        if (!(c.phase == Phase.Between || (c.phase == Phase.Picking && c.round >= 2))) revert CashOutNotAllowed();
        uint8 sp1 = _seatOf[gameId][player];
        if (sp1 == 0) revert NotSeated();
        uint8 seat = sp1 - 1;
        if ((c.aliveMask >> seat) & 1 == 0) revert NotAlive();
        uint8 alive = RoyaleMath.popcount(c.aliveMask);
        if (alive < 2) revert CashOutNotAllowed();

        Money memory m = _money[gameId];
        uint128 value = m.pot / alive;
        m.pot -= value;
        c.aliveMask &= ~uint16(1 << seat);

        if (c.phase == Phase.Picking) {
            // drop the leaver's pick so lockPicks/getPicks never see a dead seat
            uint256 shift = (seat & 7) * 32;
            _picks[gameId][seat >> 3] &= ~(uint256(0xFFFFFFFF) << shift);
        }

        bool last = alive == 2; // one seat left: it wins the remaining pot
        uint128 prize;
        if (last) {
            prize = m.pot;
            m.pot = 0;
            c.phase = Phase.Finished;
            c.phaseEndsAt = 0;
        }
        _money[gameId] = m;
        _core[gameId] = c;
        emit CashedOut(gameId, c.round, seat, player, value);

        _pay(player, value);
        if (last) _announceWinner(gameId, c, prize);
    }

    /// @dev c.aliveMask must hold exactly one set bit. State is already final; this only emits and pays.
    function _announceWinner(uint64 gameId, Core memory c, uint128 prize) private {
        uint8 seat = RoyaleMath.nthSeat(c.aliveMask, 0);
        address winner = _seats[gameId][seat];
        emit GameFinished(gameId, seat, winner, prize, c.round);
        _pay(winner, prize);
    }

    /// @dev push with a 30k gas cap; on failure credit `claimable` (pull). Callers update state first (CEI).
    function _pay(address to, uint128 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 30_000}("");
        if (!ok) {
            _claimable[to] += amount;
            emit Claimable(to, amount);
        }
    }

    /// @dev Unpicked / dead seats read as (0,0,false).
    function _readPicks(uint64 gameId, uint16 aliveMask)
        private
        view
        returns (int16[10] memory xs, int16[10] memory ys, bool[10] memory picked)
    {
        uint256 w0 = _picks[gameId][0];
        uint256 w1 = _picks[gameId][1];
        for (uint256 s = 0; s < Config.MAX_SEATS; ++s) {
            if ((aliveMask >> s) & 1 == 0) continue;
            uint32 e = uint32(((s < 8 ? w0 : w1) >> ((s & 7) * 32)));
            (xs[s], ys[s],, picked[s]) = _decodePick(e);
        }
    }

    // pick word layout (uint32): [0..12] x+3500 | [13..24] y | [25..27] count | [28] picked
    function _encodePick(int16 x, int16 y, uint8 cnt) private pure returns (uint32) {
        return uint32(uint256(int256(x) + 3500)) | (uint32(uint16(y)) << 13) | (uint32(cnt) << 25) | (uint32(1) << 28);
    }

    function _decodePick(uint32 e) private pure returns (int16 x, int16 y, uint8 cnt, bool picked) {
        picked = (e >> 28) & 1 == 1;
        if (!picked) return (0, 0, 0, false);
        x = int16(int256(uint256(e & 0x1FFF)) - 3500);
        y = int16(uint16((e >> 13) & 0xFFF));
        cnt = uint8((e >> 25) & 7);
    }
}
