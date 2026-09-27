import type { ReactNode } from "react";
import { cx } from "../cx";
import { fontU, u } from "./geometry";

type StageSlipProps = {
  header: string;
  text: string;
  sizeU: number;
  pad: { xU: number; topU: number; bottomU: number };
  stamp?: ReactNode;
  feedKey?: string;
};

export function StageSlip({ header, text, sizeU, pad, stamp, feedKey }: StageSlipProps) {
  return (
    <div className="relative">
      <figure
        key={feedKey}
        className={cx("slip rounded-t-md", feedKey && "animate-feed")}
        style={{ paddingLeft: u(pad.xU), paddingRight: u(pad.xU), paddingTop: u(pad.topU), paddingBottom: u(pad.bottomU) }}
      >
        <div className="font-machine text-ink/70" style={{ ...fontU(1.1), marginBottom: u(0.8) }}>
          {header}
        </div>
        <blockquote className="font-machine font-bold text-pretty" style={fontU(sizeU)}>
          {text}
        </blockquote>
      </figure>
      {stamp ? (
        <div className="pointer-events-none absolute" style={{ right: u(1.2), bottom: u(-2.6) }}>
          {stamp}
        </div>
      ) : null}
    </div>
  );
}
