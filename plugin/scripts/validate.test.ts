import { describe, expect, it } from "vitest";
import type { Deck, EvidenceDigest, Read } from "@nailed-it/protocol";
import { PROTOCOL_VERSION } from "@nailed-it/protocol";
import { detectKind, parseArgs, validateData, validateJsonText } from "./validate";

const validDigest: EvidenceDigest = {
  protocolVersion: PROTOCOL_VERSION,
  digestId: "digest-1",
  displayName: "Fictional Priya",
  createdAt: "2026-09-27T00:00:00.000Z",
  items: [
    { id: "e1", source: "git_history", text: "Refactors in small, well-named commits." },
  ],
};

const validRead: Read = {
  id: "r1",
  text: "You default to small composable functions before reaching for a framework.",
  category: "technical_identity",
  confidence: 0.62,
  evidenceIds: ["e1"],
  hops: 2,
  modelVersion: "teacher-v0",
};

const validDeck: Deck = {
  protocolVersion: PROTOCOL_VERSION,
  digestId: "digest-1",
  reads: [validRead, { ...validRead, id: "r2" }, { ...validRead, id: "r3" }],
};

describe("detectKind", () => {
  it("detects a deck from a reads field", () => {
    expect(detectKind(validDeck)).toBe("deck");
  });

  it("detects a digest from an items field", () => {
    expect(detectKind(validDigest)).toBe("digest");
  });

  it("returns undefined for shapes with neither field", () => {
    expect(detectKind({ foo: "bar" })).toBeUndefined();
  });

  it("returns undefined for non-objects", () => {
    expect(detectKind("just a string")).toBeUndefined();
    expect(detectKind(null)).toBeUndefined();
    expect(detectKind(42)).toBeUndefined();
  });
});

describe("validateData: digest", () => {
  it("accepts a valid digest", () => {
    const result = validateData(validDigest);
    expect(result).toEqual({ valid: true, kind: "digest", errors: [] });
  });

  it("rejects a digest with zero items", () => {
    const result = validateData({ ...validDigest, items: [] });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe("digest");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports the exact field path for a bad item", () => {
    const result = validateData({
      ...validDigest,
      items: [{ id: "e1", source: "not_a_real_source", text: "x" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "items.0.source")).toBe(true);
  });

  it("rejects a display name over 40 characters", () => {
    const result = validateData({
      ...validDigest,
      displayName: "x".repeat(41),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "displayName")).toBe(true);
  });
});

describe("validateData: deck", () => {
  it("accepts a valid deck", () => {
    const result = validateData(validDeck);
    expect(result).toEqual({ valid: true, kind: "deck", errors: [] });
  });

  it("rejects a deck with fewer than three reads", () => {
    const result = validateData({ ...validDeck, reads: [validRead] });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe("deck");
  });

  it("rejects a read with confidence outside the unit interval", () => {
    const result = validateData({
      ...validDeck,
      reads: [{ ...validRead, confidence: 1.4 }, { ...validRead, id: "r2" }, { ...validRead, id: "r3" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "reads.0.confidence")).toBe(true);
  });

  it("rejects a read with negative hops", () => {
    const result = validateData({
      ...validDeck,
      reads: [{ ...validRead, hops: -1 }, { ...validRead, id: "r2" }, { ...validRead, id: "r3" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "reads.0.hops")).toBe(true);
  });

  it("rejects a wrong protocol version", () => {
    const result = validateData({ ...validDeck, protocolVersion: 2 });
    expect(result.valid).toBe(false);
  });
});

describe("validateData: ambiguous shape", () => {
  it("fails clearly when the shape has neither items nor reads and no kind hint is given", () => {
    const result = validateData({ foo: "bar" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/items.*reads/);
  });

  it("respects an explicit kind override even against a mismatched shape", () => {
    const result = validateData(validDigest, "deck");
    expect(result.valid).toBe(false);
    expect(result.kind).toBe("deck");
  });
});

describe("validateJsonText", () => {
  it("reports invalid JSON distinctly from schema errors", () => {
    const result = validateJsonText("{ not json");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/Invalid JSON/);
  });

  it("parses and validates well-formed JSON text", () => {
    const result = validateJsonText(JSON.stringify(validDeck));
    expect(result.valid).toBe(true);
    expect(result.kind).toBe("deck");
  });
});

describe("parseArgs", () => {
  it("parses a bare file path with no --type", () => {
    expect(parseArgs(["digest.json"])).toEqual({ filePath: "digest.json", kind: undefined });
  });

  it("parses --type deck", () => {
    expect(parseArgs(["deck.json", "--type", "deck"])).toEqual({
      filePath: "deck.json",
      kind: "deck",
    });
  });

  it("throws on an unrecognized --type value", () => {
    expect(() => parseArgs(["x.json", "--type", "bogus"])).toThrow();
  });

  it("throws when no file path is given", () => {
    expect(() => parseArgs([])).toThrow();
  });
});
