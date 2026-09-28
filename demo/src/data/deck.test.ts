import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deck, Read } from "@nailed-it/protocol";
import { describe, expect, it } from "vitest";
import { CONFIDENCE_BAND, bandDistance, coldOpenRead, parseCast, parseDeck, planDeal, roundScript } from "./deck";

const DATA = join(import.meta.dirname, "../../data");
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(DATA, name), "utf8"));

const read = (id: string, confidence: number, withChain = true): Read => ({
  id,
  text: `Invented read ${id}.`,
  category: "work_style",
  confidence,
  evidenceIds: [],
  hops: 2,
  modelVersion: "test",
  ...(withChain ? { chain: [{ kind: "evidence" as const, text: `Saw ${id}.` }] } : {}),
});

const deck = (...reads: Read[]): Deck => ({ protocolVersion: 1, digestId: "d", reads });

describe("confidence band", () => {
  it("mirrors the room server's card selection band", () => {
    const server = readFileSync(join(import.meta.dirname, "../../../apps/room/src/game/cards.ts"), "utf8");
    const match = /CONFIDENCE_BAND = \{ low: ([\d.]+), high: ([\d.]+) \}/.exec(server);
    expect(match).not.toBeNull();
    expect(CONFIDENCE_BAND).toEqual({ low: Number(match?.[1]), high: Number(match?.[2]) });
  });

  it("measures distance outside the band only", () => {
    expect(bandDistance(0.6)).toBe(0);
    expect(bandDistance(0.9)).toBeCloseTo(0.1);
    expect(bandDistance(0.3)).toBeCloseTo(0.15);
  });
});

describe("planDeal", () => {
  it("pins the featured read when enough reads sit further from the band", () => {
    const plan = planDeal(deck(read("f", 0.6), read("a", 0.9), read("b", 0.3), read("c", 0.7)), "f");
    expect(plan.kind).toBe("pinned");
    expect(plan.deck.reads.map((r) => r.id)).toEqual(["f", "a", "b"]);
  });

  it("falls back to a random deal of chained reads when it cannot pin", () => {
    const plan = planDeal(deck(read("f", 0.6), read("a", 0.7), read("b", 0.5), read("c", 0.95, false)), "f");
    expect(plan.kind).toBe("random");
    expect(plan.deck.reads.map((r) => r.id)).toEqual(["f", "a", "b"]);
    if (plan.kind === "random") expect(plan.reason).toMatch(/0\.45/);
  });

  it("refuses a featured read that is not in the deck", () => {
    expect(() => planDeal(deck(read("a", 0.9), read("b", 0.3), read("c", 0.2)), "zzz")).toThrow(/featuredReadId "zzz"/);
  });

  it("refuses a featured read without a chain, since beat 6 needs one", () => {
    expect(() => planDeal(deck(read("f", 0.6, false), read("a", 0.9), read("b", 0.3)), "f")).toThrow(/chain/);
  });

  it("never changes a read", () => {
    const source = deck(read("f", 0.6), read("a", 0.9), read("b", 0.3));
    const plan = planDeal(source, "f");
    expect(plan.deck.reads).toEqual([source.reads[0], source.reads[1], source.reads[2]]);
  });
});

describe("shipped demo data", () => {
  it("deck.json is a valid protocol deck", () => {
    expect(parseDeck(readJson("deck.json")).reads.length).toBeGreaterThanOrEqual(3);
  });

  it("cast.json is valid and pins its featured read against deck.json", () => {
    const cast = parseCast(readJson("cast.json"));
    const plan = planDeal(parseDeck(readJson("deck.json")), cast.featuredReadId);
    expect(plan.kind).toBe("pinned");
  });
});

describe("parseCast", () => {
  const base = readJson("cast.json") as Record<string, unknown>;

  it("rejects duplicate nicknames", () => {
    const cast = { ...base, guessers: [{ nickname: "Wren", guess: "off", joinAfterMs: 1, voteAfterMs: 1 }] };
    expect(() => parseCast(cast)).toThrow(/unique/);
  });

  it("names the bad field", () => {
    expect(() => parseCast({ ...base, truth: "maybe" })).toThrow(/truth/);
  });
});

describe("roundScript", () => {
  it("orders votes by time and puts the reveal after the last vote", () => {
    const cast = parseCast(readJson("cast.json"));
    const script = roundScript(cast);
    const times = script.votes.map((v) => v.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(script.revealAtMs).toBe(Math.max(...times) + cast.revealAfterLastVoteMs);
  });
});

describe("coldOpenRead", () => {
  it("is the featured read, the same card that gets dealt, played and stamped", () => {
    const deckData = parseDeck(readJson("deck.json"));
    const cast = parseCast(readJson("cast.json"));
    const plan = planDeal(deckData, cast.featuredReadId);
    expect(plan.kind).toBe("pinned");
    expect(coldOpenRead(deckData, cast)).toEqual(plan.deck.reads[0]);
  });

  it("cast.json no longer carries a separate cold open read", () => {
    expect(readJson("cast.json")).not.toHaveProperty("coldOpenReadId");
  });
});
