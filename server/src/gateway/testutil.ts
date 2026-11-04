import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import type { HubSocket } from "./hub.js";
import type { Logger } from "./types.js";

export const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function newRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

export class FakeSocket implements HubSocket {
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  buffered = 0;
  constructor(
    readonly id: string,
    readonly address: string | null = null,
  ) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  types(): string[] {
    return this.sent.map((m) => (m as { t: string }).t);
  }
}
