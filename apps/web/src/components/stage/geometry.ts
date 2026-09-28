import type { CSSProperties } from "react";
import type { Truth } from "@nailed-it/protocol";
import { TRUTH_LABEL } from "@/lib/game/selectors";
import { stampFootprint, type Box, type Footprint } from "@/lib/game/stageFit";

export const u = (value: number): string => `calc(var(--u) * ${value})`;
export const fontU = (value: number, lineHeight = 1.25): CSSProperties => ({ fontSize: u(value), lineHeight });

export const FRAME = { widthU: 100, heightU: 56.25, padXU: 3, padYU: 2, barU: 2.2, gapU: 1.4 } as const;
export const CONTENT = { widthU: 94, heightU: 48 } as const;

export const VOTING = {
  asideU: 22,
  gapU: 3,
  headingU: 3.2,
  readBox: { widthU: 64, heightU: 35 } satisfies Box,
  readSteps: [4.4, 3.8, 3.2, 2.7, 2.2, 1.8],
} as const;

export const STAGE_STAMP_TILT: Record<Truth, number> = { nailed: -5, partly: 4, off: -3 };

export const SLIP_CHROME = { padXU: 2.2, padTopU: 1.6, headerU: 2.2, toothU: 0.8, padBottomU: 0.6 } as const;

export const REVEAL = {
  leftU: 52,
  gapU: 3,
  headingU: 2.8,
  headingGapU: 1.2,
  readBox: { widthU: 47, heightU: 12 } satisfies Box,
  readSteps: [2.8, 2.4, 2.0, 1.7, 1.45, 1.25],
  stampU: 2.8,
  footerGapU: 1,
  footerTopU: 0.8,
  confidenceU: 1.5,
  confidenceMinWidthU: 14,
  resultsTopU: 1.2,
  resultRowU: 2.5,
  resultsLeft: { rowFontU: 1.5, rowsPerColumn: 7 },
  resultsRight: { rowFontU: 2.1, rowsPerColumn: 11 },
  chainHeadingU: 1.8,
  chainBox: { widthU: 39, heightU: 45 } satisfies Box,
} as const;

export const FINISHED = {
  headingU: 4,
  rowFontU: { single: 2.2, double: 1.8, winner: 2.8 },
  accuracyBox: { widthU: 31, heightU: 30 } satisfies Box,
  accuracySteps: [3.4, 2.8, 2.2, 1.8],
} as const;

export const stageStampZone = (): Footprint => {
  const footprints = (Object.keys(STAGE_STAMP_TILT) as Truth[]).map((truth) =>
    stampFootprint(TRUTH_LABEL[truth], REVEAL.stampU, STAGE_STAMP_TILT[truth]),
  );
  return {
    widthU: Math.max(...footprints.map((footprint) => footprint.widthU)),
    heightU: Math.max(...footprints.map((footprint) => footprint.heightU)),
  };
};

export const revealSlipInnerWidthU = (): number => REVEAL.leftU - 2 * SLIP_CHROME.padXU;

export const revealSlipHeightU = (): number =>
  SLIP_CHROME.padTopU +
  SLIP_CHROME.headerU +
  REVEAL.readBox.heightU +
  REVEAL.footerTopU +
  stageStampZone().heightU +
  SLIP_CHROME.toothU +
  SLIP_CHROME.padBottomU;

export const revealLeftColumnU = (): number =>
  REVEAL.headingU +
  REVEAL.headingGapU +
  revealSlipHeightU() +
  REVEAL.resultsTopU +
  REVEAL.resultsLeft.rowsPerColumn * REVEAL.resultRowU;
