import type { CSSProperties } from "react";
import { presentChain, stageReadSize } from "@/lib/game/chain";
import {
  GUESS_LABEL,
  confidenceLine,
  hotSeatPlayer,
  possessive,
  revealSummary,
  roundLabel,
  type RevealRow,
} from "@/lib/game/selectors";
import { ChainList } from "../ChainList";
import { Slip, type SlipSize } from "../Slip";
import { Stamp } from "../Stamp";
import { cx } from "../cx";
import type { StageProps } from "./types";

const REVEAL_SIZE = { xl: "stage-lg", lg: "stage-md", md: "stage-md" } as const satisfies Record<string, SlipSize>;

export const REVEAL_TIMING = { resultsAt: 900, resultStep: 220, afterResults: 500, chainStep: 900 };

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

function ResultRow({ row, at, compact }: { row: RevealRow; at: number; compact: boolean }) {
  return (
    <li
      style={delay(at)}
      className={cx(
        "animate-feed flex items-baseline justify-between gap-[1vw] border-b-[0.12vw] border-field-soft/20",
        compact ? "py-[0.35vw] text-[1.55vw]" : "py-[0.6vw] text-[2.2vw]",
      )}
    >
      <span className="min-w-0 truncate font-bold">
        {row.player.nickname}
        <span className="font-normal text-field-soft">
          {" "}
          {row.guess ? `said ${GUESS_LABEL[row.guess].toLowerCase()}` : "didn't guess"}
        </span>
      </span>
      <span className={cx("wide shrink-0 font-black tabular-nums", row.points > 0 ? "text-white" : "text-field-soft/70")}>
        +{row.points}
      </span>
    </li>
  );
}

export function StageReveal({ room }: StageProps) {
  const round = room.round;
  const summary = revealSummary(room);
  if (!round || !summary) return null;
  const hotSeat = hotSeatPlayer(room);
  const hasChain = presentChain(round.chain, round.read.text).length > 0;
  const confidence = confidenceLine(summary.readerConfidence);
  const confidenceAt = REVEAL_TIMING.resultsAt + summary.rows.length * REVEAL_TIMING.resultStep + REVEAL_TIMING.afterResults;
  const chainAt = confidenceAt + REVEAL_TIMING.afterResults;

  const results = (
    <ol className={cx("grid gap-x-[2vw]", hasChain && summary.rows.length > 4 ? "grid-cols-2" : "grid-cols-1")}>
      {summary.rows.map((row, index) => (
        <ResultRow
          key={row.player.id}
          row={row}
          compact={hasChain}
          at={REVEAL_TIMING.resultsAt + index * REVEAL_TIMING.resultStep}
        />
      ))}
    </ol>
  );

  return (
    <div className="grid flex-1 grid-cols-2 gap-[3vw]">
      <div className="flex min-w-0 flex-col gap-[1.4vw]">
        <h1 className="wide text-[3.4vw] font-black leading-none wrap-anywhere">
          {possessive(hotSeat?.nickname ?? "Their")} verdict
        </h1>
        <Slip
          header={roundLabel(round)}
          size={REVEAL_SIZE[stageReadSize(round.read.text)]}
          stamp={<Stamp key={round.read.id} truth={summary.truth} size="stage" animate />}
        >
          {round.read.text}
        </Slip>
        {confidence ? (
          <p style={delay(confidenceAt)} className="animate-feed font-machine text-[1.9vw] text-field-soft">
            {confidence}
          </p>
        ) : null}
        {hasChain ? results : null}
      </div>
      <div className="flex min-w-0 flex-col gap-[1.4vw] pt-[4.8vw]">
        {hasChain ? (
          <ChainList
            chain={round.chain}
            readText={round.read.text}
            scale="stage"
            animate
            startDelayMs={chainAt}
            stepDelayMs={REVEAL_TIMING.chainStep}
          />
        ) : (
          results
        )}
      </div>
    </div>
  );
}
