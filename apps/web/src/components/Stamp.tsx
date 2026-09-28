import type { CSSProperties } from "react";
import type { Truth } from "@nailed-it/protocol";
import { TRUTH_LABEL } from "@/lib/game/selectors";
import { STAMP_CHROME } from "@/lib/game/stageFit";
import { cx } from "./cx";

const INK: Record<Truth, string> = {
  nailed: "text-nailed border-nailed",
  partly: "text-[#c98400] border-[#c98400]",
  off: "text-ink border-ink",
};

const TILT: Record<Truth, number> = { nailed: -9, partly: 6, off: -4 };

const unit = (value: number): string => `calc(var(--u) * ${value})`;

type StampSize = "lg" | "sm" | { stageU: number };

const SIZE_CLASS = {
  lg: "border-[5px] px-4 py-2 text-[min(7.5vw,3.6rem)] mix-blend-multiply bg-slip/40",
  sm: "border-[3px] px-2 py-1 text-lg mix-blend-multiply bg-slip/40",
} as const;

const stageStyle = (sizeU: number): CSSProperties => ({
  fontSize: unit(sizeU),
  borderWidth: unit(STAMP_CHROME.borderU),
  paddingInline: unit(STAMP_CHROME.padXU),
  paddingBlock: unit(STAMP_CHROME.padYU),
});

type StampProps = { truth: Truth; animate?: boolean; size?: StampSize; tiltDeg?: number };

export function Stamp({ truth, animate = false, size = "lg", tiltDeg }: StampProps) {
  const tilt = `${tiltDeg ?? TILT[truth]}deg`;
  const sizing = typeof size === "string" ? { className: SIZE_CLASS[size], style: {} } : { className: "", style: stageStyle(size.stageU) };
  return (
    <span
      role="img"
      aria-label={`Stamped: ${TRUTH_LABEL[truth]}`}
      data-stamp={truth}
      style={{ ["--stamp-tilt" as string]: tilt, rotate: animate ? undefined : tilt, ...sizing.style }}
      className={cx(
        "wide inline-block rounded-lg font-black whitespace-nowrap uppercase leading-none",
        sizing.className,
        INK[truth],
        animate && "animate-stamp",
      )}
    >
      {TRUTH_LABEL[truth]}
    </span>
  );
}
