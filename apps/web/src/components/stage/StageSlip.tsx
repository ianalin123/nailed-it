import type { CSSProperties, ReactNode } from "react";
import type { Footprint } from "@/lib/game/stageFit";
import { cx } from "../cx";
import { SLIP_CHROME, fontU, u } from "./geometry";

type SlipFooter = { confidence: string | undefined; confidenceU: number; stamp: ReactNode; zone: Footprint; topU: number; gapU: number };

type StageSlipProps = {
  header: string;
  text: string;
  sizeU: number;
  pad: { xU: number; topU: number; bottomU: number };
  footer?: SlipFooter;
  feedKey?: string;
};

const toothStyle = { ["--tooth" as string]: u(SLIP_CHROME.toothU) } as CSSProperties;

export function StageSlip({ header, text, sizeU, pad, footer, feedKey }: StageSlipProps) {
  const bottom = footer ? SLIP_CHROME.toothU + SLIP_CHROME.padBottomU : pad.bottomU;
  return (
    <figure
      key={feedKey}
      data-slip
      className={cx("slip rounded-t-md", feedKey && "animate-feed")}
      style={{ ...toothStyle, paddingLeft: u(pad.xU), paddingRight: u(pad.xU), paddingTop: u(pad.topU), paddingBottom: u(bottom) }}
    >
      <div className="font-machine text-ink/70" style={{ ...fontU(1.1), marginBottom: u(0.8) }}>
        {header}
      </div>
      <blockquote data-read-text className="font-machine font-bold text-pretty" style={fontU(sizeU)}>
        {text}
      </blockquote>
      {footer ? (
        <div className="flex items-end justify-between" style={{ marginTop: u(footer.topU), height: u(footer.zone.heightU), gap: u(footer.gapU) }}>
          <p data-confidence className="min-w-0 flex-1 font-machine text-ink/80" style={fontU(footer.confidenceU)}>
            {footer.confidence ?? ""}
          </p>
          <div
            data-stamp-slot
            className="flex shrink-0 items-center justify-center"
            style={{ width: u(footer.zone.widthU), height: u(footer.zone.heightU) }}
          >
            {footer.stamp}
          </div>
        </div>
      ) : null}
    </figure>
  );
}
