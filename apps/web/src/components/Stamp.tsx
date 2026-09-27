import type { Truth } from "@nailed-it/protocol";
import { TRUTH_LABEL } from "@/lib/game/selectors";
import { cx } from "./cx";

const INK: Record<Truth, string> = {
  nailed: "text-nailed border-nailed",
  partly: "text-[#c98400] border-[#c98400]",
  off: "text-ink border-ink",
};

const TILT: Record<Truth, string> = { nailed: "-9deg", partly: "6deg", off: "-4deg" };

type StampSize = "stage" | "lg" | "sm";

const SIZE: Record<StampSize, string> = {
  stage: "border-[0.45vw] px-[1.6vw] py-[0.7vw] text-[5vw]",
  lg: "border-[5px] px-4 py-2 text-[clamp(2rem,9vw,3.6rem)]",
  sm: "border-[3px] px-2 py-1 text-lg",
};

type StampProps = { truth: Truth; animate?: boolean; size?: StampSize };

export function Stamp({ truth, animate = false, size = "lg" }: StampProps) {
  return (
    <span
      role="img"
      aria-label={`Stamped: ${TRUTH_LABEL[truth]}`}
      style={{ ["--stamp-tilt" as string]: TILT[truth], rotate: animate ? undefined : TILT[truth] }}
      className={cx(
        "wide inline-block rounded-lg bg-slip/40 font-black uppercase leading-none mix-blend-multiply",
        SIZE[size],
        INK[truth],
        animate && "animate-stamp",
      )}
    >
      {TRUTH_LABEL[truth]}
    </span>
  );
}
