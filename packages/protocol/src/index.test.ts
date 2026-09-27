import { describe, expect, it } from "vitest";
import { Deck, PROTOCOL_VERSION, Read, VerdictRecord, parseClientMessage } from "./index";

const read: Read = {
  id: "r1",
  text: "You think by talking out loud, alone, into a recorder.",
  category: "work_style",
  confidence: 0.7,
  evidenceIds: ["e1"],
  hops: 2,
  modelVersion: "teacher-v0",
};

describe("protocol", () => {
  it("accepts a valid guess message", () => {
    const result = parseClientMessage({ type: "guess", readId: "r1", guess: "nailed" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown message type", () => {
    const result = parseClientMessage({ type: "cheat", readId: "r1" });
    expect(result.success).toBe(false);
  });

  it("rejects a guess outside the allowed values", () => {
    const result = parseClientMessage({ type: "guess", readId: "r1", guess: "partly" });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside the unit interval", () => {
    expect(Read.safeParse({ ...read, confidence: 1.2 }).success).toBe(false);
  });

  it("requires at least three reads in a deck", () => {
    const deck = { protocolVersion: PROTOCOL_VERSION, digestId: "d1", reads: [read] };
    expect(Deck.safeParse(deck).success).toBe(false);
  });

  it("round-trips a verdict record through JSON", () => {
    const record: VerdictRecord = {
      protocolVersion: PROTOCOL_VERSION,
      roomCode: "ABCD",
      recordedAt: "2026-09-27T23:00:00.000Z",
      digestId: "d1",
      read,
      truth: "nailed",
      guessCounts: { nailed: 2, off: 3 },
    };
    const parsed = VerdictRecord.parse(JSON.parse(JSON.stringify(record)));
    expect(parsed).toEqual(record);
  });
});
