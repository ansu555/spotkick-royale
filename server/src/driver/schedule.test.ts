import { describe, expect, it } from "vitest";
import { Phase } from "../abi.js";
import { actionKey, decide, popcount, retryDelayMs, seatsInvolved, type ChainGameState, type ScheduleParams } from "./schedule.js";

const base: ScheduleParams = { nowSec: 1000n, lockedAtSec: null, marginSec: 1n, stallTimeoutSec: 600n, entropyTimeoutSec: 120n };
const game = (over: Partial<ChainGameState>): ChainGameState => ({
  gameId: 1n, phase: Phase.Lobby, round: 0, seatsFilled: 3, aliveMask: 0b111, phaseEndsAt: 0n, ...over,
});

describe("decide", () => {
  it("lobby: waits with no countdown, waits during it, starts only after deadline + margin", () => {
    expect(decide(game({ phaseEndsAt: 0n }), base).kind).toBe("wait");
    expect(decide(game({ phaseEndsAt: 1010n }), base)).toMatchObject({ kind: "wait", untilSec: 1011n });
    expect(decide(game({ phaseEndsAt: 1000n }), base).kind).toBe("wait"); // exactly at deadline: margin not yet elapsed
    expect(decide(game({ phaseEndsAt: 999n }), base)).toMatchObject({ kind: "act", fn: "startGame" });
  });

  it("enforces at least 1s margin even if configured lower", () => {
    const p = { ...base, marginSec: 0n };
    expect(decide(game({ phaseEndsAt: 1000n }), p).kind).toBe("wait");
    expect(decide(game({ phaseEndsAt: 999n }), p).kind).toBe("act");
  });

  it("picking -> lockPicks after the pick deadline", () => {
    const g = game({ phase: Phase.Picking, round: 1, phaseEndsAt: 1005n });
    expect(decide(g, base).kind).toBe("wait");
    expect(decide(g, { ...base, nowSec: 1006n })).toMatchObject({ kind: "act", fn: "lockPicks" });
  });

  it("locked waits for the entropy seed, then asks to refund once the entropy timeout passes", () => {
    const g = game({ phase: Phase.Locked, round: 1 });
    expect(decide(g, base)).toMatchObject({ kind: "wait", untilSec: null });
    expect(decide(g, { ...base, lockedAtSec: 950n })).toMatchObject({ kind: "wait", untilSec: 1071n });
    expect(decide(g, { ...base, lockedAtSec: 800n })).toMatchObject({ kind: "act", fn: "refundStalled" });
  });

  it("resolved -> resolveRound immediately", () => {
    expect(decide(game({ phase: Phase.Resolved, round: 1 }), base)).toMatchObject({ kind: "act", fn: "resolveRound" });
  });

  it("between -> advance after nextPhaseAt + margin", () => {
    const g = game({ phase: Phase.Between, round: 1, phaseEndsAt: 1009n });
    expect(decide(g, base).kind).toBe("wait");
    expect(decide(g, { ...base, nowSec: 1010n })).toMatchObject({ kind: "act", fn: "advance" });
  });

  it("refunds a stalled phase 600s after its missed deadline", () => {
    const g = game({ phase: Phase.Picking, round: 1, phaseEndsAt: 100n });
    expect(decide(g, { ...base, nowSec: 700n }).kind).toBe("act");
    expect(decide(g, { ...base, nowSec: 700n })).toMatchObject({ fn: "lockPicks" }); // still try lock before stall window
    expect(decide(g, { ...base, nowSec: 701n })).toMatchObject({ kind: "act", fn: "refundStalled" });
  });

  it("terminal phases do nothing", () => {
    for (const phase of [Phase.None, Phase.Finished, Phase.Cancelled]) expect(decide(game({ phase }), base).kind).toBe("wait");
  });
});

describe("helpers", () => {
  it("popcount / seatsInvolved", () => {
    expect(popcount(0b1010110101)).toBe(6);
    expect(seatsInvolved(game({ aliveMask: 0b11, seatsFilled: 10 }))).toBe(2);
    expect(seatsInvolved(game({ aliveMask: 0, seatsFilled: 4 }))).toBe(4);
  });
  it("retryDelayMs is exponential and capped", () => {
    expect([0, 1, 2, 3, 10].map((n) => retryDelayMs(n))).toEqual([0, 500, 1000, 2000, 15_000]);
  });
  it("actionKey changes with phase/round so cooldowns reset on progress", () => {
    expect(actionKey(game({ round: 1 }), "advance")).not.toBe(actionKey(game({ round: 2 }), "advance"));
  });
});

describe("decide: locked phase resolves once the seed has arrived", () => {
  it("resolveRound when seedReady (contract stays Locked until resolveRound runs)", () => {
    const g = game({ phase: Phase.Locked, round: 1, seedReady: true });
    expect(decide(g, { ...base, lockedAtSec: 990n })).toMatchObject({ kind: "act", fn: "resolveRound" });
  });
  it("keeps waiting for the seed when it has not arrived, and refunds only after the entropy timeout", () => {
    const g = game({ phase: Phase.Locked, round: 1, seedReady: false });
    expect(decide(g, { ...base, lockedAtSec: 990n }).kind).toBe("wait");
    expect(decide(g, { ...base, lockedAtSec: 800n })).toMatchObject({ kind: "act", fn: "refundStalled" });
  });
});
