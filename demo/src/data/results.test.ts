import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESULTS_FILE, loadResults, parseResults } from "./results";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "nailed-it-demo-results-"));

const complete = {
  horoscopeTest: {
    evidenceNote: "Same 40 evidence items",
    unit: "bits",
    base: { label: "Base model", read: "You sometimes doubt yourself.", infoGain: 0.01 },
    trained: { label: "Trained reader", read: "You rehearse calls and then improvise.", infoGain: 1.2 },
    difference: { value: 1.19, ciLow: 0.4, ciHigh: 1.9, level: 95 },
    caveat: "Measured on held-out decks.",
    sampleNote: "40 decks per reader",
  },
  learning: {
    trainingSet: { before: 40, after: 41 },
    procedure: { title: "Check the notes first", steps: ["Open notes", "Cross-check chats"] },
    recall: { nextPlayer: "Ada", stepsWithout: 20, stepsWith: 12 },
  },
};

describe("loadResults", () => {
  it("reports missing when results.json does not exist", () => {
    const dir = tempDir();
    expect(loadResults(dir)).toEqual({ kind: "missing", path: join(dir, RESULTS_FILE) });
  });

  it("never falls back to results.example.json", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "results.example.json"), JSON.stringify(complete));
    expect(loadResults(dir).kind).toBe("missing");
  });

  it("loads a valid results.json", () => {
    const dir = tempDir();
    writeFileSync(join(dir, RESULTS_FILE), JSON.stringify(complete));
    const loaded = loadResults(dir);
    expect(loaded.kind).toBe("loaded");
  });

  it("fails loudly on invalid JSON", () => {
    const dir = tempDir();
    writeFileSync(join(dir, RESULTS_FILE), "{ nope");
    expect(() => loadResults(dir)).toThrow(/results\.json.*not valid JSON/);
  });
});

describe("parseResults", () => {
  it("accepts nulls for every optional block", () => {
    expect(parseResults({ horoscopeTest: null, learning: null })).toEqual({ horoscopeTest: null, learning: null });
    expect(parseResults({})).toEqual({ horoscopeTest: null, learning: null });
  });

  it("accepts null info gain on either side", () => {
    const parsed = parseResults({
      horoscopeTest: {
        ...complete.horoscopeTest,
        base: { ...complete.horoscopeTest.base, infoGain: null },
      },
    });
    expect(parsed.horoscopeTest?.base.infoGain).toBeNull();
  });

  it("rejects a training set that shrinks", () => {
    expect(() =>
      parseResults({ learning: { ...complete.learning, trainingSet: { before: 10, after: 9 } } }),
    ).toThrow(/after/);
  });

  it("rejects placeholder values copied from the example file", () => {
    const example = JSON.parse(readFileSync(join(import.meta.dirname, "../../data/results.example.json"), "utf8"));
    expect(() => parseResults(example)).toThrow(/PLACEHOLDER/);
  });

  it("names the offending field on a schema error", () => {
    expect(() => parseResults({ horoscopeTest: { ...complete.horoscopeTest, unit: "furlongs" } })).toThrow(
      /horoscopeTest\.unit/,
    );
  });
});

const measured = {
  horoscopeTest: {
    evidenceNote: null,
    unit: "nats",
    base: { label: "Base model, untrained", read: null, infoGain: 0.054 },
    trained: { label: "Nailed It reader, step 5", read: null, infoGain: 0.169 },
    difference: { value: 0.114, ciLow: 0.001, ciHigh: 0.227, level: 95 },
    caveat: "Small gain. The 95% interval only just clears zero.",
    sampleNote: null,
  },
};

describe("measured results", () => {
  it("accepts null reads, a difference with its interval, and a caveat", () => {
    const parsed = parseResults(measured);
    expect(parsed.horoscopeTest?.base.read).toBeNull();
    expect(parsed.horoscopeTest?.difference).toEqual({ value: 0.114, ciLow: 0.001, ciHigh: 0.227, level: 95 });
  });

  it("defaults the new fields to null when absent", () => {
    const { difference: _d, caveat: _c, sampleNote: _s, ...older } = measured.horoscopeTest;
    const parsed = parseResults({ horoscopeTest: older });
    expect(parsed.horoscopeTest?.difference).toBeNull();
    expect(parsed.horoscopeTest?.caveat).toBeNull();
    expect(parsed.horoscopeTest?.sampleNote).toBeNull();
  });

  it("rejects a point estimate below its interval", () => {
    const bad = { horoscopeTest: { ...measured.horoscopeTest, difference: { value: 0.114, ciLow: 0.12, ciHigh: 0.227, level: 95 } } };
    expect(() => parseResults(bad)).toThrow(/difference\.ciLow \(0\.12\) is above difference\.value \(0\.114\)/);
  });

  it("rejects a point estimate above its interval", () => {
    const bad = { horoscopeTest: { ...measured.horoscopeTest, difference: { value: 0.3, ciLow: 0.001, ciHigh: 0.227, level: 95 } } };
    expect(() => parseResults(bad)).toThrow(/difference\.value \(0\.3\) is above difference\.ciHigh \(0\.227\)/);
  });

  it("accepts a difference that matches the two gains within rounding", () => {
    expect(() => parseResults(measured)).not.toThrow();
  });

  it("rejects a difference that contradicts the two gains by more than rounding", () => {
    const bad = { horoscopeTest: { ...measured.horoscopeTest, difference: { value: 0.2, ciLow: 0.001, ciHigh: 0.227, level: 95 } } };
    expect(() => parseResults(bad)).toThrow(/trained minus base is 0\.115.*difference\.value is 0\.2/);
  });

  it("only allows a 95 percent level", () => {
    const bad = { horoscopeTest: { ...measured.horoscopeTest, difference: { value: 0.114, ciLow: 0.001, ciHigh: 0.227, level: 90 } } };
    expect(() => parseResults(bad)).toThrow(/difference\.level/);
  });

  it("caps the caveat at 90 characters and the sample note at 60", () => {
    const long = { horoscopeTest: { ...measured.horoscopeTest, caveat: "x".repeat(91) } };
    expect(() => parseResults(long)).toThrow(/caveat/);
    const note = { horoscopeTest: { ...measured.horoscopeTest, sampleNote: "x".repeat(61) } };
    expect(() => parseResults(note)).toThrow(/sampleNote/);
  });
});

describe("results.example.json", () => {
  const example = readFileSync(join(import.meta.dirname, "../../data/results.example.json"), "utf8");

  it("matches the current schema once its placeholders are replaced", () => {
    const filled = JSON.parse(example.replace(/PLACEHOLDER[^"]*/g, "filled"));
    expect(() => parseResults(filled)).not.toThrow();
  });

  it("has reads, a difference, a caveat and a sample note, so every field is documented", () => {
    const raw = JSON.parse(example);
    expect(Object.keys(raw.horoscopeTest)).toEqual(
      expect.arrayContaining(["difference", "caveat", "sampleNote", "evidenceNote", "unit", "base", "trained"]),
    );
  });
});
