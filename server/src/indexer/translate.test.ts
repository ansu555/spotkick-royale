import { describe, expect, it } from "vitest";
import { UnknownOutcomeError } from "./decode.js";
import { P1, P2, ev } from "./test-events.js";
import { affectsRooms, formatMon, multiple, pickEnvelope, snapshotGameIds, translateEvents } from "./translate.js";

const ctx = { entryWei: new Map([["7", 3_000_000_000_000_000_000n]]), rain: new Map() };

describe("translateEvents", () => {
  it("maps seat/countdown/lock/seed to game channel messages", () => {
    const out = translateEvents(
      [
        ev("SeatTaken", { gameId: 7n, seat: 2, player: P1 }),
        ev("SeatLeft", { gameId: 7n, seat: 2, player: P1 }),
        ev("LobbyCountdownStarted", { gameId: 7n, startsAt: 1015n }),
        ev("RoundLocked", { gameId: 7n, round: 1, picksHash: "0xabc", entropyRequestId: 9n }),
        ev("SeedReceived", { gameId: 7n, round: 1, seed: "0xdef" }),
      ],
      ctx,
    );
    expect(out.filter((e) => e.channel === "game:7").map((e) => e.msg.t)).toEqual(["seat", "seat", "countdown", "locked", "seed"]);
    const g = out.filter((e) => e.channel === "game:7").map((e) => e.msg);
    expect(g[1]).toMatchObject({ t: "seat", left: true, seat: 2, player: P1 });
    expect(g[2]).toMatchObject({ t: "countdown", startsAt: 1015 });
    expect(out.find((e) => e.msg.t === "sys")).toMatchObject({ channel: "chat", msg: { kind: "entry", ts: 1_000_000 } });
  });

  it("attaches auto picks to the following RoundResolved and uses decimal strings", () => {
    const out = translateEvents(
      [
        ev("AutoPicked", { gameId: 7n, round: 1, seat: 4, x: -10, y: 500 }),
        ev("AutoPicked", { gameId: 7n, round: 1, seat: 1, x: 20, y: 700 }),
        ev("RoundResolved", { gameId: 7n, round: 1, targetX: 5, targetY: 600, outcome: 2, survivorMask: 0b11, radiusMm: 900, saveBps: 4000, nextPhaseAt: 2000n }),
        ev("RoundResolved", { gameId: 7n, round: 2, targetX: 5, targetY: 600, outcome: 1, survivorMask: 0b1, radiusMm: 900, saveBps: 4000, nextPhaseAt: 2009n }),
      ],
      ctx,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.msg).toMatchObject({
      t: "resolved", outcome: "saved", nextPhaseAt: 2000, autoPicks: [{ seat: 1, x: 20, y: 700 }, { seat: 4, x: -10, y: 500 }],
    });
    expect(out[1]?.msg).toMatchObject({ outcome: "goal", autoPicks: [] });
  });

  it("rejects an unknown outcome code loudly", () => {
    expect(() =>
      translateEvents([ev("RoundResolved", { gameId: 7n, round: 1, targetX: 0, targetY: 0, outcome: 0, survivorMask: 1, radiusMm: 0, saveBps: 0, nextPhaseAt: 1n })], ctx),
    ).toThrow(UnknownOutcomeError);
  });

  it("cashout and finish emit game msg + ticker + sys with multiples", () => {
    const out = translateEvents(
      [
        ev("CashedOut", { gameId: 7n, round: 2, seat: 3, player: P2, amount: 6_000_000_000_000_000_000n }),
        ev("GameFinished", { gameId: 7n, seat: 0, winner: P1, prize: 9_000_000_000_000_000_000n, rounds: 3 }),
      ],
      ctx,
    );
    const types = out.map((e) => `${e.channel}:${e.msg.t}`);
    expect(types).toEqual(["game:7:cashout", "ticker:ticker", "chat:sys", "game:7:finished", "ticker:ticker", "chat:sys"]);
    expect(out[0]?.msg).toMatchObject({ amount: "6000000000000000000", player: P2 });
    expect(out[1]?.msg).toMatchObject({ mult: 2, gameId: "7" });
    expect(out[4]?.msg).toMatchObject({ mult: 3 });
  });

  it("skips the ticker when the entry is unknown instead of inventing a multiple", () => {
    const out = translateEvents([ev("CashedOut", { gameId: 99n, round: 2, seat: 3, player: P2, amount: 5n })], { entryWei: new Map(), rain: new Map() });
    expect(out.map((e) => e.msg.t)).toEqual(["cashout", "sys"]);
  });

  it("emits rain messages from post-apply state", () => {
    const rain = new Map([["4", { amountWei: 10n, joined: 3, endsAt: 5000, settled: true }]]);
    const out = translateEvents([ev("RainSettled", { rainId: 4n, total: 10n, joined: 3 }), ev("RainClaimed", { rainId: 4n, player: P1, amount: 3n })], { entryWei: new Map(), rain });
    expect(out).toEqual([{ channel: "rain", msg: { t: "rain", rainId: "4", amount: "10", joined: 3, endsAt: 5000, settled: true } }]);
  });

  it("pick envelopes carry the speculative flag", () => {
    const e = ev("PickPlaced", { gameId: 7n, round: 1, seat: 0, x: 1, y: 2, pickCount: 1 });
    if (e.eventName !== "PickPlaced") throw new Error("type guard");
    expect(pickEnvelope(e, true).msg).toMatchObject({ t: "pick", speculative: true, pickCount: 1 });
    expect(translateEvents([e], ctx)[0]?.msg).toMatchObject({ t: "pick", speculative: false });
  });
});

describe("helpers", () => {
  it("formats MON and multiples", () => {
    expect(formatMon(3_000_000_000_000_000_000n)).toBe("3");
    expect(formatMon(250_000_000_000_000_000n)).toBe("0.25");
    expect(multiple(7n, 0n)).toBeNull();
    expect(multiple(150n, 100n)).toBe(1.5);
  });
  it("selects room/snapshot events", () => {
    const evs = [ev("SeatTaken", { gameId: 1n, seat: 0, player: P1 }), ev("RoundResolved", { gameId: 2n, round: 1, targetX: 0, targetY: 0, outcome: 1, survivorMask: 1, radiusMm: 0, saveBps: 0, nextPhaseAt: 1n })];
    expect(affectsRooms(evs)).toBe(true);
    expect(snapshotGameIds(evs)).toEqual(["2"]);
    expect(affectsRooms([ev("PickPlaced", { gameId: 1n, round: 1, seat: 0, x: 0, y: 0, pickCount: 1 })])).toBe(false);
  });
});
