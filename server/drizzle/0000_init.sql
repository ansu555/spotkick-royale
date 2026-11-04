-- Spotkick server-core initial schema. Applied by src/db/migrate.ts (tracked in _migrations).
CREATE TABLE IF NOT EXISTS games (
  id bigint PRIMARY KEY,
  tier smallint NOT NULL,
  entry_wei numeric(78,0) NOT NULL,
  phase text NOT NULL DEFAULT 'lobby',
  round smallint NOT NULL DEFAULT 0,
  pot_wei numeric(78,0) NOT NULL DEFAULT 0,
  alive_mask integer NOT NULL DEFAULT 0,
  seats_filled smallint NOT NULL DEFAULT 0,
  phase_ends_at bigint NOT NULL DEFAULT 0,
  countdown_starts_at bigint,
  players_at_start smallint,
  winner text,
  winner_seat smallint,
  prize_wei numeric(78,0),
  rounds_played smallint,
  refund_per_seat_wei numeric(78,0),
  opened_block bigint NOT NULL,
  opened_at bigint NOT NULL,
  started_at bigint,
  finished_at bigint
);
CREATE INDEX IF NOT EXISTS games_tier_phase_idx ON games (tier, phase);
CREATE INDEX IF NOT EXISTS games_phase_idx ON games (phase);

CREATE TABLE IF NOT EXISTS seats (
  game_id bigint NOT NULL,
  seat smallint NOT NULL,
  player text NOT NULL,
  "left" boolean NOT NULL DEFAULT false,
  taken_at bigint NOT NULL,
  cashed_out_round smallint,
  cashout_wei numeric(78,0),
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX IF NOT EXISTS seats_player_idx ON seats (player);

CREATE TABLE IF NOT EXISTS picks (
  game_id bigint NOT NULL,
  round smallint NOT NULL,
  seat smallint NOT NULL,
  pick_count smallint NOT NULL,
  x integer NOT NULL,
  y integer NOT NULL,
  auto boolean NOT NULL DEFAULT false,
  tx_hash text NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (game_id, round, seat, pick_count)
);

CREATE TABLE IF NOT EXISTS rounds (
  game_id bigint NOT NULL,
  round smallint NOT NULL,
  pick_deadline bigint,
  alive_mask integer,
  picks_hash text,
  entropy_request_id numeric(78,0),
  locked_at bigint,
  seed text,
  target_x integer,
  target_y integer,
  outcome text,
  survivor_mask integer,
  radius_mm integer,
  save_bps integer,
  next_phase_at bigint,
  started_tx text,
  locked_tx text,
  seed_tx text,
  resolved_tx text,
  PRIMARY KEY (game_id, round)
);

CREATE TABLE IF NOT EXISTS cashouts (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  game_id bigint NOT NULL,
  round smallint NOT NULL,
  seat smallint NOT NULL,
  player text NOT NULL,
  amount_wei numeric(78,0) NOT NULL,
  ts bigint NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS cashouts_game_idx ON cashouts (game_id);
CREATE INDEX IF NOT EXISTS cashouts_ts_idx ON cashouts (ts);

CREATE TABLE IF NOT EXISTS players (
  address text PRIMARY KEY,
  wagered_wei numeric(78,0) NOT NULL DEFAULT 0,
  won_wei numeric(78,0) NOT NULL DEFAULT 0,
  games integer NOT NULL DEFAULT 0,
  cashouts integer NOT NULL DEFAULT 0,
  best_multiple double precision NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wins (
  game_id bigint PRIMARY KEY,
  winner text NOT NULL,
  seat smallint NOT NULL,
  prize_wei numeric(78,0) NOT NULL,
  entry_wei numeric(78,0) NOT NULL,
  rounds smallint NOT NULL,
  ts bigint NOT NULL,
  tx_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS wins_ts_idx ON wins (ts);
CREATE INDEX IF NOT EXISTS wins_winner_idx ON wins (winner);

CREATE TABLE IF NOT EXISTS rain (
  rain_id bigint PRIMARY KEY,
  ends_at bigint NOT NULL,
  amount_wei numeric(78,0) NOT NULL,
  joined integer NOT NULL DEFAULT 0,
  settled boolean NOT NULL DEFAULT false,
  claimed_wei numeric(78,0) NOT NULL DEFAULT 0,
  opened_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  name text PRIMARY KEY,
  block_number bigint NOT NULL,
  block_hash text,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_events (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  block_timestamp bigint NOT NULL,
  address text NOT NULL,
  event_name text NOT NULL,
  args jsonb NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS raw_events_block_idx ON raw_events (block_number);
