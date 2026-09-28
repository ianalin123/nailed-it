import type { ReactNode } from "react";
import { cx } from "./cx";

export type SlipSize = "hero" | "play" | "stage-xl" | "stage-lg" | "stage-md";

const TEXT: Record<SlipSize, string> = {
  hero: "text-[clamp(1.25rem,5vw,1.9rem)] leading-[1.22]",
  play: "text-[clamp(1.55rem,6.4vw,3.4rem)] leading-[1.18]",
  "stage-xl": "text-[4.4vw] leading-[1.14]",
  "stage-lg": "text-[3.5vw] leading-[1.16]",
  "stage-md": "text-[2.7vw] leading-[1.2]",
};

const isStage = (size: SlipSize): boolean => size.startsWith("stage");

type SlipProps = {
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  stamp?: ReactNode;
  feedKey?: string;
  size?: SlipSize;
};

export function Slip({ header, children, footer, stamp, feedKey, size = "play" }: SlipProps) {
  const stage = isStage(size);
  return (
    <figure
      key={feedKey}
      className={cx(
        "slip relative w-full rounded-t-md",
        stage ? "px-[2.6vw] pt-[2vw]" : "px-5 pt-5 sm:px-8 sm:pt-7",
        feedKey && "animate-feed",
      )}
    >
      {header ? (
        <div className={cx("font-machine text-ink/70", stage ? "mb-[1.2vw] text-[1.3vw]" : "mb-4 text-sm")}>{header}</div>
      ) : null}
      <blockquote className={cx("font-machine font-bold text-pretty", TEXT[size])}>{children}</blockquote>
      {footer ? <figcaption className="mt-5 font-machine text-base text-ink/80">{footer}</figcaption> : null}
      {stamp ? <div className={cx("pointer-events-none flex justify-end pr-1", stage ? "mt-[1.2vw]" : "mt-6")}>{stamp}</div> : null}
    </figure>
  );
}
