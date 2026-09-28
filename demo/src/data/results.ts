import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseWith, readJsonFile } from "./json";

export const RESULTS_FILE = "results.json";

const PLACEHOLDER_MARK = "PLACEHOLDER";

const text = (max: number) => z.string().trim().min(1).max(max);

const Reader = z.object({
  label: text(40),
  read: text(240),
  infoGain: z.number().finite().nullable().default(null),
});

const HoroscopeTest = z.object({
  evidenceNote: text(80).nullable().default(null),
  unit: z.enum(["bits", "nats"]),
  base: Reader,
  trained: Reader,
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
