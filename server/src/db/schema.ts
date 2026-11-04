import {
  bigint, boolean, doublePrecision, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text,
} from "drizzle-orm/pg-core";

const wei = (name: string) => numeric(name, { precision: 78, scale: 0 });
const id64 = (name: string) => bigint(name, { mode: "bigint" });
const n64 = (name: string) => bigint(name, { mode: "number" }); // block numbers / unix seconds: safe < 2^53

export const games = pgTable(
  "games",
  {
    id: id64("id").primaryKey(),
    tier: smallint("tier").notNull(),
    entryWei: wei("entry_wei").notNull(),
    phase: text("phase").notNull().default("lobby"), // PhaseName
    round: smallint("round").notNull().default(0),
    potWei: wei("pot_wei").notNull().default("0"),
    aliveMask: integer("alive_mask").notNull().default(0),
    seatsFilled: smallint("seats_filled").notNull().default(0),
    phaseEndsAt: n64("phase_ends_at").notNull().default(0),
    countdownStartsAt: n64("countdown_starts_at"),
    playersAtStart: smallint("players_at_start"),
    winner: text("winner"),
    winnerSeat: smallint("winner_seat"),
    prizeWei: wei("prize_wei"),
    roundsPlayed: smallint("rounds_played"),
    refundPerSeatWei: wei("refund_per_seat_wei"),
    openedBlock: n64("opened_block").notNull(),
    openedAt: n64("opened_at").notNull(),
    startedAt: n64("started_at"),
    finishedAt: n64("finished_at"),
  },
  (t) => [index("games_tier_phase_idx").on(t.tier, t.phase), index("games_phase_idx").on(t.phase)],
);

export const seats = pgTable(
  "seats",
  {
    gameId: id64("game_id").notNull(),
    seat: smallint("seat").notNull(),
    player: text("player").notNull(),
    left: boolean("left").notNull().default(false),
    takenAt: n64("taken_at").notNull(),
    cashedOutRound: smallint("cashed_out_round"),
    cashoutWei: wei("cashout_wei"),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.seat] }), index("seats_player_idx").on(t.player)],
);

export const picks = pgTable(
  "picks",
  {
    gameId: id64("game_id").notNull(),
    round: smallint("round").notNull(),
    seat: smallint("seat").notNull(),
    pickCount: smallint("pick_count").notNull(), // 0 for auto picks
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    auto: boolean("auto").notNull().default(false),
    txHash: text("tx_hash").notNull(),
    blockNumber: n64("block_number").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round, t.seat, t.pickCount] })],
);

export const rounds = pgTable(
  "rounds",
  {
    gameId: id64("game_id").notNull(),
    round: smallint("round").notNull(),
    pickDeadline: n64("pick_deadline"),
    aliveMask: integer("alive_mask"),
    picksHash: text("picks_hash"),
    entropyRequestId: wei("entropy_request_id"),
    lockedAt: n64("locked_at"),
    seed: text("seed"),
    targetX: integer("target_x"),
    targetY: integer("target_y"),
    outcome: text("outcome"), // 'goal' | 'saved'
    survivorMask: integer("survivor_mask"),
    radiusMm: integer("radius_mm"),
    saveBps: integer("save_bps"),
    nextPhaseAt: n64("next_phase_at"),
    startedTx: text("started_tx"),
    lockedTx: text("locked_tx"),
    seedTx: text("seed_tx"),
    resolvedTx: text("resolved_tx"),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.round] })],
);

export const cashouts = pgTable(
  "cashouts",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    gameId: id64("game_id").notNull(),
    round: smallint("round").notNull(),
    seat: smallint("seat").notNull(),
    player: text("player").notNull(),
    amountWei: wei("amount_wei").notNull(),
    ts: n64("ts").notNull(),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index("cashouts_game_idx").on(t.gameId), index("cashouts_ts_idx").on(t.ts)],
);

export const players = pgTable("players", {
  address: text("address").primaryKey(),
  wageredWei: wei("wagered_wei").notNull().default("0"),
  wonWei: wei("won_wei").notNull().default("0"),
  games: integer("games").notNull().default(0),
  cashouts: integer("cashouts").notNull().default(0),
  bestMultiple: doublePrecision("best_multiple").notNull().default(0),
});

export const wins = pgTable(
  "wins",
  {
    gameId: id64("game_id").primaryKey(),
    winner: text("winner").notNull(),
    seat: smallint("seat").notNull(),
    prizeWei: wei("prize_wei").notNull(),
    entryWei: wei("entry_wei").notNull(),
    rounds: smallint("rounds").notNull(),
    ts: n64("ts").notNull(),
    txHash: text("tx_hash").notNull(),
  },
  (t) => [index("wins_ts_idx").on(t.ts), index("wins_winner_idx").on(t.winner)],
);

export const rain = pgTable("rain", {
  rainId: id64("rain_id").primaryKey(),
  endsAt: n64("ends_at").notNull(),
  amountWei: wei("amount_wei").notNull(), // running pot (opened + funded)
  joined: integer("joined").notNull().default(0),
  settled: boolean("settled").notNull().default(false),
  claimedWei: wei("claimed_wei").notNull().default("0"),
  openedAt: n64("opened_at").notNull(),
});

export const indexerCursor = pgTable("indexer_cursor", {
  name: text("name").primaryKey(),
  blockNumber: n64("block_number").notNull(),
  blockHash: text("block_hash"),
  updatedAt: n64("updated_at").notNull(),
});

export const rawEvents = pgTable(
  "raw_events",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: n64("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    blockTimestamp: n64("block_timestamp").notNull(),
    address: text("address").notNull(),
    eventName: text("event_name").notNull(),
    args: jsonb("args").notNull(),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index("raw_events_block_idx").on(t.blockNumber)],
);

export const schema = {
  games, seats, picks, rounds, cashouts, players, wins, rain, indexerCursor, rawEvents,
};
