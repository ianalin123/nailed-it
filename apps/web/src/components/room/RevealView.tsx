import {
  GUESS_LABEL,
  canAdvance,
  confidenceLine,
  hostOf,
  hotSeatPlayer,
  possessive,
  revealSummary,
  roundLabel,
  type GuessOutcome,
  type RevealRow,
} from "@/lib/game/selectors";
import { ActionButton } from "../ActionButton";
import { ChainList } from "../ChainList";
import { Slip } from "../Slip";
import { Stamp } from "../Stamp";
import { cx } from "../cx";
import { PlayerName } from "./PlayerName";
import type { ViewProps } from "./types";

const OUTCOME_LABEL: Record<GuessOutcome, string> = {
  correct: "Right",
  wrong: "Wrong",
  partly: "Partly counts",
  no_guess: "No guess",
};

function ResultRow({ row, viewerId }: { row: RevealRow; viewerId: string | undefined }) {
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <span className="min-w-0">
        <span className="block truncate text-xl font-bold">
          <PlayerName player={row.player} viewerId={viewerId} />
        </span>
        <span className="text-sm text-field-soft">
          {row.guess ? `Said ${GUESS_LABEL[row.guess].toLowerCase()}` : "Didn't guess"}. {OUTCOME_LABEL[row.outcome]}.
        </span>
      </span>
      <span
        className={cx(
          "wide shrink-0 text-2xl font-black tabular-nums",
          row.points > 0 ? "text-white" : "text-field-soft/70",
        )}
      >
        +{row.points}
      </span>
    </li>
  );
}

export function RevealView({ room, viewerId, send }: ViewProps) {
  const round = room.round;
  const summary = revealSummary(room);
  if (!round || !summary) return null;
  const hotSeat = hotSeatPlayer(room);
  const host = hostOf(room);
  const isLast = round.index + 1 >= round.total;
  const confidence = confidenceLine(summary.readerConfidence);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="wide font-black leading-[0.95] text-[clamp(2.2rem,10vw,4.5rem)] text-balance wrap-anywhere">
        {hotSeat?.id === viewerId ? "Your verdict" : `${possessive(hotSeat?.nickname ?? "Their")} verdict`}
      </h1>
      <div className="flex flex-col gap-3">
        <Slip header={roundLabel(round)} stamp={<Stamp key={round.read.id} truth={summary.truth} animate />}>
          {round.read.text}
        </Slip>
        {confidence ? <p className="font-machine text-lg text-field-soft">{confidence}</p> : null}
      </div>
      <section>
        <h2 className="wide border-b-2 border-field-soft/30 pb-2 text-2xl font-extrabold">This round</h2>
        <ul className="divide-y divide-field-soft/20">
          {summary.rows.map((row) => (
            <ResultRow key={row.player.id} row={row} viewerId={viewerId} />
          ))}
        </ul>
      </section>
      <ChainList chain={round.chain} readText={round.read.text} scale="phone" />
      {canAdvance(room, viewerId) ? (
        <ActionButton tone="primary" big onClick={() => send({ type: "next" })}>
          {isLast ? "See final scores" : "Next card"}
        </ActionButton>
      ) : (
        <p className="text-center text-field-soft">
          Waiting for {host?.nickname ?? "the host"} to {isLast ? "show final scores" : "deal the next card"}.
        </p>
      )}
    </div>
  );
}
