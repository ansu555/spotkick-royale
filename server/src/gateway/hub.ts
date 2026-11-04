import type { Envelope } from "../protocol.js";
import { DEFAULT_MAX_BUFFERED_BYTES, MAX_CHANNELS_PER_SOCKET, WS_CLOSE, type Logger, type OutFrame } from "./types.js";

/** Transport-agnostic socket the hub fans out to. */
export interface HubSocket {
  readonly id: string;
  /** lowercase address when authenticated, else null (read-only spectator). */
  readonly address: string | null;
  send(data: string): void;
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

const FIXED_CHANNELS = new Set(["rooms", "chat", "rain", "presence", "ticker"]);
const GAME_CHANNEL = /^game:[A-Za-z0-9_-]{1,64}$/;

export function isValidChannel(ch: string): boolean {
  return FIXED_CHANNELS.has(ch) || GAME_CHANNEL.test(ch);
}

export interface SubscribeResult {
  added: string[];
  rejected: { channel: string; reason: "invalid" | "too_many" }[];
}

export class Hub {
  private readonly sockets = new Map<string, { socket: HubSocket; channels: Set<string> }>();
  private readonly byChannel = new Map<string, Set<string>>();

  constructor(
    private readonly log: Logger,
    private readonly maxBufferedBytes: number = DEFAULT_MAX_BUFFERED_BYTES,
    private readonly maxChannels: number = MAX_CHANNELS_PER_SOCKET,
  ) {}

  get size(): number {
    return this.sockets.size;
  }

  add(socket: HubSocket): void {
    this.sockets.set(socket.id, { socket, channels: new Set() });
  }

  remove(id: string): void {
    const entry = this.sockets.get(id);
    if (!entry) return;
    for (const ch of entry.channels) this.dropFromChannel(ch, id);
    this.sockets.delete(id);
  }

  channelsOf(id: string): string[] {
    return [...(this.sockets.get(id)?.channels ?? [])];
  }

  subscribe(id: string, channels: readonly string[]): SubscribeResult {
    const entry = this.sockets.get(id);
    const result: SubscribeResult = { added: [], rejected: [] };
    if (!entry) return result;
    for (const channel of new Set(channels)) {
      if (!isValidChannel(channel)) {
        result.rejected.push({ channel, reason: "invalid" });
        continue;
      }
      if (entry.channels.has(channel)) continue;
      if (entry.channels.size >= this.maxChannels) {
        result.rejected.push({ channel, reason: "too_many" });
        continue;
      }
      entry.channels.add(channel);
      let set = this.byChannel.get(channel);
      if (!set) this.byChannel.set(channel, (set = new Set()));
      set.add(id);
      result.added.push(channel);
    }
    return result;
  }

  unsubscribe(id: string, channels: readonly string[]): void {
    const entry = this.sockets.get(id);
    if (!entry) return;
    for (const ch of channels) {
      if (entry.channels.delete(ch)) this.dropFromChannel(ch, id);
    }
  }

  /** Fan an envelope out to every local socket subscribed to `envelope.channel`. Returns delivered count. */
  fanout(envelope: Envelope): number {
    return this.broadcast(envelope.channel, envelope.msg);
  }

  broadcast(channel: string, frame: OutFrame): number {
    const ids = this.byChannel.get(channel);
    if (!ids || ids.size === 0) return 0;
    const data = JSON.stringify(frame);
    let delivered = 0;
    for (const id of [...ids]) {
      const entry = this.sockets.get(id);
      if (!entry) continue;
      if (this.sendOrDrop(entry.socket, data)) delivered++;
    }
    return delivered;
  }

  /** Send to one socket with the same backpressure policy. */
  sendTo(id: string, frame: OutFrame): boolean {
    const entry = this.sockets.get(id);
    return entry ? this.sendOrDrop(entry.socket, JSON.stringify(frame)) : false;
  }

  closeAll(code: number, reason: string): void {
    for (const { socket } of [...this.sockets.values()]) {
      try {
        socket.close(code, reason);
      } catch (err) {
        this.log.warn({ err, socket: socket.id }, "close failed");
      }
    }
  }

  private sendOrDrop(socket: HubSocket, data: string): boolean {
    try {
      if (socket.bufferedAmount() > this.maxBufferedBytes) {
        this.log.warn({ socket: socket.id, buffered: socket.bufferedAmount() }, "slow consumer dropped");
        socket.close(WS_CLOSE.TRY_AGAIN_LATER, "slow consumer");
        this.remove(socket.id);
        return false;
      }
      socket.send(data);
      return true;
    } catch (err) {
      this.log.warn({ err, socket: socket.id }, "send failed; dropping socket");
      this.remove(socket.id);
      return false;
    }
  }

  private dropFromChannel(channel: string, id: string): void {
    const set = this.byChannel.get(channel);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.byChannel.delete(channel);
  }
}
