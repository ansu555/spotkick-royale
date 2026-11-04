// Typed ABI constants, hand-derived from contracts/src/ISpotkickRoyale.sol (single source of truth).
// Enums are encoded as uint8 on the wire. Keep in sync with that file.
import { parseAbi } from "viem";

export const royaleAbi = parseAbi([
  "struct GameView { uint64 id; uint8 tier; uint8 phase; uint8 round; uint8 seatsFilled; uint16 aliveMask; uint128 entry; uint128 pot; uint64 phaseEndsAt; }",
  "struct RoundResult { bytes32 seed; int16 targetX; int16 targetY; uint8 outcome; uint16 survivorMask; uint16 radiusMm; uint16 saveBps; }",

  "function enter(uint8 tier) payable returns (uint64 gameId, uint8 seat)",
  "function leaveLobby(uint64 gameId)",
  "function pick(uint64 gameId, int16 x, int16 y)",
  "function pickFor(uint64 gameId, address player, int16 x, int16 y)",
  "function cashOut(uint64 gameId)",
  "function cashOutFor(uint64 gameId, address player)",
  "function withdraw()",

  "function startGame(uint64 gameId)",
  "function lockPicks(uint64 gameId)",
  "function resolveRound(uint64 gameId)",
  "function advance(uint64 gameId)",
  "function refundStalled(uint64 gameId)",

  "function getGame(uint64 gameId) view returns (GameView)",
  "function getSeats(uint64 gameId) view returns (address[10])",
  "function getPicks(uint64 gameId) view returns (int16[10] xs, int16[10] ys, bool[10] picked)",
  "function getRound(uint64 gameId, uint8 round) view returns (RoundResult)",
  "function openGameForTier(uint8 tier) view returns (uint64 gameId)",
  "function tierValue(uint8 tier) view returns (uint128)",
  "function wagered(address player) view returns (uint128)",
  "function claimable(address player) view returns (uint128)",

  "event GameOpened(uint64 indexed gameId, uint8 indexed tier, uint128 entry)",
  "event SeatTaken(uint64 indexed gameId, uint8 seat, address indexed player)",
  "event SeatLeft(uint64 indexed gameId, uint8 seat, address indexed player)",
  "event LobbyCountdownStarted(uint64 indexed gameId, uint64 startsAt)",
  "event GameStarted(uint64 indexed gameId, uint8 players, uint128 pot)",
  "event GameCancelled(uint64 indexed gameId)",
  "event RoundStarted(uint64 indexed gameId, uint8 round, uint64 pickDeadline, uint16 aliveMask)",
  "event PickPlaced(uint64 indexed gameId, uint8 round, uint8 seat, int16 x, int16 y, uint8 pickCount)",
  "event RoundLocked(uint64 indexed gameId, uint8 round, bytes32 picksHash, uint64 entropyRequestId)",
  "event SeedReceived(uint64 indexed gameId, uint8 round, bytes32 seed)",
  "event AutoPicked(uint64 indexed gameId, uint8 round, uint8 seat, int16 x, int16 y)",
  "event RoundResolved(uint64 indexed gameId, uint8 round, int16 targetX, int16 targetY, uint8 outcome, uint16 survivorMask, uint16 radiusMm, uint16 saveBps, uint64 nextPhaseAt)",
  "event CashedOut(uint64 indexed gameId, uint8 round, uint8 seat, address indexed player, uint128 amount)",
  "event GameFinished(uint64 indexed gameId, uint8 seat, address indexed winner, uint128 prize, uint8 rounds)",
  "event GameRefunded(uint64 indexed gameId, uint128 perSeat)",
  "event Claimable(address indexed player, uint128 amount)",
  "event Withdrawn(address indexed player, uint128 amount)",

  // Best-effort custom errors so simulations decode. The authoritative classification of a revert is a
  // chain-state re-read (see driver/sender.ts); update this list when the contract's errors are final.
  "error WrongPhase()",
  "error TooEarly()",
  "error NotStalled()",
  "error BadPick()",
]);

export const rainAbi = parseAbi([
  "function openRain(uint64 durationSecs) payable returns (uint64 rainId)",
  "function fund(uint64 rainId) payable",
  "function join(uint64 rainId)",
  "function settle(uint64 rainId)",
  "function claim(uint64 rainId)",
  "event RainOpened(uint64 indexed rainId, uint64 endsAt, uint128 amount)",
  "event RainFunded(uint64 indexed rainId, uint128 amount, uint128 total)",
  "event RainJoined(uint64 indexed rainId, address indexed player, uint32 joined)",
  "event RainSettled(uint64 indexed rainId, uint128 total, uint32 joined)",
  "event RainClaimed(uint64 indexed rainId, address indexed player, uint128 amount)",
]);

/** Events decoded by the indexer: royale + rain (distinct names, so one merged ABI is unambiguous). */
export const eventsAbi = [...royaleAbi, ...rainAbi] as const;

/** Phase enum as returned by getGame (uint8). */
export const Phase = {
  None: 0, Lobby: 1, Picking: 2, Locked: 3, Resolved: 4, Between: 5, Finished: 6, Cancelled: 7,
} as const;
export type PhaseCode = (typeof Phase)[keyof typeof Phase];
