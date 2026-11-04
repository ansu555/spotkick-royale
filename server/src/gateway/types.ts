import type { ServerMsg } from "../protocol.js";

/** Minimal structured logger; fastify's pino logger satisfies this. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Non-protocol control frames (protocol.ts has no error/pong types). Clients must ignore unknown `t`. */
export interface ErrorFrame {
  t: "error";
  code: string;
  message: string;
  retryAfterMs?: number;
}
export interface PongFrame {
  t: "pong";
  ts: number;
}
export type OutFrame = ServerMsg | ErrorFrame | PongFrame;

export const MAX_CHANNELS_PER_SOCKET = 20;
export const MAX_FRAME_BYTES = 4096;
/** Close a socket whose unsent buffer exceeds this many bytes. */
export const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000;

export const WS_CLOSE = {
  GOING_AWAY: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
  TRY_AGAIN_LATER: 1013,
  BAD_TOKEN: 4401,
} as const;
