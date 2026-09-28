import type { Results, ResultsLoad } from "../data/results";

export const ALL_BEATS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type BeatId = (typeof ALL_BEATS)[number];

export const BEAT_NAMES: Record<BeatId, string> = {
  1: "cold-open",
  2: "join",
  3: "scan",
  4: "horoscope-test",
  5: "play",
  6: "how-it-knew",
  7: "it-just-learned",
  8: "close",
};

export const APP_BEATS: readonly BeatId[] = [2, 5, 6];

export const isBeatId = (value: number): value is BeatId => (ALL_BEATS as readonly number[]).includes(value);

export const beatLabel = (beat: BeatId): string => `beat ${beat} (${BEAT_NAMES[beat]})`;

export type Omission = { beat: BeatId; reason: string };
export type BeatPlan = { beats: BeatId[]; omitted: Omission[] };

const hasLearningContent = (learning: NonNullable<Results["learning"]>): boolean =>
  learning.trainingSet !== null || learning.procedure !== null;

const resultOmission = (beat: BeatId, load: ResultsLoad): string | undefined => {
  if (beat !== 4 && beat !== 7) return undefined;
  if (load.kind === "missing") return `${load.path} does not exist, so there are no measured results to show`;
  if (beat === 4 && load.results.horoscopeTest === null) return "results.json has horoscopeTest: null";
  if (beat === 7) {
    const learning = load.results.learning;
    if (learning === null) return "results.json has learning: null";
    if (!hasLearningContent(learning)) return "results.json learning has neither trainingSet nor procedure";
  }
  return undefined;
};

export const planBeats = (requested: readonly BeatId[], load: ResultsLoad): BeatPlan => {
  const wanted = ALL_BEATS.filter((beat) => requested.includes(beat));
  const omitted: Omission[] = [];
  const beats: BeatId[] = [];
  for (const beat of wanted) {
    const reason = resultOmission(beat, load);
    if (reason === undefined) beats.push(beat);
    else omitted.push({ beat, reason });
  }
  return { beats, omitted };
};

export const needsRecording = (beats: readonly BeatId[]): boolean => beats.some((beat) => APP_BEATS.includes(beat));

export type RecordingFacts = { hasChain: boolean };

export const finalizeAppBeats = (beats: readonly BeatId[], facts: RecordingFacts): BeatPlan => {
  if (facts.hasChain || !beats.includes(6)) return { beats: [...beats], omitted: [] };
  return {
    beats: beats.filter((beat) => beat !== 6),
    omitted: [{ beat: 6, reason: "the recorded round had no \"How it knew\" chain on the stage" }],
  };
};
