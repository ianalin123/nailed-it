import { describe, expect, it } from "vitest";
import { bandDistance, buildSchedule, selectCards } from "./cards";
import { makeDeck } from "./fixtures.test-helpers";

describe("bandDistance", () => {
  it("is zero inside [0.45, 0.8] inclusive", () => {
    expect(bandDistance(0.45)).toBe(0);
    expect(bandDistance(0.6)).toBe(0);
    expect(bandDistance(0.8)).toBe(0);
  });

  it("measures distance to the nearest band edge outside it", () => {
    expect(bandDistance(0.4)).toBeCloseTo(0.05);
    expect(bandDistance(0.95)).toBeCloseTo(0.15);
    expect(bandDistance(0)).toBeCloseTo(0.45);
  });
});

describe("selectCards", () => {
  it("prefers in-band reads, then nearest to the band", () => {
    const deck = makeDeck("a", [0.1, 0.95, 0.6, 0.4, 0.7]);
    const picked = selectCards(deck.reads, 4, () => 0.5).map((r) => r.id);
    expect(picked.slice(0, 2).sort()).toEqual(["a-r2", "a-r4"]);
    expect(picked[2]).toBe("a-r3");
    expect(picked[3]).toBe("a-r1");
  });

  it("uses the injected random source to break ties", () => {
    const deck = makeDeck("a", [0.5, 0.6, 0.7]);
    const sequence = (values: number[]) => {
      let i = 0;
      return () => values[i++ % values.length] ?? 0;
    };
    const forward = selectCards(deck.reads, 3, sequence([0.1, 0.2, 0.3])).map((r) => r.id);
    const reverse = selectCards(deck.reads, 3, sequence([0.3, 0.2, 0.1])).map((r) => r.id);
    expect(forward).toEqual(["a-r0", "a-r1", "a-r2"]);
    expect(reverse).toEqual(["a-r2", "a-r1", "a-r0"]);
  });

  it("never returns more cards than the deck holds", () => {
    const deck = makeDeck("a", [0.5, 0.6, 0.7]);
    expect(selectCards(deck.reads, 10, () => 0)).toHaveLength(3);
  });
});

describe("buildSchedule", () => {
  it("rotates the hot seat across deck holders, cardsPerPlayer rounds each", () => {
    const schedule = buildSchedule(
      [
        { playerId: "a", deck: makeDeck("a") },
        { playerId: "b", deck: makeDeck("b") },
      ],
      2,
      () => 0,
    );
    expect(schedule.map((c) => c.hotSeatPlayerId)).toEqual(["a", "b", "a", "b"]);
    expect(schedule[0]?.digestId).toBe("digest-a");
  });

  it("drops a holder from the rotation once their deck is exhausted", () => {
    const schedule = buildSchedule(
      [
        { playerId: "a", deck: makeDeck("a", [0.5, 0.6, 0.7]) },
        { playerId: "b", deck: makeDeck("b", [0.5, 0.6, 0.7, 0.55, 0.65]) },
      ],
      5,
      () => 0,
    );
    expect(schedule.map((c) => c.hotSeatPlayerId)).toEqual(["a", "b", "a", "b", "a", "b", "b", "b"]);
  });
});
