import { describe, expect, it } from "vitest";
import { Hub } from "./hub.js";
import { FakeSocket, silentLog } from "./testutil.js";

const presence = (count: number) => ({ t: "presence" as const, count });

describe("Hub fan-out", () => {
  it("routes an envelope only to sockets subscribed to its channel", () => {
    const hub = new Hub(silentLog);
    const a = new FakeSocket("a");
    const b = new FakeSocket("b");
    const c = new FakeSocket("c");
    [a, b, c].forEach((s) => hub.add(s));
    hub.subscribe("a", ["presence", "game:7"]);
    hub.subscribe("b", ["chat"]);

    expect(hub.fanout({ channel: "presence", msg: presence(3) })).toBe(1);
    expect(hub.fanout({ channel: "game:7", msg: { t: "seed", gameId: "7", round: 1 } })).toBe(1);
    expect(hub.fanout({ channel: "game:8", msg: { t: "seed", gameId: "8", round: 1 } })).toBe(0);

    expect(a.types()).toEqual(["presence", "seed"]);
    expect(b.sent).toEqual([]);
    expect(c.sent).toEqual([]);
  });

  it("stops delivering after unsubscribe and after remove", () => {
    const hub = new Hub(silentLog);
    const a = new FakeSocket("a");
    hub.add(a);
    hub.subscribe("a", ["presence"]);
    hub.unsubscribe("a", ["presence"]);
    expect(hub.fanout({ channel: "presence", msg: presence(1) })).toBe(0);
    hub.subscribe("a", ["presence"]);
    hub.remove("a");
    expect(hub.fanout({ channel: "presence", msg: presence(1) })).toBe(0);
    expect(hub.size).toBe(0);
  });

  it("rejects invalid channels and caps channels per socket at 20", () => {
    const hub = new Hub(silentLog);
    hub.add(new FakeSocket("a"));
    const bad = hub.subscribe("a", ["nope", "game:", "game:../x"]);
    expect(bad.added).toEqual([]);
    expect(bad.rejected).toHaveLength(3);

    const many = Array.from({ length: 25 }, (_, i) => `game:${i}`);
    const res = hub.subscribe("a", many);
    expect(res.added).toHaveLength(20);
    expect(res.rejected.filter((r) => r.reason === "too_many")).toHaveLength(5);
    expect(hub.channelsOf("a")).toHaveLength(20);
  });

  it("closes and removes slow consumers whose buffer exceeds the limit", () => {
    const hub = new Hub(silentLog, 1000);
    const slow = new FakeSocket("slow");
    const fast = new FakeSocket("fast");
    hub.add(slow);
    hub.add(fast);
    hub.subscribe("slow", ["presence"]);
    hub.subscribe("fast", ["presence"]);
    slow.buffered = 5000;

    expect(hub.fanout({ channel: "presence", msg: presence(2) })).toBe(1);
    expect(slow.closed?.code).toBe(1013);
    expect(slow.sent).toEqual([]);
    expect(fast.sent).toHaveLength(1);
    expect(hub.size).toBe(1);
  });

  it("drops a socket whose send throws without affecting others", () => {
    const hub = new Hub(silentLog);
    const bad = new FakeSocket("bad");
    bad.send = () => {
      throw new Error("boom");
    };
    const ok = new FakeSocket("ok");
    hub.add(bad);
    hub.add(ok);
    hub.subscribe("bad", ["presence"]);
    hub.subscribe("ok", ["presence"]);
    expect(hub.fanout({ channel: "presence", msg: presence(1) })).toBe(1);
    expect(hub.size).toBe(1);
  });
});
