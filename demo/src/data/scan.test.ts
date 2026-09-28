import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deadEnds, parseScan } from "./scan";

const shipped = (): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "../../data/scan.json"), "utf8"));

const minimal = {
  subject: "Pat",
  note: null,
  sources: [{ id: "s", label: "Notes" }, { id: "t", label: "Git" }],
  evidence: [
    { id: "e1", source: "s", text: "one" },
    { id: "e2", source: "t", text: "two" },
  ],
  inferences: [{ id: "i1", from: ["e1"], text: "so" }],
  reads: [{ id: "r1", from: ["i1"], text: "read" }],
};

describe("parseScan", () => {
  it("accepts the shipped example", () => {
    expect(parseScan(shipped()).reads.length).toBeGreaterThan(0);
  });

  it("rejects evidence from an unknown source", () => {
    const bad = { ...minimal, evidence: [{ id: "e1", source: "nope", text: "x" }] };
    expect(() => parseScan(bad)).toThrow(/unknown source "nope"/);
  });

  it("rejects an inference citing unknown evidence", () => {
    const bad = { ...minimal, inferences: [{ id: "i1", from: ["e9"], text: "so" }] };
    expect(() => parseScan(bad)).toThrow(/i1.*e9/);
  });

  it("lets a read cite evidence or inferences", () => {
    const direct = { ...minimal, reads: [{ id: "r1", from: ["e2", "i1"], text: "read" }] };
    expect(parseScan(direct).reads[0]?.from).toEqual(["e2", "i1"]);
  });

  it("rejects duplicate ids across kinds", () => {
    const bad = { ...minimal, inferences: [{ id: "e1", from: ["e1"], text: "so" }] };
    expect(() => parseScan(bad)).toThrow(/duplicate id "e1"/);
  });
});

describe("deadEnds", () => {
  it("is the evidence nothing leads from", () => {
    expect(deadEnds(parseScan(minimal))).toEqual(["e2"]);
  });

  it("counts evidence used directly by a read", () => {
    const direct = { ...minimal, reads: [{ id: "r1", from: ["e2", "i1"], text: "read" }] };
    expect(deadEnds(parseScan(direct))).toEqual([]);
  });
});
