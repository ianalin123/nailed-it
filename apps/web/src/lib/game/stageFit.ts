import type { PresentedStep } from "./chain";

// Stage layout is measured in "u": 1u = min(1vw, 1.7778vh), so 100u is the width of a 16:9 frame
// and 56.25u its height. At 1920x1080, 1u = 19.2px. 0.9u is 1.6vh at 1080p, the readable floor.
export const STAGE_FLOOR_U = 0.9;

const LINE_HEIGHT = 1.25;
const CHAR_WIDTH_EM = 0.6;
const WRAP_SLACK = 1.15;

export type Box = { widthU: number; heightU: number };

export const estimateBlockHeight = (
  length: number,
  box: Pick<Box, "widthU">,
  sizeU: number,
  lineHeight: number = LINE_HEIGHT,
): number => {
  const perLine = Math.max(1, Math.floor(box.widthU / (sizeU * CHAR_WIDTH_EM)));
  const lines = Math.max(1, Math.ceil((length * WRAP_SLACK) / perLine));
  return lines * sizeU * lineHeight;
};

const readableSteps = (steps: readonly number[]): number[] =>
  [...new Set(steps.map((step) => Math.max(STAGE_FLOOR_U, step)))].sort((a, b) => b - a);

export type TypeSize = { sizeU: number; fits: boolean };

export const pickTypeSize = (length: number, box: Box, steps: readonly number[]): TypeSize => {
  const sizes = readableSteps(steps);
  const fitting = sizes.find((sizeU) => estimateBlockHeight(length, box, sizeU) <= box.heightU);
  if (fitting !== undefined) return { sizeU: fitting, fits: true };
  return { sizeU: sizes.at(-1) ?? STAGE_FLOOR_U, fits: false };
};

export type ResultsLayout = { columns: 1 | 2; shown: number; hidden: number };

export const resultsLayout = (count: number, rowsPerColumn: number, maxColumns: 1 | 2): ResultsLayout => {
  if (count <= rowsPerColumn) return { columns: 1, shown: count, hidden: 0 };
  const capacity = rowsPerColumn * maxColumns;
  if (count <= capacity) return { columns: maxColumns, shown: count, hidden: 0 };
  const shown = capacity - 1;
  return { columns: maxColumns, shown, hidden: count - shown };
};

export const leaderboardColumns = (count: number): 1 | 2 => (count > 6 ? 2 : 1);

const VOTER_LIST_U = 34;
const VOTER_ROW_CHROME_U = 1.1;
const VOTER_MAX_U = 1.7;

export const voterRowSize = (count: number): number => {
  const fitted = (VOTER_LIST_U / Math.max(1, count) - VOTER_ROW_CHROME_U) / 1.3;
  return Math.max(STAGE_FLOOR_U, Math.min(VOTER_MAX_U, fitted));
};

export const CHAIN_SIZES_U: readonly number[] = [1.9, 1.7, 1.5, 1.3, 1.1, STAGE_FLOOR_U];
const STEP_CHROME_U = 1.5;
const STEP_PADDING_X_U = 1.8;
const LABEL_EM = 4.4;

export type ChainItem = PresentedStep | { kind: "more"; count: number };
export type FittedChain = { sizeU: number; items: ChainItem[]; hidden: number; heightU: number };

export const chainLabelWidthU = (sizeU: number): number => sizeU * LABEL_EM;

const stepHeight = (step: PresentedStep, widthU: number, sizeU: number): number => {
  const textWidth = widthU - chainLabelWidthU(sizeU) - STEP_PADDING_X_U;
  return estimateBlockHeight(step.text.length, { widthU: textWidth }, sizeU) + STEP_CHROME_U;
};

const markerHeight = (sizeU: number): number => sizeU * LINE_HEIGHT + STEP_CHROME_U;

const totalHeight = (steps: readonly PresentedStep[], widthU: number, sizeU: number): number =>
  steps.reduce((sum, step) => sum + stepHeight(step, widthU, sizeU), 0);

const truncateChain = (steps: readonly PresentedStep[], box: Box, sizeU: number): FittedChain => {
  const read = steps.filter((step) => step.kind === "read");
  const lastInference = steps.filter((step) => step.kind === "inference").slice(-1);
  const tail = [...lastInference, ...read];
  let used = totalHeight(tail, box.widthU, sizeU) + markerHeight(sizeU);
  const evidence: PresentedStep[] = [];
  for (const step of steps.filter((candidate) => candidate.kind === "evidence")) {
    const height = stepHeight(step, box.widthU, sizeU);
    if (used + height > box.heightU) break;
    evidence.push(step);
    used += height;
  }
  const hidden = steps.length - evidence.length - tail.length;
  return { sizeU, items: [...evidence, { kind: "more", count: hidden }, ...tail], hidden, heightU: used };
};

export const fitChain = (steps: readonly PresentedStep[], box: Box, sizes: readonly number[] = CHAIN_SIZES_U): FittedChain => {
  if (steps.length === 0) return { sizeU: STAGE_FLOOR_U, items: [], hidden: 0, heightU: 0 };
  for (const sizeU of readableSteps(sizes)) {
    const heightU = totalHeight(steps, box.widthU, sizeU);
    if (heightU <= box.heightU) return { sizeU, items: [...steps], hidden: 0, heightU };
  }
  return truncateChain(steps, box, STAGE_FLOOR_U);
};

// Stamp label metrics: extra-wide black caps, measured generously so the box is never too small.
export const STAMP_CHAR_EM = 0.9;
export const STAMP_CHROME = { padXU: 1.1, padYU: 0.45, borderU: 0.35 } as const;

export type Footprint = { widthU: number; heightU: number };

export const stampFootprint = (label: string, sizeU: number, tiltDeg: number): Footprint => {
  const width = label.length * STAMP_CHAR_EM * sizeU + 2 * (STAMP_CHROME.padXU + STAMP_CHROME.borderU);
  const height = sizeU + 2 * (STAMP_CHROME.padYU + STAMP_CHROME.borderU);
  const radians = (Math.abs(tiltDeg) * Math.PI) / 180;
  return {
    widthU: width * Math.cos(radians) + height * Math.sin(radians),
    heightU: width * Math.sin(radians) + height * Math.cos(radians),
  };
};
