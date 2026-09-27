import type { CSSProperties } from "react";
import type { Box } from "@/lib/game/stageFit";

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

export const REVEAL = {
  leftU: 52,
  gapU: 3,
  headingU: 2.8,
  readBox: { widthU: 47, heightU: 13 } satisfies Box,
  readSteps: [2.8, 2.4, 2.0, 1.7, 1.45, 1.25],
  stampU: 3.2,
  confidenceU: 1.5,
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
