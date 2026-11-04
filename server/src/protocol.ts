// WS protocol types + the internal bus contract. Owned by the orchestrator; see docs/INTERFACES.md §4.
// server-core PUBLISHES `Envelope`s to Redis channel BUS_CHANNEL (derived from chain events).
// server-realtime (gateway) SUBSCRIBES, fans out to sockets by `channel`, and never talks to the chain itself.

export const BUS_CHANNEL = "sk:ws";

export type Outcome = "goal" | "saved";
export type PhaseName = "none" | "lobby" | "picking" | "locked" | "resolved" | "between" | "finished" | "cancelled";

export interface RoomInfo {
  tier: number;
  valueWei: string;
  gameId: string | null;
  phase: PhaseName;
  seatsFilled: number;
  phaseEndsAt: number; // unix seconds, 0 if none
}

export interface GameSnapshot {
  gameId: string;
  tier: number;
  phase: PhaseName;
  round: number;
  entryWei: string;
  potWei: string;
  aliveMask: number;
  phaseEndsAt: number;
  seats: (string | null)[]; // length 10, lowercase address or null
  picks: { seat: number; x: number; y: number; auto?: boolean }[]; // current round
  results: { round: number; targetX: number; targetY: number; outcome: Outcome; survivorMask: number; radiusMm: number; saveBps: number }[];
}

export type ServerMsg =
  | { t: "hello"; chainId: number; serverTime: number; contracts: { royale: string; rain: string; sessions: string } }
  | { t: "rooms"; rooms: RoomInfo[] }
  | { t: "game"; game: GameSnapshot }
  | { t: "seat"; gameId: string; seat: number; player: string; left?: boolean }
  | { t: "countdown"; gameId: string; startsAt: number }
  | { t: "pick"; gameId: string; round: number; seat: number; x: number; y: number; pickCount: number; speculative: boolean }
  | { t: "locked"; gameId: string; round: number; picksHash: string }
  | { t: "seed"; gameId: string; round: number }
  | {
      t: "resolved"; gameId: string; round: number; targetX: number; targetY: number; outcome: Outcome;
      survivorMask: number; radiusMm: number; saveBps: number; nextPhaseAt: number;
      autoPicks: { seat: number; x: number; y: number }[];
    }
  | { t: "cashout"; gameId: string; round: number; seat: number; player: string; amount: string }
  | { t: "finished"; gameId: string; seat: number; winner: string; prize: string; rounds: number }
  | { t: "refunded"; gameId: string; perSeat: string }
  | { t: "chat"; id: string; ts: number; user: string; text: string; level?: number }
  | { t: "sys"; ts: number; kind: "entry" | "cashout" | "winner" | "kickoff"; html: string }
  | { t: "presence"; count: number }
  | { t: "ticker"; user: string; amount: string; mult: number; gameId: string }
  | { t: "rain"; rainId: string; amount: string; joined: number; endsAt: number; settled?: boolean };

export type ClientMsg =
  | { t: "sub"; channels: string[] } // "rooms" | "chat" | "rain" | "presence" | "ticker" | `game:${string}`
  | { t: "chat"; text: string }
  | { t: "ping" };

/** `channel` decides which sockets receive `msg`: "rooms" | "chat" | "rain" | "presence" | "ticker" | `game:<id>` */
export interface Envelope {
  channel: string;
  msg: ServerMsg;
}

// ---------------------------------------------------------------------------
// Hand-off between server-core (owns src/main.ts, db, indexer, driver, REST) and
// server-realtime (owns src/gateway, auth, chat, presence). server-core calls `startRealtime` from main.ts.
// server-realtime exports it from `src/gateway/index.ts`. Realtime uses Redis only (no Postgres): chat history is a capped stream.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from "fastify";

export interface RealtimeOptions {
  app: FastifyInstance; // realtime registers GET /api/auth/nonce, POST /api/auth/verify, GET /api/chat and the /ws upgrade
  redisUrl: string;
  jwtSecret: string;
  chainId: number;
  rpcUrl: string;
  contracts: { royale: `0x${string}`; rain: `0x${string}`; sessions: `0x${string}` };
  /** chat requires lifetime wagered >= this (read via royale.wagered(address) over rpcUrl) */
  minChatWagerWei: bigint;
  /** initial state for new subscribers; provided by server-core */
  snapshots: {
    rooms(): Promise<RoomInfo[]>;
    game(gameId: string): Promise<GameSnapshot | null>;
  };
}
export type StartRealtime = (o: RealtimeOptions) => Promise<{ close(): Promise<void> }>;
