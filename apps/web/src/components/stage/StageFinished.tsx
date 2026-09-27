import { accuracyLine, leaderboard } from "@/lib/game/selectors";
import { Slip } from "../Slip";
import { cx } from "../cx";
import type { StageProps } from "./types";

export function StageFinished({ room }: StageProps) {
  const board = leaderboard(room.players);
  return (
    <div className="grid flex-1 grid-cols-[1.2fr_1fr] gap-[4vw]">
      <section className="flex min-w-0 flex-col gap-[1vw]">
        <h1 className="wide text-[4.5vw] font-black leading-none">Final scores</h1>
        <ol className="flex flex-col gap-[0.6vw]">
          {board.map(({ rank, player }, index) => (
            <li
              key={player.id}
              style={{ animationDelay: `${(board.length - index) * 250}ms` }}
              className={cx(
                "animate-feed flex items-center gap-[1.5vw] rounded-[1vw] px-[1.5vw]",
                rank === 1 ? "bg-slip py-[0.9vw] text-ink" : "bg-field-deep py-[0.5vw]",
              )}
            >
              <span className="wide w-[3vw] shrink-0 text-[2.2vw] font-black tabular-nums">{rank}</span>
              <span className={cx("min-w-0 flex-1 truncate font-bold", rank === 1 ? "text-[3.4vw]" : "text-[2.1vw]")}>
                {player.nickname}
              </span>
              <span className="wide shrink-0 text-[2.2vw] font-black tabular-nums">{player.score}</span>
            </li>
          ))}
        </ol>
      </section>
      <section className="flex flex-col justify-center">
        <Slip header="The reader, scored" size="stage-lg">
          {accuracyLine(room.readerAccuracy)}
        </Slip>
      </section>
    </div>
  );
}
