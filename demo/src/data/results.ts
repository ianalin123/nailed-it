import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseWith, readJsonFile } from "./json";

export const RESULTS_FILE = "results.json";

const PLACEHOLDER_MARK = "PLACEHOLDER";

const text = (max: number) => z.string().trim().min(1).max(max);

const Reader = z.object({
  label: text(40),
  read: text(240).nullable().default(null),
  infoGain: z.number().finite().nullable().default(null),
});

const Difference = z.object({
  value: z.number().finite(),
  ciLow: z.number().finite(),
  ciHigh: z.number().finite(),
  level: z.literal(95),
});

const decimalsOf = (n: number): number => {
  const text = String(n);
  if (text.includes("e")) return 6;
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
};

const roundingSlack = (...values: number[]): number => values.reduce((sum, v) => sum + 0.5 * 10 ** -decimalsOf(v), 0) + 1e-9;

const HoroscopeTest = z
  .object({
    evidenceNote: text(80).nullable().default(null),
    unit: z.enum(["bits", "nats"]),
    base: Reader,
    trained: Reader,
    difference: Difference.nullable().default(null),
    caveat: text(90).nullable().default(null),
    sampleNote: text(60).nullable().default(null),
  })
  .superRefine((test, ctx) => {
    const d = test.difference;
    if (d === null) return;
    if (d.ciLow > d.value) {
      ctx.addIssue({ code: "custom", path: ["difference", "ciLow"], message: `difference.ciLow (${d.ciLow}) is above difference.value (${d.value})` });
    }
    if (d.value > d.ciHigh) {
      ctx.addIssue({ code: "custom", path: ["difference", "value"], message: `difference.value (${d.value}) is above difference.ciHigh (${d.ciHigh})` });
    }
    const base = test.base.infoGain;
    const trained = test.trained.infoGain;
    if (base === null || trained === null) return;
    const implied = trained - base;
    if (Math.abs(implied - d.value) > roundingSlack(base, trained, d.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["difference", "value"],
        message: `trained minus base is ${Number(implied.toFixed(6))} (${trained} - ${base}), but difference.value is ${d.value}. They disagree by more than rounding.`,
      });
    }
  });

const TrainingSet = z
  .object({ before: z.number().int().min(0), after: z.number().int().min(0) })
  .refine((set) => set.after >= set.before, { message: "after must be at least before", path: ["after"] });

const Procedure = z.object({
  title: text(80),
  steps: z.array(text(90)).min(1).max(5),
});

const Recall = z.object({
  nextPlayer: text(20),
  stepsWithout: z.number().int().min(1).nullable().default(null),
  stepsWith: z.number().int().min(1).nullable().default(null),
});

const Learning = z.object({
  trainingSet: TrainingSet.nullable().default(null),
  procedure: Procedure.nullable().default(null),
  recall: Recall.nullable().default(null),
});

const ResultsSchema = z.object({
  horoscopeTest: HoroscopeTest.nullable().default(null),
  learning: Learning.nullable().default(null),
});

export type Results = z.infer<typeof ResultsSchema>;

export type ResultsLoad = { kind: "missing"; path: string } | { kind: "loaded"; path: string; results: Results };

const assertNoPlaceholders = (raw: unknown): void => {
  if (JSON.stringify(raw).includes(PLACEHOLDER_MARK)) {
    throw new Error(
      `${RESULTS_FILE} still contains ${PLACEHOLDER_MARK} values. Replace every placeholder with a real measured result, or set that field to null so its element is left out.`,
    );
  }
};

export const parseResults = (raw: unknown): Results => {
  assertNoPlaceholders(raw);
  return parseWith(ResultsSchema, raw, RESULTS_FILE);
};

export const loadResults = (dataDir: string): ResultsLoad => {
  const path = join(dataDir, RESULTS_FILE);
  if (!existsSync(path)) return { kind: "missing", path };
  return { kind: "loaded", path, results: parseResults(readJsonFile(path, RESULTS_FILE)) };
};
