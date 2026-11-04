// Raw JSON-RPC WebSocket feed: Monad `monadLogs` (speculative, ~400ms) with fallback to standard `logs`,
// plus `newHeads` as a wake-up signal for the finalized sync loop. Reconnects with capped backoff.
import WebSocket from "ws";
import type { Hex } from "viem";
import type { Logger } from "../config/logger.js";

export interface WireLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: Hex | null;
  removed?: boolean;
}

export type SpecMode = "monadLogs" | "logs" | "off";

export interface LiveFeedOptions {
  url: string;
  addresses: Hex[];
  log: Logger;
  onLog(log: WireLog, mode: Exclude<SpecMode, "off">): void;
  /** new head seen or (re)connected: the finalized loop should look for work now */
  onWake(): void;
  /** injectable for tests */
  createSocket?: (url: string) => WebSocket;
}

const SUB_LOGS_SPEC = 1;
const SUB_HEADS = 2;

export class LiveFeed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastMsgAt = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  mode: SpecMode = "off";
  connected = false;

  constructor(private readonly o: LiveFeedOptions) {}

  start(): void {
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastMsgAt > 30_000) {
        this.o.log.warn("ws silent for 30s, reconnecting");
        this.ws.terminate();
      } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 10_000);
    this.watchdog.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  private send(method: string, id: number, params: unknown[]): void {
    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  private subscribeLogs(kind: "monadLogs" | "logs"): void {
    this.mode = kind;
    this.send("eth_subscribe", SUB_LOGS_SPEC, [kind, { address: this.o.addresses }]);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = (this.o.createSocket ?? ((u: string) => new WebSocket(u)))(this.o.url);
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      this.connected = true;
      this.lastMsgAt = Date.now();
      this.o.log.info("ws connected", { url: this.o.url.replace(/\/\/.*@/, "//***@") });
      this.subscribeLogs("monadLogs");
      this.send("eth_subscribe", SUB_HEADS, ["newHeads"]);
      this.o.onWake(); // gap backfill after any reconnect
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      this.lastMsgAt = Date.now();
      this.handle(raw.toString());
    });
    ws.on("pong", () => {
      this.lastMsgAt = Date.now();
    });
    ws.on("error", (e: Error) => this.o.log.warn("ws error", { err: e }));
    ws.on("close", () => {
      this.connected = false;
      this.mode = "off";
      this.ws = null;
      if (this.stopped) return;
      const delay = Math.min(500 * 2 ** this.attempt++, 15_000);
      this.o.log.warn("ws closed, reconnecting", { delayMs: delay });
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private handle(text: string): void {
    let m: { id?: number; error?: { message?: string }; method?: string; params?: { subscription: string; result: unknown } };
    try {
      m = JSON.parse(text) as typeof m;
    } catch (e) {
      this.o.log.warn("ws: unparseable frame", { err: e });
      return;
    }
    if (m.error) {
      if (m.id === SUB_LOGS_SPEC && this.mode === "monadLogs") {
        this.o.log.warn("monadLogs unsupported, falling back to logs", { reason: m.error.message });
        this.subscribeLogs("logs");
      } else {
        this.o.log.error("ws subscribe error", { id: m.id, reason: m.error.message });
      }
      return;
    }
    if (m.method !== "eth_subscription" || !m.params) return;
    const result = m.params.result as Record<string, unknown> | null;
    if (!result) return;
    if ("topics" in result) {
      this.o.onLog(result as unknown as WireLog, this.mode === "off" ? "logs" : this.mode);
    } else if ("log" in result && result.log && typeof result.log === "object") {
      this.o.onLog(result.log as WireLog, this.mode === "off" ? "monadLogs" : this.mode); // {log, commitState} wrapper form
    } else if ("number" in result || "hash" in result) {
      this.o.onWake();
    }
  }
}

export function wireToLog(l: WireLog): {
  address: Hex; topics: Hex[]; data: Hex; blockNumber: bigint | null; blockHash: Hex | null;
  transactionHash: Hex | null; logIndex: number | null; removed: boolean;
} {
  return {
    address: l.address, topics: l.topics, data: l.data,
    blockNumber: l.blockNumber ? BigInt(l.blockNumber) : null,
    blockHash: l.blockHash, transactionHash: l.transactionHash,
    logIndex: l.logIndex ? Number(BigInt(l.logIndex)) : null,
    removed: l.removed === true,
  };
}
