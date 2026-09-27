import type { ReactNode } from "react";
import { cx } from "./cx";

type SlipProps = {
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  stamp?: ReactNode;
  feedKey?: string;
  size?: "hero" | "play";
};

export function Slip({ header, children, footer, stamp, feedKey, size = "play" }: SlipProps) {
  return (
    <figure
      key={feedKey}
      className={cx("slip relative w-full rounded-t-md px-5 pt-5 sm:px-8 sm:pt-7", feedKey && "animate-feed")}
    >
      {header ? <div className="mb-4 font-machine text-sm text-ink/70">{header}</div> : null}
      <blockquote
        className={cx(
          "font-machine font-bold text-pretty",
          size === "play"
            ? "text-[clamp(1.55rem,6.4vw,3.4rem)] leading-[1.18]"
            : "text-[clamp(1.25rem,5vw,1.9rem)] leading-[1.22]",
        )}
      >
        {children}
      </blockquote>
      {footer ? <figcaption className="mt-5 font-machine text-base text-ink/80">{footer}</figcaption> : null}
      {stamp ? <div className="pointer-events-none absolute right-3 bottom-8 sm:right-8">{stamp}</div> : null}
    </figure>
  );
}
