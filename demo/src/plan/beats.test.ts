import { describe, expect, it } from "vitest";
import type { Results, ResultsLoad } from "../data/results";
import { ALL_BEATS, finalizeAppBeats, needsRecording, planBeats } from "./beats";

const full: Results = {
  horoscopeTest: {
    evidenceNote: null,
    unit: "bits",
    base: { label: "Base model", read: "You sometimes doubt yourself.", infoGain: 0.02 },
    trained: { label: "Trained reader", read: "You rehearse calls and then improvise.", infoGain: 1.1 },
    difference: null,
    caveat: null,
    sampleNote: null,
  },
  learning: {
    trainingSet: { before: 40, after: 41 },
    procedure: { title: "Notes first", steps: ["Open notes"] },
    recall: null,
  },
};

const loaded = (results: Results): ResultsLoad => ({ kind: "loaded", path: "/x/results.json", results });
const missing: ResultsLoad = { kind: "missing", path: "/x/results.json" };

describe("planBeats", () => {
  it("renders every beat when results are complete", () => {
    expect(planBeats(ALL_BEATS, loaded(full)).beats).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("omits beats 4 and 7 when results.json is missing", () => {
    const plan = planBeats(ALL_BEATS, missing);
    expect(plan.beats).toEqual([1, 2, 3, 5, 6, 8]);
    expect(plan.omitted.map((o) => o.beat)).toEqual([4, 7]);
    expect(plan.omitted[0]?.reason).toMatch(/results\.json/);
  });

  it("omits beat 4 when the horoscope test is null", () => {
    expect(planBeats(ALL_BEATS, loaded({ ...full, horoscopeTest: null })).beats).not.toContain(4);
  });

  it("keeps beat 4 with no reads when there are numbers to show", () => {
    const test = full.horoscopeTest!;
    const numbers = { ...test, base: { ...test.base, read: null }, trained: { ...test.trained, read: null } };
    expect(planBeats(ALL_BEATS, loaded({ ...full, horoscopeTest: numbers })).beats).toContain(4);
  });

  it("omits beat 4 when there are neither reads, gains nor a difference", () => {
    const test = full.horoscopeTest!;
    const empty = { ...test, base: { ...test.base, read: null, infoGain: null }, trained: { ...test.trained, read: null, infoGain: null } };
    const plan = planBeats(ALL_BEATS, loaded({ ...full, horoscopeTest: empty }));
    expect(plan.beats).not.toContain(4);
    expect(plan.omitted.find((o) => o.beat === 4)?.reason).toMatch(/nothing to show/);
  });

  it("omits beat 7 when learning is null", () => {
    expect(planBeats(ALL_BEATS, loaded({ ...full, learning: null })).beats).not.toContain(7);
  });

  it("omits beat 7 when neither the training set nor the procedure is present", () => {
    const learning = { trainingSet: null, procedure: null, recall: null };
    expect(planBeats(ALL_BEATS, loaded({ ...full, learning })).beats).not.toContain(7);
  });

  it("keeps beat 7 with only a procedure", () => {
    const learning = { trainingSet: null, procedure: { title: "t", steps: ["s"] }, recall: null };
    expect(planBeats(ALL_BEATS, loaded({ ...full, learning })).beats).toContain(7);
  });

  it("respects a requested subset and keeps film order", () => {
    expect(planBeats([6, 1, 5], loaded(full)).beats).toEqual([1, 5, 6]);
  });

  it("does not report beats that were never requested as omitted", () => {
    expect(planBeats([1, 2], missing).omitted).toEqual([]);
  });
});

describe("needsRecording", () => {
  it("is true only when an app beat is planned", () => {
    expect(needsRecording([1, 3, 8])).toBe(false);
    expect(needsRecording([1, 6])).toBe(true);
  });
});

describe("finalizeAppBeats", () => {
  it("drops beat 6 when the recording has no chain", () => {
    const result = finalizeAppBeats([1, 5, 6], { hasChain: false });
    expect(result.beats).toEqual([1, 5]);
    expect(result.omitted[0]?.beat).toBe(6);
  });

  it("keeps beat 6 when the chain was captured", () => {
    expect(finalizeAppBeats([5, 6], { hasChain: true }).beats).toEqual([5, 6]);
  });
});
