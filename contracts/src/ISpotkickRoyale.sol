// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice SINGLE SOURCE OF TRUTH for the on-chain API. Contracts, server (viem ABI) and client all
/// build against this file. Do not change signatures without updating docs/INTERFACES.md and telling the orchestrator.
/// Units: positions are integer millimetres. x in [-3500,3500] (0 = goal centre), y in [140,2300] (0 = ground).
interface ISpotkickRoyale {
    enum Phase { None, Lobby, Picking, Locked, Resolved, Between, Finished, Cancelled }
    enum Outcome { None, Goal, Saved }

    struct GameView {
        uint64 id;
        uint8 tier;
        Phase phase;
        uint8 round;          // 0 in lobby, 1-based afterwards
        uint8 seatsFilled;
        uint16 aliveMask;     // bit i = seat i alive (lobby: bit i = seat taken)
        uint128 entry;        // wei per seat (gross)
        uint128 pot;          // wei currently in the pot (net of fee, minus cash-outs)
        uint64 phaseEndsAt;   // unix seconds of the deadline that ends the current phase; 0 if none
    }

    struct RoundResult {
        bytes32 seed;
        int16 targetX;
        int16 targetY;
        Outcome outcome;
        uint16 survivorMask;
        uint16 radiusMm;
        uint16 saveBps;
    }

    // ---- player actions ----
    function enter(uint8 tier) external payable returns (uint64 gameId, uint8 seat);
    function leaveLobby(uint64 gameId) external;
    function pick(uint64 gameId, int16 x, int16 y) external;
    function pickFor(uint64 gameId, address player, int16 x, int16 y) external;   // session key
    function cashOut(uint64 gameId) external;
    function cashOutFor(uint64 gameId, address player) external;                  // session key; pays `player`
    function withdraw() external;                                                  // pull fallback

    // ---- permissionless drivers (anyone may call; state-gated) ----
    function startGame(uint64 gameId) external;
    function lockPicks(uint64 gameId) external;
    function resolveRound(uint64 gameId) external;
    function advance(uint64 gameId) external;
    function refundStalled(uint64 gameId) external;

    // ---- views ----
    function getGame(uint64 gameId) external view returns (GameView memory);
    function getSeats(uint64 gameId) external view returns (address[10] memory);
    function getPicks(uint64 gameId) external view returns (int16[10] memory xs, int16[10] memory ys, bool[10] memory picked);
    function getRound(uint64 gameId, uint8 round) external view returns (RoundResult memory);
    function openGameForTier(uint8 tier) external view returns (uint64 gameId); // 0 if none
    function tierValue(uint8 tier) external view returns (uint128);
    function wagered(address player) external view returns (uint128);           // lifetime wei entered (Rain eligibility)
    function claimable(address player) external view returns (uint128);

    // ---- events (indexer + client depend on these exactly) ----
    event GameOpened(uint64 indexed gameId, uint8 indexed tier, uint128 entry);
    event SeatTaken(uint64 indexed gameId, uint8 seat, address indexed player);
    event SeatLeft(uint64 indexed gameId, uint8 seat, address indexed player);
    event LobbyCountdownStarted(uint64 indexed gameId, uint64 startsAt);
    event GameStarted(uint64 indexed gameId, uint8 players, uint128 pot);
    event GameCancelled(uint64 indexed gameId);
    event RoundStarted(uint64 indexed gameId, uint8 round, uint64 pickDeadline, uint16 aliveMask);
    event PickPlaced(uint64 indexed gameId, uint8 round, uint8 seat, int16 x, int16 y, uint8 pickCount);
    event RoundLocked(uint64 indexed gameId, uint8 round, bytes32 picksHash, uint64 entropyRequestId);
    event SeedReceived(uint64 indexed gameId, uint8 round, bytes32 seed);
    event AutoPicked(uint64 indexed gameId, uint8 round, uint8 seat, int16 x, int16 y);
    event RoundResolved(
        uint64 indexed gameId, uint8 round, int16 targetX, int16 targetY, Outcome outcome,
        uint16 survivorMask, uint16 radiusMm, uint16 saveBps, uint64 nextPhaseAt
    );
    event CashedOut(uint64 indexed gameId, uint8 round, uint8 seat, address indexed player, uint128 amount);
    event GameFinished(uint64 indexed gameId, uint8 seat, address indexed winner, uint128 prize, uint8 rounds);
    event GameRefunded(uint64 indexed gameId, uint128 perSeat);
    event Claimable(address indexed player, uint128 amount);
    event Withdrawn(address indexed player, uint128 amount);
}

interface ISessionRegistry {
    /// @notice msg.sender (the player) authorises `key` until `expiry`. `key` may call pickFor/cashOutFor for them only.
    function authorize(address key, uint64 expiry) external;
    function revoke(address key) external;
    function isAuthorized(address player, address key) external view returns (bool);
    event SessionAuthorized(address indexed player, address indexed key, uint64 expiry);
    event SessionRevoked(address indexed player, address indexed key);
}

interface IRandomness {
    /// @notice Request a seed; the adapter later calls back `SpotkickRoyale.onSeed(requestId, seed)`.
    function requestSeed(bytes32 userRandomness) external payable returns (uint64 requestId);
    function fee() external view returns (uint256);
}

interface IRain {
    function openRain(uint64 durationSecs) external payable returns (uint64 rainId); // msg.value funds the pot
    function fund(uint64 rainId) external payable;
    function join(uint64 rainId) external;      // requires wagered(player) >= minWager
    function settle(uint64 rainId) external;    // after endsAt; fixes per-share amount
    function claim(uint64 rainId) external;     // pull; amount = pot / joined
    event RainOpened(uint64 indexed rainId, uint64 endsAt, uint128 amount);
    event RainFunded(uint64 indexed rainId, uint128 amount, uint128 total);
    event RainJoined(uint64 indexed rainId, address indexed player, uint32 joined);
    event RainSettled(uint64 indexed rainId, uint128 total, uint32 joined);
    event RainClaimed(uint64 indexed rainId, address indexed player, uint128 amount);
}
