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
